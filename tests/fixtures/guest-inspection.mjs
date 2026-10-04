import { randomInt, randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { eq } from "drizzle-orm";
import { getDatabase } from "../../src/server/db/client.ts";
import { applicationRowCounts } from "../../src/server/db/catalog.ts";
import * as s from "../../src/server/db/schema.ts";
import { defaultWorkDays } from "../../src/server/db/schema/types.ts";
import { inspectionHandlers } from "../../src/modules/guest-inspection/http.ts";

nextEnv.loadEnvConfig(process.cwd());
const noon = new Date("2026-10-04T09:00:00Z");

export async function inspectionSnapshot() {
  const db = getDatabase();
  return {
    counts: await applicationRowCounts(),
    references: await Promise.all([s.governorates, s.regions, s.brandGroups, s.brands, s.fuelTypes, s.towTypes]
      .map(async (table) => (await db.select().from(table)).sort((a, b) => a.id.localeCompare(b.id)))),
    contact: await db.select().from(s.systemConfig).where(eq(s.systemConfig.key, "contact_phone")),
  };
}

/** Every fixture, API write and simulated stale state rolls back, even on failure. */
export async function withInspectionFixture(check, { withoutContactPhone = false, connection } = {}) {
  const rollback = new Error("ROLLBACK_GUEST_INSPECTION_FIXTURE");
  try {
    await (connection ?? getDatabase()).transaction(async (tx) => {
      const gov = randomUUID(), otherGov = randomUUID();
      const region = randomUUID(), otherRegion = randomUUID(), alternateRegion = randomUUID();
      const emptyRegion = randomUUID();
      const ops = randomUUID();
      let phoneNumber = randomInt(1_000_000, 9_000_000);
      const phone = () => `+1999${phoneNumber++}`;
      await tx.insert(s.governorates).values([
        { id: gov, nameAr: "محافظة تحقق فقط", isActive: true },
        { id: otherGov, nameAr: "محافظة تحقق أخرى", isActive: true },
      ]);
      await tx.insert(s.regions).values([
        { id: region, governorateId: gov, nameAr: "منطقة تحقق فقط", isActive: true },
        { id: alternateRegion, governorateId: gov, nameAr: "منطقة تحقق بديلة", isActive: true },
        { id: emptyRegion, governorateId: gov, nameAr: "منطقة تحقق بلا مزود", isActive: true },
        { id: otherRegion, governorateId: otherGov, nameAr: "منطقة تحقق أخرى", isActive: true },
      ]);
      await tx.insert(s.opsUsers).values({
        id: ops, name: "verification only", username: `verify_${ops}`,
        passwordHash: "verification_only_not_a_credential", role: "operations", createdAt: noon,
      });
      const ids = Object.fromEntries(["active", "capable", "oldClosure", "closedToday", "closedSchedule",
        "pending", "disabled", "towing", "otherRegion", "otherGovernorate"].map((k) => [k, randomUUID()]));
      const configs = {
        active: {}, capable: {},
        oldClosure: { todayClosed: true, todayClosedDate: "2026-10-03" },
        closedToday: { todayClosed: true, todayClosedDate: "2026-10-04" },
        closedSchedule: { workDays: { ...defaultWorkDays, sun: { enabled: false, start: null, end: null } } },
        pending: { status: "pending" }, disabled: { status: "disabled" }, towing: { serviceType: "towing" },
        otherRegion: { regionId: alternateRegion },
        otherGovernorate: { governorateId: otherGov, regionId: otherRegion },
      };
      await tx.insert(s.providers).values(Object.entries(configs).map(([key, change]) => ({
        id: ids[key], businessName: `verification only ${key}`, phone: phone(), whatsappNumber: phone(),
        passwordHash: "verification_only_not_a_credential", serviceType: "inspection", status: "active",
        governorateId: gov, regionId: region, workDays: defaultWorkDays, createdAt: noon, createdBy: ops, ...change,
      })));
      const [group] = await tx.select().from(s.brandGroups).limit(1);
      const [brand] = await tx.select().from(s.brands).where(eq(s.brands.brandGroupId, group.id)).limit(1);
      const [fuel] = await tx.select().from(s.fuelTypes).limit(1);
      await tx.insert(s.providerBrandGroups).values({ providerId: ids.capable, brandGroupId: group.id });
      await tx.insert(s.providerBrands).values({ providerId: ids.capable, brandId: brand.id });
      await tx.insert(s.providerFuelTypes).values({ providerId: ids.capable, fuelTypeId: fuel.id });
      await tx.insert(s.providerYearCategories).values({ providerId: ids.capable, yearCategory: "classic" });
      await tx.insert(s.providerVehicleCategories).values({ providerId: ids.capable, vehicleCategory: "truck" });
      if (withoutContactPhone) await tx.delete(s.systemConfig).where(eq(s.systemConfig.key, "contact_phone"));
      const input = {
        governorateId: gov, regionId: region, providerId: ids.active,
        guestName: "ضيف تحقق", guestPhone: "+963900000001", acceptedTerms: true,
      };
      const runtime = { now: () => noon, quotaSecret: "inspection-fixture-" + randomUUID() };
      const api = inspectionHandlers(() => tx, runtime);
      await check({ tx, gov, region, otherGov, otherRegion, alternateRegion, emptyRegion, ids, input, api, runtime, group, brand, fuel, ops });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}