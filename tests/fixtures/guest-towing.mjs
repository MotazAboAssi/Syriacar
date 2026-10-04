import { randomUUID, randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import * as s from "../../src/server/db/schema.ts";
import { defaultWorkDays } from "../../src/server/db/schema/types.ts";
import { towingHandlers } from "../../src/modules/guest-towing/http.ts";
import { withInspectionFixture } from "./guest-inspection.mjs";
import { withManualSeedIsolation } from "./manual-seed-isolation.mjs";

export const noon = new Date("2026-10-04T09:00:00Z");
export const runtime = { now: () => noon, quotaSecret: "towing-unit-" + randomUUID() };

export async function withTowingFixture(check) {
  // Section B intentionally includes all open providers, even outside the
  // route. Isolate tests rather than filtering rules or touching real data.
  return withManualSeedIsolation(connection => withInspectionFixture(async (f) => {
    const { tx } = f;
    await tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, f.ids.towing));
    const otherBase = randomUUID(), extraDest = randomUUID(), otherBaseRegion = randomUUID();
    await tx.insert(s.governorates).values([
      { id: otherBase, nameAr: "محافظة مقر تحقق", isActive: true },
      { id: extraDest, nameAr: "محافظة بلا تغطية تحقق", isActive: true },
    ]);
    await tx.insert(s.regions).values({ id: otherBaseRegion, governorateId: otherBase, nameAr: "منطقة مقر تحقق", isActive: true });
    const [towType] = await tx.select().from(s.towTypes).limit(1);
    const ids = Object.fromEntries(["originA", "destA", "otherA1", "otherA2", "originOnlyB",
      "destOnlyB", "emptyB", "closed", "closedToday", "pending", "disabled"].map((k) => [k, randomUUID()]));
    let number = randomInt(1_000_000, 8_000_000);
    const phone = () => `+1888${number++}`;
    const configs = {
      originA: {}, destA: { governorateId: f.otherGov, regionId: f.otherRegion },
      otherA1: { governorateId: otherBase, regionId: otherBaseRegion },
      otherA2: { governorateId: otherBase, regionId: otherBaseRegion },
      originOnlyB: {}, destOnlyB: { governorateId: f.otherGov, regionId: f.otherRegion }, emptyB: {},
      closed: { workDays: { ...defaultWorkDays, sun: { enabled: false, start: null, end: null } } },
      closedToday: { todayClosed: true, todayClosedDate: "2026-10-04" },
      pending: { status: "pending" }, disabled: { status: "disabled" },
    };
    await tx.insert(s.providers).values(Object.entries(configs).map(([key, change]) => ({
      id: ids[key], businessName: `verification towing ${key}`, phone: phone(), whatsappNumber: phone(),
      passwordHash: "verification_only_not_a_credential", serviceType: "towing", status: "active",
      governorateId: f.gov, regionId: f.region, towTypeId: towType.id, workDays: defaultWorkDays,
      createdAt: noon, createdBy: f.ops, ...change,
    })));
    const coverages = Object.keys(ids).flatMap((key) => {
      const covered = key === "emptyB" ? [] : key === "originOnlyB" ? [f.gov]
        : key === "destOnlyB" ? [f.otherGov] : [f.gov, f.otherGov];
      return covered.map((governorateId) => ({ id: randomUUID(), providerId: ids[key], governorateId }));
    });
    await tx.insert(s.providerCoverage).values(coverages);
    const input = { originGovernorateId: f.gov, destGovernorateId: f.otherGov, providerId: ids.originA,
      guestName: "ضيف تحقق", guestPhone: "+963900000001", acceptedTerms: true };
    await check({ ...f, ids, otherBase, extraDest, otherBaseRegion, towType, input,
      runtime: { ...runtime, quotaSecret: f.runtime.quotaSecret },
      api: towingHandlers(() => tx, { ...runtime, quotaSecret: f.runtime.quotaSecret }) });
  }, { withoutContactPhone: true, connection }));
}