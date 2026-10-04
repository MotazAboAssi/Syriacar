import "server-only";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDatabase } from "../client.ts";
import * as s from "../schema.ts";
import { checkPassword, hashPassword } from "../../../modules/account/security.ts";
import { manualLocality, manualScenarios, manualTestPassword } from "./manual-scenario-data.ts";
import { assertManualSeedSafety } from "./manual-seed-safety.ts";
type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Manual CLI only. Insert-only: never repair/reset/overwrite an existing row. */
export async function seedManualScenarios(
  options: { confirmDevelopment: boolean }, connection?: Database | Transaction,
) {
  assertManualSeedSafety(options.confirmDevelopment);
  return (connection ?? getDatabase()).transaction(async tx => {
    // Serialize repeat/concurrent manual runs. Unique constraints still fail closed
    // if an ordinary account claims a fixture phone concurrently.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(77012026)`);
    const [gov] = await tx.select().from(s.governorates).where(and(
      eq(s.governorates.id, manualLocality.governorateId), eq(s.governorates.isActive, true))).for("share");
    const [region] = await tx.select().from(s.regions).where(and(
      eq(s.regions.id, manualLocality.regionId), eq(s.regions.governorateId, manualLocality.governorateId),
      eq(s.regions.isActive, true))).for("share");
    const groupIds = [...new Set(manualScenarios.flatMap(x => x.vehicle ? [x.vehicle.brandGroupId] : []))];
    const brandIds = [...new Set(manualScenarios.flatMap(x => x.vehicle ? [x.vehicle.brandId] : []))];
    const fuelIds = [...new Set(manualScenarios.flatMap(x => x.vehicle ? [x.vehicle.fuelTypeId] : []))];
    const groups = await tx.select().from(s.brandGroups).where(and(inArray(s.brandGroups.id, groupIds), eq(s.brandGroups.isActive, true))).for("share");
    const brands = await tx.select().from(s.brands).where(and(inArray(s.brands.id, brandIds), eq(s.brands.isActive, true))).for("share");
    const fuels = await tx.select().from(s.fuelTypes).where(and(inArray(s.fuelTypes.id, fuelIds), eq(s.fuelTypes.isActive, true))).for("share");
    if (!gov || !region || groups.length !== groupIds.length || brands.length !== brandIds.length ||
      fuels.length !== fuelIds.length || brands.some(b => !groupIds.includes(b.brandGroupId))) {
      throw new Error("Required active reference data missing; manual seed will not alter reference data");
    }
    let usersInserted = 0, vehiclesInserted = 0;
    const rows = [];
    const time = new Date();
    // Hash with the SAME Argon2 configuration as ordinary account login.
    const passwordHash = await hashPassword(manualTestPassword);
    for (const scenario of manualScenarios) {
      const existing = await tx.select().from(s.users).where(or(
        eq(s.users.id, scenario.id), eq(s.users.phone, scenario.phone))).for("update");
      if (existing.length && (existing.length !== 1 || existing[0].id !== scenario.id ||
        existing[0].phone !== scenario.phone || existing[0].name !== scenario.name ||
        existing[0].isDeleted || !existing[0].isActive ||
        !await checkPassword(manualTestPassword, existing[0].passwordHash))) {
        throw new Error("Account identity collision or modified fixture; no existing user will be changed");
      }
      if (!existing.length) {
        await tx.insert(s.users).values({
          id: scenario.id, name: scenario.name, phone: scenario.phone, passwordHash,
          homeGovernorateId: scenario.homeGovernorateId, isActive: true, isDeleted: false,
          createdAt: time, lastActiveAt: time,
        });
        usersInserted++;
      }
      let vehicle = null;
      if (scenario.vehicle) {
        const [stored] = await tx.select().from(s.vehicles).where(eq(s.vehicles.id, scenario.vehicle.id)).for("share");
        if (stored && (stored.userId !== scenario.id || stored.notes !== scenario.vehicle.notes)) {
          throw new Error("Vehicle identity collision or modified marker; no existing vehicle will be changed");
        }
        if (!stored) {
          await tx.insert(s.vehicles).values({ ...scenario.vehicle, userId: scenario.id, createdAt: time });
          vehiclesInserted++;
        }
        vehicle = stored ?? { ...scenario.vehicle, userId: scenario.id, createdAt: time };
        if (scenario.key === "no-match") {
          // Conservative check: all active capable providers, even if closed NOW.
          // Never disable or alter real providers to manufacture the scenario.
          const matches = await tx.execute(sql`
            SELECT p.id FROM providers p
            WHERE p.status = 'active' AND p.service_type = 'inspection'
            AND p.governorate_id = ${gov.id} AND p.region_id = ${region.id}
            AND EXISTS (SELECT 1 FROM provider_brand_groups c WHERE c.provider_id=p.id AND c.brand_group_id=${vehicle.brandGroupId})
            AND EXISTS (SELECT 1 FROM provider_brands c WHERE c.provider_id=p.id AND c.brand_id=${vehicle.brandId})
            AND EXISTS (SELECT 1 FROM provider_year_categories c WHERE c.provider_id=p.id AND c.year_category=${vehicle.yearCategory})
            AND EXISTS (SELECT 1 FROM provider_fuel_types c WHERE c.provider_id=p.id AND c.fuel_type_id=${vehicle.fuelTypeId})
            AND EXISTS (SELECT 1 FROM provider_vehicle_categories c WHERE c.provider_id=p.id AND c.vehicle_category=${vehicle.vehicleCategory})
            FOR SHARE OF p`);
          if (matches.rows.length) throw new Error("No-match scenario has a capable provider; seed aborted without altering providers");
        }
      }
      rows.push({ scenario: scenario.key, name: scenario.name, phone: scenario.phone,
        homeGovernorate: existing[0]?.homeGovernorateId === gov.id || (!existing.length && scenario.homeGovernorateId === gov.id) ? gov.nameAr : null,
        vehicle: vehicle ? { brand: brands.find(b => b.id === vehicle.brandId)?.nameAr,
          year: vehicle.year, category: vehicle.vehicleCategory,
          fuel: fuels.find(f => f.id === vehicle.fuelTypeId)?.nameAr,
          verificationStatus: vehicle.verificationStatus } : null });
    }
    return {
      users: { inserted: usersInserted, preserved: manualScenarios.length - usersInserted },
      vehicles: { inserted: vehiclesInserted, preserved: 4 - vehiclesInserted },
      inspectionNoMatchLocality: { governorate: gov.nameAr, region: region.nameAr },
      accounts: rows,
    };
  });
}