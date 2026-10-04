import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as s from "../src/server/db/schema.ts";
import { closeDatabase } from "../src/server/db/client.ts";
import { sessionCookie } from "../src/modules/account/security.ts";
import { registeredHandlers } from "../src/modules/registered-services/http.ts";
import { coordinates, gpsLocationLink } from "../src/modules/registered-services/contracts.ts";
import { withRegisteredFixture as fixture, req, parsed } from "./fixtures/registered-services.mjs";
import { accountSnapshot } from "./fixtures/account.mjs";

after(closeDatabase);
const snapshot = await accountSnapshot();
const listing = f => parsed(f.api.providers(req("/api/inspection/providers?" +
  new URLSearchParams({ vehicleId: f.va, governorateId: f.gov, regionId: f.region }), "GET", undefined, f.cookieA)));
const counts = async f => ({
  requests: (await f.tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.userId, f.a))).length,
  notices: (await f.tx.select().from(s.notifications).where(eq(s.notifications.userId, f.a))).length,
});
const run = (name, check) => test(name, () => fixture(check));

test("coordinate bounds and GPS links are client-only, finite and use whatsapp URL, not phone", () => {
  for (const pair of [[null, 3], [3, null], ["", 0], ["no", 3], [Infinity, 3], [91, 0], [0, -181], [true, 0]]) {
    assert.equal(coordinates(...pair), null);
    assert.equal(gpsLocationLink("https://wa.me/963900000001?text=x", "أ", ...pair), null);
  }
  assert.deepEqual(coordinates("33.5", "36.2"), { lat: 33.5, lng: 36.2 });
  assert.deepEqual(coordinates(0, 0), { lat: 0, lng: 0 });
  const url = new URL(gpsLocationLink("https://wa.me/963900000009?text=x", "مالك", 33.5, 36.2));
  assert.equal(url.pathname, "/963900000009");
  assert.equal(url.searchParams.get("text"), "Syriacar — مالك — سطحة — موقعي: https://maps.google.com/?q=33.5,36.2");
  assert.equal(gpsLocationLink("https://example.com/963900000009", "أ", 1, 1), null);
});

run("lookup matches all five IDs, exposes safe display only, no service writes and allows pending", async f => {
  const result = await listing(f);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.providers.filter(p => p.suitable).map(p => p.id), [f.capable.id]);
  assert.equal(result.data.providers.some(p => p.id === f.closed.id), false);
  assert.equal(result.data.providers.find(p => p.id === f.capable.id).coordinates, null);
  for (const p of result.data.providers) {
    for (const key of ["passwordHash", "whatsappNumber", "locationUrl", "verificationStatus"]) assert.equal(Object.hasOwn(p, key), false);
  }
  assert.deepEqual(await counts(f), { requests: 0, notices: 0 });
  assert.match(result.headers.get("set-cookie"), /HttpOnly; Secure/);
  assert.equal(result.headers.get("cache-control"), "no-store");
});

for (const [table, column] of [
  [s.providerBrandGroups, "brandGroupId"], [s.providerBrands, "brandId"],
  [s.providerYearCategories, "yearCategory"], [s.providerFuelTypes, "fuelTypeId"],
  [s.providerVehicleCategories, "vehicleCategory"],
]) run(`AND matching: missing ${column} is not a wildcard; specialization cannot override`, async f => {
  await f.tx.delete(table).where(eq(table.providerId, f.capable.id));
  await f.tx.update(s.providers).set({ specializations: ["جميع المركبات"] }).where(eq(s.providers.id, f.capable.id));
  assert.equal((await listing(f)).data.providers.some(p => p.suitable), false);
  assert.equal((await f.inspect()).status, 409);
  assert.deepEqual(await counts(f), { requests: 0, notices: 0 });
});

run("DB year category is authoritative rather than derived client/year at matching", async f => {
  await f.tx.update(s.vehicles).set({ yearCategory: "modern" }).where(eq(s.vehicles.id, f.va));
  assert.equal((await listing(f)).data.providers.some(p => p.suitable), false);
});

run("provider valid/null/invalid coordinates never affect matching and no guessed point", async f => {
  for (const point of [{ locationLat: "33.5", locationLng: "36.2" },
    { locationLat: null, locationLng: null }, { locationLat: "95", locationLng: "36" },
    { locationLat: "33", locationLng: null }]) {
    await f.tx.update(s.providers).set(point).where(eq(s.providers.id, f.capable.id));
    const p = (await listing(f)).data.providers.find(p => p.id === f.capable.id);
    assert.equal(p.suitable, true);
    assert.deepEqual(p.coordinates, coordinates(point.locationLat, point.locationLng));
  }
  assert.equal((await f.inspect()).status, 201);
});

run("matched inspection stores exact registered fields and correct FR-INS-013 whatsapp destination", async f => {
  await f.tx.update(s.vehicles).set({ verificationStatus: "verified" }).where(eq(s.vehicles.id, f.va));
  const result = await f.inspect(); assert.equal(result.status, 201);
  assert.equal(result.data.matchingStatus, "matched");
  const [parent] = await f.tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, result.data.requestId));
  const [notice] = await f.tx.select().from(s.notifications).where(eq(s.notifications.id, result.data.notificationId));
  for (const row of [parent, notice]) {
    assert.equal(row.userType, "registered"); assert.equal(row.userId, f.a);
    assert.equal(row.guestName, null); assert.equal(row.guestPhone, null); assert.equal(row.vehicleId, f.va);
    assert.equal(row.originGovernorateId, null); assert.equal(row.destGovernorateId, null);
  }
  assert.equal(parent.inspectionGovernorateId, f.gov); assert.equal(parent.inspectionRegionId, f.region);
  assert.equal(notice.followupStatus, "pending");
  const link = new URL(result.data.whatsappUrl);
  assert.equal(link.pathname, "/" + f.capable.whatsappNumber.slice(1));
  assert.notEqual(f.capable.whatsappNumber, f.capable.phone);
  assert.equal(link.searchParams.get("text"), `أنا مستخدمك من «Syriacar»، اسمي مالك تحقق أ، وأريد فحصاً لسيارة ${f.brand.nameAr} - 1990.`);
  assert.equal(result.data.provider.phone, f.capable.phone);
});

run("inspection no-match is explicit parent only and rejects no-match when suitable now exists", async f => {
  assert.equal((await f.inspect({ ...f.inspection, providerId: null })).status, 409);
  assert.deepEqual(await counts(f), { requests: 0, notices: 0 });
  const r = await f.inspect({ ...f.inspection, regionId: f.emptyRegion, providerId: null });
  assert.equal(r.status, 201); assert.equal(r.data.matchingStatus, "no_match");
  assert.equal(r.data.notificationId, null); assert.equal(r.data.provider, null); assert.equal(r.data.whatsappUrl, null);
  assert.equal(r.data.contactPhone, null);
  assert.deepEqual(await counts(f), { requests: 1, notices: 0 });
});

run("inspection additional notifications share one parent, no global restriction", async f => {
  const first = await f.inspect(); const second = await f.inspect({ ...f.inspection, requestId: first.data.requestId });
  assert.equal(second.status, 201); assert.equal(first.data.requestId, second.data.requestId);
  assert.notEqual(first.data.notificationId, second.data.notificationId);
  assert.equal((await f.inspect()).status, 201); // a new context confirmation is not globally blocked
  assert.deepEqual(await counts(f), { requests: 2, notices: 3 });
});

run("User A cannot look up or confirm B vehicle; rejected vehicle refused and no partial rows", async f => {
  const q = new URLSearchParams({ vehicleId: f.vb, governorateId: f.gov, regionId: f.region });
  assert.equal((await parsed(f.api.providers(req("/api/inspection/providers?" + q, "GET", undefined, f.cookieA)))).status, 404);
  assert.equal((await f.inspect({ ...f.inspection, vehicleId: f.vb })).status, 404);
  await f.tx.update(s.vehicles).set({ verificationStatus: "rejected" }).where(eq(s.vehicles.id, f.va));
  assert.equal((await listing(f)).status, 422); assert.equal((await f.inspect()).status, 422);
  assert.deepEqual(await counts(f), { requests: 0, notices: 0 });
});

for (const [label, change] of [
  ["provider disabled", async f => f.tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, f.capable.id))],
  ["provider moved", async f => f.tx.update(s.providers).set({ regionId: f.alternateRegion }).where(eq(s.providers.id, f.capable.id))],
  ["provider closed", async f => f.tx.update(s.providers).set({ todayClosed: true, todayClosedDate: "2026-10-04" }).where(eq(s.providers.id, f.capable.id))],
  ["region inactive", async f => f.tx.update(s.regions).set({ isActive: false }).where(eq(s.regions.id, f.region))],
  ["vehicle rejected", async f => f.tx.update(s.vehicles).set({ verificationStatus: "rejected" }).where(eq(s.vehicles.id, f.va))],
]) run(`confirmation rechecks stale state: ${label}`, async f => {
  assert.equal((await listing(f)).status, 200); await change(f);
  assert.ok([409, 422].includes((await f.inspect()).status));
  assert.deepEqual(await counts(f), { requests: 0, notices: 0 });
});

run("both continuation endpoints reject B and Guest parents or mismatched context with no new writes", async f => {
  const iB = await f.inspect({ ...f.inspection, vehicleId: f.vb }, f.cookieB);
  const tB = await f.tow(f.towing, f.cookieB);
  const iA = await f.inspect(), tA = await f.tow();
  const before = await counts(f);
  for (const input of [{ ...f.inspection, requestId: iB.data.requestId },
    { ...f.inspection, requestId: tA.data.requestId }, { ...f.inspection, requestId: randomUUID() },
    { ...f.inspection, requestId: iA.data.requestId, regionId: f.alternateRegion }]) {
    assert.ok([403, 409].includes((await f.inspect(input)).status));
  }
  for (const input of [{ ...f.towing, requestId: tB.data.requestId },
    { ...f.towing, requestId: iA.data.requestId },
    { ...f.towing, requestId: tA.data.requestId, destGovernorateId: f.gov }]) {
    assert.ok([403, 409].includes((await f.tow(input)).status));
  }
  const guest = await parsed(f.towingApi.create(req("/api/guest-towing/requests", "POST", f.input)));
  assert.equal(guest.status, 201);
  assert.equal((await f.tow({ ...f.towing, requestId: guest.data.requestId })).status, 403);
  assert.deepEqual(await counts(f), before);
});

run("unknown/forged identity/capabilities/GPS and consent are rejected on registered write", async f => {
  for (const extra of [{ userId: f.b }, { user_type: "guest" }, { guestName: "ضيف" },
    { guestPhone: "+963900000001" }, { matchingStatus: "matched" }, { brandId: f.brand.id },
    { lat: 33, lng: 36 }, { requestProof: "forged" }, { acceptedTerms: false }]) {
    assert.equal((await f.inspect({ ...f.inspection, ...extra })).status, 422);
    assert.equal((await f.tow({ ...f.towing, ...extra })).status, 422);
  }
  assert.equal((await f.tow({ ...f.towing, vehicleId: f.va })).status, 422);
  assert.deepEqual(await counts(f), { requests: 0, notices: 0 });
});

run("towing B→A→B promotion shares parent without downgrade; registered route exact and no vehicle", async f => {
  const first = await f.tow({ ...f.towing, providerId: f.ids.originOnlyB });
  assert.equal(first.data.matchingStatus, "no_match");
  const second = await f.tow({ ...f.towing, requestId: first.data.requestId });
  assert.equal(second.data.matchingStatus, "matched");
  const third = await f.tow({ ...f.towing, providerId: f.ids.emptyB, requestId: first.data.requestId });
  assert.equal(third.data.matchingStatus, "matched"); assert.equal(third.data.requestId, first.data.requestId);
  const [parent] = await f.tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, first.data.requestId));
  const notices = await f.tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, parent.id));
  for (const row of [parent, ...notices]) {
    assert.equal(row.vehicleId, null); assert.equal(row.userId, f.a); assert.equal(row.userType, "registered");
    assert.equal(row.guestName, null); assert.equal(row.guestPhone, null);
    assert.equal(row.originGovernorateId, f.gov); assert.equal(row.destGovernorateId, f.otherGov);
  }
  assert.equal(parent.inspectionGovernorateId, null); assert.equal(parent.inspectionRegionId, null);
  assert.equal(new URL(second.data.whatsappUrl).searchParams.get("text"), "أنا مستخدمك من «Syriacar»، اسمي مالك تحقق أ، وأريد سطحة.");
  assert.deepEqual(await counts(f), { requests: 1, notices: 3 });
});

run("same-governorate towing works; stale coverage recalculated and provider unavailable refused", async f => {
  const same = await f.tow({ ...f.towing, destGovernorateId: f.gov, providerId: f.ids.originOnlyB });
  assert.equal(same.data.matchingStatus, "matched");
  await f.tx.delete(s.providerCoverage).where(and(eq(s.providerCoverage.providerId, f.ids.originA),
    eq(s.providerCoverage.governorateId, f.otherGov)));
  assert.equal((await f.tow()).data.matchingStatus, "no_match");
  const before = await counts(f);
  await f.tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, f.ids.originA));
  assert.equal((await f.tow()).status, 409);
  await f.tx.update(s.governorates).set({ isActive: false }).where(eq(s.governorates.id, f.otherGov));
  assert.equal((await f.tow({ ...f.towing, providerId: f.ids.destA })).status, 422);
  assert.deepEqual(await counts(f), before);
});

run("location validates owner, notification relationship, locality and never writes or changes route", async f => {
  const a1 = await f.tow(), a2 = await f.tow(), b = await f.tow(f.towing, f.cookieB);
  const input = { requestId: a1.data.requestId, notificationId: a1.data.notificationId, governorateId: f.gov, regionId: f.region };
  const call = (data, cookie = f.cookieA) => parsed(f.api.location(req("/api/towing/location", "POST", data, cookie)));
  const before = await counts(f);
  const good = await call(input); assert.equal(good.status, 200);
  assert.match(new URL(good.data.whatsappUrl).searchParams.get("text"), /^Syriacar — مالك تحقق أ — سطحة — موقعي: محافظة /);
  assert.equal(new URL(good.data.whatsappUrl).pathname, new URL(a1.data.whatsappUrl).pathname);
  for (const data of [{ ...input, requestId: b.data.requestId }, { ...input, notificationId: b.data.notificationId },
    { ...input, notificationId: a2.data.notificationId }, { ...input, requestId: randomUUID() }]) {
    assert.equal((await call(data)).status, 403);
  }
  assert.equal((await call({ ...input, regionId: f.otherRegion })).status, 422);
  assert.equal((await call({ ...input, lat: 33, lng: 36 })).status, 422);
  assert.equal((await call(input, f.cookieB)).status, 403);
  assert.deepEqual(await counts(f), before);
  const [p] = await f.tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, input.requestId));
  assert.equal(p.originGovernorateId, f.gov); assert.equal(p.destGovernorateId, f.otherGov);
});

run("all protected endpoints refuse missing/tampered/expired/disabled/deleted/nonexistent sessions", async f => {
  const expired = (await sessionCookie(f.a, { ...f.runtime, now: () => new Date("2026-01-01") })).split(";")[0];
  const absent = (await sessionCookie(randomUUID(), f.runtime)).split(";")[0];
  const loc = { requestId: randomUUID(), notificationId: randomUUID(), governorateId: f.gov, regionId: f.region };
  const check = async cookie => {
    assert.equal((await f.inspect(f.inspection, cookie)).status, 401);
    assert.equal((await f.tow(f.towing, cookie)).status, 401);
    assert.equal((await parsed(f.api.location(req("/api/towing/location", "POST", loc, cookie)))).status, 401);
    const query = new URLSearchParams({ vehicleId: f.va, governorateId: f.gov, regionId: f.region });
    assert.equal((await parsed(f.api.providers(req("/api/inspection/providers?" + query, "GET", undefined, cookie)))).status, 401);
  };
  for (const cookie of ["", "syriacar_user=forged", expired, absent]) await check(cookie);
  await f.tx.update(s.users).set({ isActive: false }).where(eq(s.users.id, f.a)); await check(f.cookieA);
  await f.tx.update(s.users).set({ isDeleted: true, name: null, phone: null }).where(eq(s.users.id, f.a)); await check(f.cookieA);
  assert.deepEqual(await counts(f), { requests: 0, notices: 0 });
});

run("Origin, content-type, oversized JSON protection match Build6 and do not write", async f => {
  for (const extra of [{ Origin: "https://attacker.example" }, { Origin: "" }, { Origin: "null" }]) {
    assert.equal((await parsed(f.api.inspection(req("/api/inspection/requests", "POST", f.inspection, f.cookieA, extra)))).status, 403);
  }
  assert.equal((await parsed(f.api.inspection(req("/api/inspection/requests", "POST", f.inspection, f.cookieA,
    { "Content-Type": "text/plain" })))).status, 422);
  assert.equal((await f.inspect({ ...f.inspection, ignored: "x".repeat(9000) })).status, 413);
  assert.deepEqual(await counts(f), { requests: 0, notices: 0 });
});

run("notification insert failure rolls back parent in both services", async f => {
  const existing = await f.tow({ ...f.towing, providerId: f.ids.originOnlyB });
  await f.tx.execute(`create function pg_temp.reject_registered_notice() returns trigger language plpgsql as $$
    begin if NEW.user_id = '${f.a}'::uuid then raise exception 'fixture notification failure'; end if; return NEW; end $$`);
  await f.tx.execute(`create trigger registered_fixture_reject before insert on notifications
    for each row execute function pg_temp.reject_registered_notice()`);
  assert.equal((await f.inspect()).status, 500); assert.equal((await f.tow()).status, 500);
  assert.equal((await f.tow({ ...f.towing, requestId: existing.data.requestId })).status, 500);
  const [parent] = await f.tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, existing.data.requestId));
  assert.equal(parent.matchingStatus, "no_match");
  assert.deepEqual(await counts(f), { requests: 1, notices: 1 });
});

run("inspection continuation refuses changing owned vehicle and rejects Guest inspection parent", async f => {
  const first = await f.inspect();
  const another = randomUUID();
  const [v] = await f.tx.select().from(s.vehicles).where(eq(s.vehicles.id, f.va));
  await f.tx.insert(s.vehicles).values({ ...v, id: another });
  assert.equal((await f.inspect({ ...f.inspection, vehicleId: another, requestId: first.data.requestId })).status, 409);
  const guest = await parsed(f.inspectionApi.create(req("/api/guest-inspection/requests", "POST", {
    governorateId: f.gov, regionId: f.region, providerId: f.active.id,
    guestName: "ضيف تحقق", guestPhone: "+963900000001", acceptedTerms: true,
  })));
  assert.equal(guest.status, 201);
  assert.equal((await f.inspect({ ...f.inspection, requestId: guest.data.requestId })).status, 403);
  assert.deepEqual(await counts(f), { requests: 1, notices: 1 });
});

run("configured team phone is read on no-match without fallback number and invalid config aborts", async f => {
  await f.tx.insert(s.systemConfig).values({ key: "contact_phone", value: "+963900000090", updatedBy: f.ops,
    updatedAt: f.runtime.now() });
  const input = { ...f.inspection, regionId: f.emptyRegion, providerId: null };
  assert.equal((await f.inspect(input)).data.contactPhone, "+963900000090");
  await f.tx.update(s.systemConfig).set({ value: "invalid" }).where(eq(s.systemConfig.key, "contact_phone"));
  assert.equal((await f.inspect(input)).status, 503);
  assert.equal((await f.tow()).status, 503);
  assert.deepEqual(await counts(f), { requests: 1, notices: 0 });
});

run("matched history is retained after notified provider loses coverage and later B notification", async f => {
  const first = await f.tow();
  await f.tx.delete(s.providerCoverage).where(eq(s.providerCoverage.providerId, f.ids.originA));
  const later = await f.tow({ ...f.towing, providerId: f.ids.emptyB, requestId: first.data.requestId });
  assert.equal(later.data.matchingStatus, "matched");
  const [parent] = await f.tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, first.data.requestId));
  assert.equal(parent.matchingStatus, "matched");
});

run("registered API runtime clock enforces Damascus opening and boundaries", async f => {
  for (const time of ["2026-10-04T04:59:59Z", "2026-10-04T17:00:01Z", "2026-10-09T09:00:00Z"]) {
    const api = registeredHandlers(() => f.tx, { ...f.runtime, now: () => new Date(time) });
    const response = await parsed(api.providers(req("/api/inspection/providers?" +
      new URLSearchParams({ vehicleId: f.va, governorateId: f.gov, regionId: f.region }), "GET", undefined, f.cookieA)));
    assert.equal(response.status, 200); assert.equal(response.data.providers.length, 0);
  }
});

test("Build7 isolated tests preserve genuine users/vehicles/requests/notifications baseline", async () => {
  assert.deepEqual(await accountSnapshot(), snapshot);
});