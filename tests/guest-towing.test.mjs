import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDatabase, closeDatabase } from "../src/server/db/client.ts";
import * as s from "../src/server/db/schema.ts";
import { parseTowing, parseRoute } from "../src/modules/guest-towing/validation.ts";
import { listTowingProviders, notifyTowing, prepareLocation, towingOrder } from "../src/modules/guest-towing/service.ts";
import { towingHandlers } from "../src/modules/guest-towing/http.ts";
import { inspectionSnapshot } from "./fixtures/guest-inspection.mjs";
import { withTowingFixture as fixture, runtime } from "./fixtures/guest-towing.mjs";

let original;
test.before(async () => { original = await inspectionSnapshot(); });
test.after(async () => {
  try { assert.deepEqual(await inspectionSnapshot(), original, "All towing fixtures, references and support config must roll back"); }
  finally { await closeDatabase(); }
});
const get = (path) => new Request(`http://towing.test/api/guest-towing/${path}`);
const post = (body) => new Request("http://towing.test/api/guest-towing/requests", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const rows = (tx, gov) => tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.originGovernorateId, gov));
const notices = (tx, id) => tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, id));
const listing = (f, dest = f.otherGov) => listTowingProviders(f.gov, dest, f.tx, runtime);

test("towing validation reuses Unicode guest/E.164 rules and requires consent, provider and both governorates", () => {
  const input = { originGovernorateId: randomUUID(), destGovernorateId: randomUUID(), providerId: randomUUID(),
    guestName: "  ضيف تحقق  ", guestPhone: " +963900000001 ", acceptedTerms: true };
  assert.equal(parseTowing(input).guestName, "ضيف تحقق");
  assert.equal(parseTowing(input).guestPhone, "+963900000001");
  for (const field of ["originGovernorateId", "destGovernorateId", "providerId", "guestName", "guestPhone", "acceptedTerms"]) {
    assert.throws(() => parseTowing({ ...input, [field]: null }), (e) => e.status === 422);
  }
  for (const guestPhone of ["963900000001", "+0123", "+963 900", "", "+1234567890123456"]) {
    assert.throws(() => parseTowing({ ...input, guestPhone }), (e) => e.status === 422);
  }
  assert.throws(() => parseTowing({ ...input, guestName: "x\0y" }), (e) => e.status === 422);
  assert.throws(() => parseTowing({ ...input, regionId: randomUUID() }), (e) => e.status === 422);
  assert.throws(() => parseRoute("", randomUUID()), (e) => e.status === 422);
});

test("origin/destination lookup rejects invented or inactive governorates without writes", () => fixture(async (f) => {
  for (const [origin, dest] of [[randomUUID(), f.otherGov], [f.gov, randomUUID()], ["bad", f.otherGov], [null, f.otherGov]]) {
    await assert.rejects(listTowingProviders(origin, dest, f.tx, runtime), (e) => e.status === 422);
  }
  await f.tx.update(s.governorates).set({ isActive: false }).where(eq(s.governorates.id, f.otherGov));
  await assert.rejects(listing(f), (e) => e.status === 422 && !!e.fields.destGovernorateId);
  assert.equal((await rows(f.tx, f.gov)).length, 0);
}));

test("same-governorate towing is permitted and requires coverage of that governorate", () => fixture(async (f) => {
  const result = await listing(f, f.gov);
  assert.ok(result.sectionA.some((p) => p.id === f.ids.originOnlyB));
  assert.ok(result.sectionB.some((p) => p.id === f.ids.destOnlyB));
  const request = await notifyTowing({ ...f.input, destGovernorateId: f.gov, providerId: f.ids.originOnlyB }, f.tx, runtime);
  assert.equal(request.matchingStatus, "matched");
  const [stored] = await rows(f.tx, f.gov);
  assert.equal(stored.destGovernorateId, f.gov);
}));

test("Section A covers both governorates; B retains partial/no-coverage active/open towing providers", () => fixture(async (f) => {
  const result = await listing(f);
  assert.deepEqual(result.sectionA.map((p) => p.id).sort(),
    [f.ids.originA, f.ids.destA, f.ids.otherA1, f.ids.otherA2].sort());
  assert.deepEqual(result.sectionB.map((p) => p.id).sort(),
    [f.ids.originOnlyB, f.ids.destOnlyB, f.ids.emptyB].sort());
  assert.equal(result.contactPhone, null);
  assert.equal((await rows(f.tx, f.gov)).length, 0);
}));

test("Section A order is origin base then destination base then RANDOM(), with no ranking labels", () => fixture(async (f) => {
  const result = await listing(f);
  assert.equal(result.sectionA[0].id, f.ids.originA);
  assert.equal(result.sectionA[1].id, f.ids.destA);
  assert.deepEqual(result.sectionA.slice(2).map((p) => p.id).sort(), [f.ids.otherA1, f.ids.otherA2].sort());
  const query = getDatabase().select().from(s.providers).orderBy(...towingOrder(f.gov, f.otherGov)).toSQL();
  assert.match(query.sql, /case when.*then 0\s+when.*then 1 else 2 end.*random\(\)/s);
  assert.equal(Object.hasOwn(result.sectionA[0], "rank"), false);
}));

test("ordering applies partially when an origin/destination base cohort is missing", () => fixture(async (f) => {
  await f.tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, f.ids.originA));
  assert.equal((await listing(f)).sectionA[0].id, f.ids.destA);
  await f.tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, f.ids.destA));
  assert.deepEqual((await listing(f)).sectionA.map((p) => p.id).sort(), [f.ids.otherA1, f.ids.otherA2].sort());
}));

test("empty Section A retains Section B and absent support number is null, never an OTP substitute", () => fixture(async (f) => {
  const result = await listing(f, f.extraDest);
  assert.equal(result.sectionA.length, 0);
  assert.equal(result.sectionB.length, 7);
  assert.equal(result.contactPhone, null);
}));

test("support contact uses only configured contact_phone and rejects invalid configuration", () => fixture(async (f) => {
  await f.tx.insert(s.systemConfig).values({ key: "contact_phone", value: "+19990000001", updatedBy: f.ops, updatedAt: runtime.now() });
  assert.equal((await listing(f, f.extraDest)).contactPhone, "+19990000001");
  await f.tx.update(s.systemConfig).set({ value: "not-a-phone" }).where(eq(s.systemConfig.key, "contact_phone"));
  await assert.rejects(listing(f), (e) => e.status === 503);
  assert.equal((await rows(f.tx, f.gov)).length, 0);
}));

test("U-15 cards contain coverage, tow type and phone only, not credentials or inspection capabilities", () => fixture(async (f) => {
  const result = await listing(f);
  const card = result.sectionA[0];
  assert.deepEqual(Object.keys(card).sort(), ["id", "businessName", "phone", "coverage", "towType"].sort());
  assert.equal(card.towType, f.towType.nameAr);
  assert.deepEqual(card.coverage.map((g) => g.id).sort(), [f.gov, f.otherGov].sort());
  for (const table of [s.providerBrands, s.providerBrandGroups, s.providerYearCategories, s.providerFuelTypes, s.providerVehicleCategories]) {
    assert.equal((await f.tx.select().from(table).where(inArray(table.providerId, Object.values(f.ids)))).length, 0);
  }
}));

test("first Section A confirmation persists one guest towing request and one notification transactionally", () => fixture(async (f) => {
  const result = await notifyTowing(f.input, f.tx, runtime);
  assert.equal(result.matchingStatus, "matched");
  assert.equal(result.delivery, "not_implemented");
  const stored = await rows(f.tx, f.gov);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, result.requestId);
  for (const field of ["guestName", "guestPhone", "originGovernorateId", "destGovernorateId"]) {
    assert.equal(stored[0][field], f.input[field]);
  }
  assert.equal(stored[0].serviceType, "towing");
  assert.equal(stored[0].userType, "guest");
  for (const field of ["userId", "vehicleId", "inspectionGovernorateId", "inspectionRegionId"]) assert.equal(stored[0][field], null);
  const notifications = await notices(f.tx, result.requestId);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].providerId, f.ids.originA);
  assert.equal(notifications[0].originGovernorateId, f.gov);
  assert.equal(notifications[0].destGovernorateId, f.otherGov);
  assert.equal(notifications[0].guestName, f.input.guestName);
  assert.equal(notifications[0].guestPhone, f.input.guestPhone);
}));

test("Section B contact creates no_match request plus provider notification (not a providerless path)", () => fixture(async (f) => {
  const result = await notifyTowing({ ...f.input, providerId: f.ids.originOnlyB }, f.tx, runtime);
  assert.equal(result.matchingStatus, "no_match");
  assert.equal((await rows(f.tx, f.gov))[0].matchingStatus, "no_match");
  assert.equal((await notices(f.tx, result.requestId))[0].providerId, f.ids.originOnlyB);
}));

test("later provider confirmations reuse identity/route/parent, promote B to A, and never downgrade matched", () => fixture(async (f) => {
  const first = await notifyTowing({ ...f.input, providerId: f.ids.originOnlyB }, f.tx, runtime);
  const next = { ...f.input, requestProof: first.requestProof };
  const second = await notifyTowing(next, f.tx, runtime);
  const third = await notifyTowing({ ...next, providerId: f.ids.destOnlyB }, f.tx, runtime);
  assert.equal(first.matchingStatus, "no_match");
  assert.equal(second.matchingStatus, "matched");
  assert.equal(third.matchingStatus, "matched");
  assert.equal(third.requestId, first.requestId);
  assert.equal(second.requestId, first.requestId);
  assert.equal((await rows(f.tx, f.gov)).length, 1);
  assert.equal((await notices(f.tx, first.requestId)).length, 3);
}));

test("continuation proof cannot be forged and cannot alter the original guest identity/route", () => fixture(async (f) => {
  const first = await notifyTowing(f.input, f.tx, runtime);
  for (const requestProof of [first.requestId, `${first.requestId}.forged`, `${randomUUID()}.${first.requestProof.split(".")[1]}`]) {
    await assert.rejects(notifyTowing({ ...f.input, requestProof, providerId: f.ids.destA }, f.tx, runtime), (e) => e.status === 403);
  }
  for (const change of [{ guestName: "آخر" }, { guestPhone: "+963900000002" }, { destGovernorateId: f.extraDest }]) {
    await assert.rejects(notifyTowing({ ...f.input, requestProof: first.requestProof, providerId: f.ids.destA, ...change },
      f.tx, runtime), (e) => e.status === 409);
  }
  assert.equal((await rows(f.tx, f.gov)).length, 1);
  assert.equal((await notices(f.tx, first.requestId)).length, 1);
}));

test("confirmation rejects stale/closed/non-towing/invented provider without any partial records", () => fixture(async (f) => {
  await f.tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, f.ids.originA));
  const [inspection] = await f.tx.select().from(s.providers).where(eq(s.providers.serviceType, "inspection")).limit(1);
  for (const providerId of [f.ids.originA, f.ids.closed, f.ids.closedToday, f.ids.pending, f.ids.disabled, inspection.id, randomUUID()]) {
    await assert.rejects(notifyTowing({ ...f.input, providerId }, f.tx, runtime), (e) => e.status === 409);
  }
  assert.equal((await rows(f.tx, f.gov)).length, 0);
}));

test("confirmation rechecks governorate and CURRENT coverage rather than trusting client section/status", () => fixture(async (f) => {
  await f.tx.delete(s.providerCoverage).where(and(eq(s.providerCoverage.providerId, f.ids.originA),
    eq(s.providerCoverage.governorateId, f.otherGov)));
  const current = await notifyTowing(f.input, f.tx, runtime);
  assert.equal(current.matchingStatus, "no_match");
  await f.tx.update(s.governorates).set({ isActive: false }).where(eq(s.governorates.id, f.otherGov));
  await assert.rejects(notifyTowing({ ...f.input, providerId: f.ids.destA, requestProof: current.requestProof }, f.tx, runtime),
    (e) => e.status === 422);
  assert.equal((await notices(f.tx, current.requestId)).length, 1);
}));

test("notification insert failure rolls back its newly created request and preserves existing parent/history", () => fixture(async (f) => {
  const first = await notifyTowing(f.input, f.tx, runtime);
  const failing = towingHandlers(() => f.tx, { ...runtime, id: () => first.notificationId });
  const before = await rows(f.tx, f.gov);
  assert.equal((await failing.create(post({ ...f.input, providerId: f.ids.destA }))).status, 503);
  assert.deepEqual(await rows(f.tx, f.gov), before);
  assert.equal((await failing.create(post({ ...f.input, providerId: f.ids.destOnlyB, requestProof: first.requestProof }))).status, 503);
  assert.deepEqual(await rows(f.tx, f.gov), before);
  assert.equal((await notices(f.tx, first.requestId)).length, 1);
}));

test("prepared WhatsApp guest message uses whatsapp_number, never phone; no platform delivery", () => fixture(async (f) => {
  const [provider] = await f.tx.select().from(s.providers).where(eq(s.providers.id, f.ids.originA));
  const result = await notifyTowing(f.input, f.tx, runtime);
  const url = new URL(result.whatsappUrl);
  assert.equal(url.hostname, "wa.me");
  assert.equal(url.pathname, `/${provider.whatsappNumber.slice(1)}`);
  assert.notEqual(url.pathname, `/${provider.phone.slice(1)}`);
  assert.equal(url.searchParams.get("text"), `أنا مستخدمك من «Syriacar»، اسمي ${f.input.guestName}، رقمي ${f.input.guestPhone}، وأريد سطحة.`);
}));

test("manual post-notification location validates parent and locality, builds frozen template without writes or route changes", () => fixture(async (f) => {
  const result = await notifyTowing(f.input, f.tx, runtime);
  const before = await rows(f.tx, f.gov);
  const location = { requestProof: result.requestProof, notificationId: result.notificationId,
    governorateId: f.otherBase, regionId: f.otherBaseRegion };
  const prepared = await prepareLocation(location, f.tx);
  assert.equal(new URL(prepared.whatsappUrl).pathname, new URL(result.whatsappUrl).pathname);
  assert.equal(new URL(prepared.whatsappUrl).searchParams.get("text"),
    `Syriacar — ${f.input.guestName} — سطحة — موقعي: محافظة محافظة مقر تحقق، منطقة منطقة مقر تحقق`);
  await assert.rejects(prepareLocation({ ...location, regionId: f.region }, f.tx), (e) => e.status === 422);
  await assert.rejects(prepareLocation({ ...location, notificationId: randomUUID() }, f.tx), (e) => e.status === 403);
  await assert.rejects(prepareLocation({ ...location, latitude: 33 }, f.tx), (e) => e.status === 422);
  assert.deepEqual(await rows(f.tx, f.gov), before);
  assert.equal((await notices(f.tx, result.requestId)).length, 1);
}));

test("HTTP handlers are uncached, reject malformed/oversized/non-JSON input and client-forced matching fields", () => fixture(async (f) => {
  const response = await f.api.providers(get(`providers?originGovernorateId=${f.gov}&destGovernorateId=${f.otherGov}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await f.api.governorates(get("governorates"))).status, 200);
  for (const request of [
    new Request("http://towing.test", { method: "POST", body: "{}" }),
    new Request("http://towing.test", { method: "POST", headers: { "content-type": "application/json" }, body: "bad" }),
    post({ ...f.input, matchingStatus: "matched" }), post({ ...f.input, guestName: "x".repeat(9000) }),
  ]) {
    const failure = await f.api.create(request);
    assert.ok([422, 413].includes(failure.status));
  }
  assert.equal((await rows(f.tx, f.gov)).length, 0);
}));