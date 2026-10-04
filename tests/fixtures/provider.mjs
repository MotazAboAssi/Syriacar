import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { withRateScratch } from "./rate-limit-scratch.mjs";
import { assertManualSeedSafety } from "../../src/server/db/seed/manual-seed-safety.ts";
import { providerHandlers } from "../../src/modules/provider-management/http.ts";
import { providerSessionCookie } from "../../src/modules/provider-management/security.ts";
import { hashPassword } from "../../src/modules/account/security.ts";
import * as s from "../../src/server/db/schema.ts";

export const password = "provider-test-only-password";
export const origin = "https://provider-verification.example";
export function req(path, method = "GET", body, cookie, extra = {}) {
  return new Request(origin + "/api/provider" + path, { method,
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export async function parsed(response) {
  const result = await response;
  return { status: result.status, data: await result.json(), headers: result.headers };
}
// Existing approved-target guard executes before any scratch DDL or account setup.
// Run with NODE_ENV=test; no production test bypass or account/bootstrap route ships.
export async function withProviderFixture(check) {
  assertManualSeedSafety(true);
  return withRateScratch(async ({ db, pool, name }) => {
    let clock = new Date("2026-10-04T09:00:00Z");
    const runtime = { now: () => clock, secret: "provider-fixture-signing-secret-only" };
    const [gov] = await db.select().from(s.governorates);
    const [region] = await db.select().from(s.regions).where(eq(s.regions.governorateId, gov.id));
    const [otherGov] = (await db.select().from(s.governorates)).filter(row => row.id !== gov.id);
    const [brand] = await db.select().from(s.brands);
    const [fuel] = await db.select().from(s.fuelTypes);
    const [tow] = await db.select().from(s.towTypes);
    const owner = randomUUID(), a = randomUUID(), b = randomUUID(), pending = randomUUID(), disabled = randomUUID();
    await db.insert(s.opsUsers).values({ id: owner, name: "مالك اختبار فقط", username: "provider-test-owner",
      passwordHash: "test-only-no-login", role: "operations", createdAt: clock });
    const hash = await hashPassword(password);
    const numbers = { a: "+963911111111", b: "+963922222222", pending: "+963933333333", disabled: "+963944444444" };
    await db.insert(s.providers).values([
      [a, "active", numbers.a, "مركز اختبار أ"], [b, "active", numbers.b, "مركز اختبار ب"],
      [pending, "pending", numbers.pending, "مركز قيد المراجعة"], [disabled, "disabled", numbers.disabled, "مركز معطل"],
    ].map(([id, status, phone, businessName], index) => ({
      id, status, phone, businessName, passwordHash: hash, whatsappNumber: "+96395555555" + index,
      serviceType: id === b ? "towing" : "inspection", governorateId: gov.id, regionId: region.id,
      towTypeId: id === b ? tow.id : null, locationUrl: "https://location-private.invalid",
      createdAt: clock, createdBy: owner,
    })));
    await db.insert(s.providerCoverage).values({ id: randomUUID(), providerId: b, governorateId: otherGov.id });
    const user = randomUUID(), deletedUser = randomUUID(), vehicle = randomUUID();
    await db.insert(s.users).values([
      { id: user, name: "عميل مسجل", phone: numbers.a, passwordHash: hash, isActive: true, createdAt: clock, lastActiveAt: clock },
      { id: deletedUser, name: null, phone: null, passwordHash: "test-only-no-login",
        isDeleted: true, isActive: false, createdAt: clock, lastActiveAt: clock },
    ]);
    await db.insert(s.vehicles).values({ id: vehicle, userId: user, brandGroupId: brand.brandGroupId, brandId: brand.id,
      year: 2005, yearCategory: "mid", fuelTypeId: fuel.id, vehicleCategory: "car", createdAt: clock });
    const guestRequest = randomUUID(), registeredRequest = randomUUID(), deletedRequest = randomUUID(), otherRequest = randomUUID();
    await db.insert(s.serviceRequests).values([
      { id: guestRequest, serviceType: "inspection", userType: "guest", guestName: "عميل زائر", guestPhone: "+963966666666",
        inspectionGovernorateId: gov.id, inspectionRegionId: region.id, matchingStatus: "matched", createdAt: clock },
      { id: registeredRequest, serviceType: "inspection", userType: "registered", userId: user, vehicleId: vehicle,
        inspectionGovernorateId: gov.id, inspectionRegionId: region.id, matchingStatus: "matched", createdAt: clock },
      { id: deletedRequest, serviceType: "inspection", userType: "registered", userId: deletedUser, vehicleId: vehicle,
        inspectionGovernorateId: gov.id, inspectionRegionId: region.id, matchingStatus: "matched", createdAt: clock },
      { id: otherRequest, serviceType: "towing", userType: "guest", guestName: "عميل مزود ب", guestPhone: "+963977777777",
        originGovernorateId: gov.id, destGovernorateId: otherGov.id, matchingStatus: "matched", createdAt: clock },
    ]);
    const guestNotice = randomUUID(), registeredNotice = randomUUID(), deletedNotice = randomUUID(), otherNotice = randomUUID();
    await db.insert(s.notifications).values([
      { id: guestNotice, providerId: a, serviceRequestId: guestRequest, serviceType: "inspection", userType: "guest",
        guestName: "عميل زائر", guestPhone: "+963966666666", createdAt: clock },
      { id: registeredNotice, providerId: a, serviceRequestId: registeredRequest, serviceType: "inspection",
        userType: "registered", userId: user, vehicleId: vehicle, createdAt: clock },
      { id: deletedNotice, providerId: a, serviceRequestId: deletedRequest, serviceType: "inspection",
        userType: "registered", userId: deletedUser, vehicleId: vehicle, createdAt: clock },
      { id: otherNotice, providerId: b, serviceRequestId: otherRequest, serviceType: "towing", userType: "guest",
        guestName: "عميل مزود ب", guestPhone: "+963977777777", createdAt: clock },
    ]);
    const cookieA = (await providerSessionCookie(a, runtime)).split(";")[0];
    const cookieB = (await providerSessionCookie(b, runtime)).split(";")[0];
    const api = providerHandlers(() => db, runtime);
    const logIn = (phone = numbers.a, pass = password) => parsed(api.login(req("/login", "POST", { phone, password: pass })));
    await check({ db, pool, schemaName: name, runtime, now: () => clock, advance: ms => { clock = new Date(+clock + ms); },
      a, b, pending, disabled, user, deletedUser, guestRequest, registeredRequest, otherRequest,
      guestNotice, registeredNotice, deletedNotice, otherNotice, numbers, cookieA, cookieB,
      gov, region, otherGov, api, logIn, hash,
      addNotices: async count => {
        const rows = Array.from({ length: count }, (_, index) => ({
          id: randomUUID(), providerId: a, serviceRequestId: guestRequest, serviceType: "inspection", userType: "guest",
          guestName: "إشعار اختبار " + index, guestPhone: "+963966666666", createdAt: clock,
        }));
        if (rows.length) await db.insert(s.notifications).values(rows);
        return rows;
      },
      ageLoginBucket: async identity => {
        const { rateLimitHash } = await import("../../src/modules/account/security.ts");
        await db.execute(sql`UPDATE security_rate_limits SET window_expires_at=NOW()-INTERVAL '1 second',
          blocked_until=NOW()-INTERVAL '1 second'
          WHERE scope='account.login.failures.phone' AND key_hash=${rateLimitHash("account.login.failures.phone", identity, runtime)}`);
      },
    });
  });
}