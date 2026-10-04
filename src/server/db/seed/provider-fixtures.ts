import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { getDatabase } from "../client.ts";
import * as s from "../schema.ts";
import { hashPassword } from "../../../modules/account/security.ts";
import { assertManualSeedSafety } from "./manual-seed-safety.ts";
import { manualLocality, manualScenarios } from "./manual-scenario-data.ts";
import { providerFixtures, providerFixtureOwner, providerFixtureRoutes, providerFixtureVehicle } from "./provider-fixture-data.ts";
import { lockProviderFixtures, assertProviderFixtureIdentity, assertProviderOwnerIdentity } from "./provider-fixture-ownership.ts";

type Database = ReturnType<typeof getDatabase>;
export type ProviderFixtureConnection = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Explicit dev CLI only. Never called by startup, publish, API or account seed. */
export async function seedProviderFixtures(options: { confirmDevelopment: boolean }, connection?: ProviderFixtureConnection) {
  assertManualSeedSafety(options.confirmDevelopment);
  return (connection ?? getDatabase()).transaction(async tx => {
    await lockProviderFixtures(tx);
    const govIds = [providerFixtureRoutes.originGovernorateId, providerFixtureRoutes.destGovernorateId,
      providerFixtureRoutes.bOnlyDestinationId];
    const govs = await tx.select().from(s.governorates).where(and(
      inArray(s.governorates.id, govIds), eq(s.governorates.isActive, true))).for("share");
    const regionIds = [...new Set(providerFixtures.map(f => f.provider.regionId))];
    const regions = await tx.select().from(s.regions).where(and(
      inArray(s.regions.id, regionIds), eq(s.regions.isActive, true))).for("share");
    const [group] = await tx.select().from(s.brandGroups).where(and(
      eq(s.brandGroups.id, providerFixtureVehicle.brandGroupId), eq(s.brandGroups.isActive, true))).for("share");
    const [brand] = await tx.select().from(s.brands).where(and(
      eq(s.brands.id, providerFixtureVehicle.brandId), eq(s.brands.brandGroupId, providerFixtureVehicle.brandGroupId),
      eq(s.brands.isActive, true))).for("share");
    const fuelIds = [...new Set(providerFixtures.flatMap(f => f.capabilities ? [f.capabilities.fuelTypeId] : []))];
    const fuels = await tx.select().from(s.fuelTypes).where(and(
      inArray(s.fuelTypes.id, fuelIds), eq(s.fuelTypes.isActive, true))).for("share");
    const towIds = [...new Set(providerFixtures.flatMap(f => f.provider.towTypeId ? [f.provider.towTypeId] : []))];
    const tows = await tx.select().from(s.towTypes).where(and(
      inArray(s.towTypes.id, towIds), eq(s.towTypes.isActive, true))).for("share");
    if (govs.length !== govIds.length || regions.length !== regionIds.length || !group || !brand ||
      fuels.length !== fuelIds.length || tows.length !== towIds.length ||
      providerFixtures.some(f => !regions.some(r => r.id === f.provider.regionId && r.governorateId === f.provider.governorateId))) {
      throw new Error("Provider fixtures require existing active references; none will be created or repaired");
    }
    const vehicles = await tx.select({ vehicle: s.vehicles }).from(s.vehicles)
      .innerJoin(s.users, eq(s.vehicles.userId, s.users.id)).where(and(
        inArray(s.vehicles.id, manualScenarios.filter(x => ["verified", "pending"].includes(x.key)).map(x => x.vehicle!.id)),
        eq(s.users.isActive, true), eq(s.users.isDeleted, false),
        eq(s.vehicles.brandGroupId, providerFixtureVehicle.brandGroupId), eq(s.vehicles.brandId, providerFixtureVehicle.brandId),
        eq(s.vehicles.yearCategory, providerFixtureVehicle.yearCategory), eq(s.vehicles.fuelTypeId, providerFixtureVehicle.fuelTypeId),
        eq(s.vehicles.vehicleCategory, providerFixtureVehicle.vehicleCategory),
        or(eq(s.vehicles.verificationStatus, "verified"), eq(s.vehicles.verificationStatus, "pending_verification")),
      )).for("share");
    if (!vehicles.length) throw new Error("Compatible existing manual test vehicle required; accounts/vehicles will not be modified");
    const owners = await tx.select().from(s.opsUsers).where(or(eq(s.opsUsers.id, providerFixtureOwner.id),
      eq(s.opsUsers.username, providerFixtureOwner.username))).for("update");
    if (owners.length) assertProviderOwnerIdentity(owners);
    else await tx.insert(s.opsUsers).values({ ...providerFixtureOwner,
      passwordHash: await hashPassword(randomBytes(32).toString("hex")), createdAt: new Date() });
    let inserted = 0, coverageInserted = 0, capabilitiesInserted = 0;
    const time = new Date();
    // Unknowable, discarded login passwords; no provider dashboard or usable Ops login.
    const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
    for (const fixture of providerFixtures) {
      const p = fixture.provider;
      const existing = await tx.select().from(s.providers).where(or(eq(s.providers.id, p.id),
        eq(s.providers.phone, p.phone), eq(s.providers.whatsappNumber, p.whatsappNumber))).for("update");
      if (existing.length) {
        assertProviderFixtureIdentity(existing, fixture);
        // Preserve the entire existing graph, including edits/removals of child rows.
        // Only missing providers are inserted. Never backfill/reset existing graphs.
        continue;
      }
      await tx.insert(s.providers).values({ ...p, passwordHash, createdAt: time });
      await tx.insert(s.providerCoverage).values(fixture.coverage);
      coverageInserted += fixture.coverage.length;
      if (fixture.capabilities) {
        const c = fixture.capabilities, providerId = p.id;
        await tx.insert(s.providerBrandGroups).values({ providerId, brandGroupId: c.brandGroupId });
        await tx.insert(s.providerBrands).values({ providerId, brandId: c.brandId });
        await tx.insert(s.providerYearCategories).values({ providerId, yearCategory: c.yearCategory });
        await tx.insert(s.providerFuelTypes).values({ providerId, fuelTypeId: c.fuelTypeId });
        await tx.insert(s.providerVehicleCategories).values({ providerId, vehicleCategory: c.vehicleCategory });
        capabilitiesInserted += 5;
      }
      inserted++;
    }
    return {
      providers: { inserted, preserved: providerFixtures.length - inserted },
      creator: { inserted: owners.length ? 0 : 1, preserved: owners.length ? 1 : 0, active: false },
      coverageInserted, capabilitiesInserted,
      inspectionLocality: manualLocality, towingRoute: providerFixtureRoutes,
      fixtures: providerFixtures.map(f => ({ key: f.key, id: f.provider.id, name: f.provider.businessName,
        phone: f.provider.phone, whatsappNumber: f.provider.whatsappNumber })),
      existingGraphsNotReset: true,
    };
  });
}