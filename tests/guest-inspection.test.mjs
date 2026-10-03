import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import nextEnv from "@next/env";
import { eq } from "drizzle-orm";
import { getDatabase, closeDatabase } from "../src/server/db/client.ts";
import { applicationRowCounts } from "../src/server/db/catalog.ts";
import * as s from "../src/server/db/schema.ts";
import { defaultWorkDays } from "../src/server/db/schema/types.ts";
import { damascusTime, openWindow } from "../src/modules/guest-inspection/availability.ts";
import { parseGuestInspection, InspectionError } from "../src/modules/guest-inspection/validation.ts";
import { inspectionHandlers } from "../src/modules/guest-inspection/http.ts";
import { createGuestInspection, listProviders } from "../src/modules/guest-inspection/service.ts";

nextEnv.loadEnvConfig(process.cwd());
const noon = new Date("2026-10-04T09:00:00Z"); // Sunday, 12:00 Damascus
const friday = new Date("2026-10-09T09:00:00Z");
const runtime = { now: () => noon };
const phone = () => `+1999${randomInt(1_000_000, 10_000_000)}`;
const db = getDatabase();
let originalCounts, originalReferences, originalSupportPhone;

async function referenceSnapshot() {
  return Promise.all([s.governorates, s.regions, s.brandGroups, s.brands, s.fuelTypes, s.towTypes]
    .map(async (table) => (await db.select().from(table)).sort((a, b) => a.id.localeCompare(b.id))));
}
test.before(async () => {
  originalCounts = await applicationRowCounts();
  originalReferences = await referenceSnapshot();
  originalSupportPhone = (await db.select().from(s.systemConfig).where(eq(s.systemConfig.key, "contact_phone")))[0]?.value ?? null;
});
test.after(async () => {
  try {
    assert.deepEqual(await applicationRowCounts(), originalCounts, "Every fixture/request must roll back");
    assert.deepEqual(await referenceSnapshot(), originalReferences, "Approved reference rows must remain byte-for-byte unchanged");
    assert.equal((await db.select().from(s.systemConfig).where(eq(s.systemConfig.key, "contact_phone")))[0]?.value ?? null,
      originalSupportPhone, "Verification must restore existing support configuration");
  } finally {
    await closeDatabase();
  }
});

// Every integration test uses its own uncommitted fixture transaction. Even a
// test assertion failure rolls back; there are no committed cleanup windows.
async function fixture(check) {
  const rollback = new Error("ROLLBACK_GUEST_INSPECTION_FIXTURE");
  try {
    await db.transaction(async (tx) => {
      const gov = randomUUID(), otherGov = randomUUID();
      const region = randomUUID(), otherRegion = randomUUID(), alternateRegion = randomUUID();
      const ops = randomUUID();
      await tx.insert(s.governorates).values([
        { id: gov, nameAr: "محافظة تحقق فقط", isActive: true },
        { id: otherGov, nameAr: "محافظة تحقق أخرى", isActive: true },
      ]);
      await tx.insert(s.regions).values([
        { id: region, governorateId: gov, nameAr: "منطقة تحقق فقط", isActive: true },
        { id: alternateRegion, governorateId: gov, nameAr: "منطقة تحقق بديلة", isActive: true },
        { id: otherRegion, governorateId: otherGov, nameAr: "منطقة تحقق أخرى", isActive: true },
      ]);
      await tx.insert(s.opsUsers).values({
        id: ops, name: "verification only", username: `verify_${ops}`,
        passwordHash: "verification_only_not_a_credential", role: "operations", createdAt: noon,
      });
      const ids = Object.fromEntries(["active", "capable", "oldClosure", "closedToday", "closedSchedule",
        "pending", "disabled", "towing", "otherRegion", "otherGovernorate"].map((k) => [k, randomUUID()]));
      const configs = {
        active: {},
        capable: {},
        oldClosure: { todayClosed: true, todayClosedDate: "2026-10-03" },
        closedToday: { todayClosed: true, todayClosedDate: "2026-10-04" },
        closedSchedule: { workDays: { ...defaultWorkDays, sun: { enabled: false, start: null, end: null } } },
        pending: { status: "pending" },
        disabled: { status: "disabled" },
        towing: { serviceType: "towing" },
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
      const input = {
        governorateId: gov, regionId: region, providerId: ids.active,
        guestName: "ضيف تحقق", guestPhone: "+963900000001", acceptedTerms: true,
      };
      const api = inspectionHandlers(() => tx, runtime);
      await check({ tx, gov, region, otherGov, otherRegion, ids, input, api, group, brand, fuel, ops });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
const get = (path) => new Request(`http://inspection.test${path}`);
const post = (body) => new Request("http://inspection.test/api/guest-inspection/requests", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("guest validation accepts Unicode names/E.164 without authentication or vehicle fields", () => {
  const input = { governorateId: randomUUID(), regionId: randomUUID(), providerId: null,
    guestName: "  مُحمّد شحادة  ", guestPhone: " +963900000001 ", acceptedTerms: true };
  assert.equal(parseGuestInspection(input).guestName, "مُحمّد شحادة");
  assert.equal(parseGuestInspection(input).guestPhone, "+963900000001");
  for (const change of [
    { guestName: "" }, { guestName: "   " }, { guestName: 12 }, { guestName: "اسم\0" },
    { guestPhone: "0900000001" }, { guestPhone: "+0963900000001" },
    { guestPhone: "+963 900000001" }, { guestPhone: "+1234567890123456" },
    { guestPhone: null }, { governorateId: "bad" }, { regionId: null },
    { providerId: "bad" }, { acceptedTerms: false }, { acceptedTerms: "true" },
    { matchingStatus: "matched" }, { vehicleId: randomUUID() }, { now: friday.toISOString() },
  ]) {
    assert.throws(() => parseGuestInspection({ ...input, ...change }), (e) =>
      e instanceof InspectionError && e.status === 422);
  }
});

test("availability follows Damascus date/weekdays, inclusive boundaries, and work_days only", () => {
  const provider = { workDays: defaultWorkDays, todayClosed: false, todayClosedDate: null };
  assert.deepEqual(damascusTime(new Date("2026-10-03T22:00:00Z")),
    { date: "2026-10-04", weekday: "sun", seconds: 3600 });
  assert.ok(openWindow(provider, new Date("2026-10-04T05:00:00Z")));
  assert.equal(openWindow(provider, new Date("2026-10-04T04:59:59Z")), null);
  assert.ok(openWindow(provider, new Date("2026-10-04T17:00:00Z")));
  assert.equal(openWindow(provider, new Date("2026-10-04T17:00:01Z")), null);
  assert.equal(openWindow(provider, friday), null);
  assert.equal(openWindow({ ...provider, todayClosed: true, todayClosedDate: "2026-10-04" }, noon), null);
  assert.ok(openWindow({ ...provider, todayClosed: true, todayClosedDate: "2026-10-03" }, noon));
  assert.equal(openWindow({ ...provider, workDays: { ...defaultWorkDays, sun: { enabled: true, start: "20:00", end: "08:00" } } }, noon), null);
});

test("localities API lists active reference rows with dependent regions and performs no writes", () => fixture(async ({ tx, gov, region, otherRegion, api }) => {
  const before = await tx.select().from(s.serviceRequests);
  const response = await api.localities(get(`/api/guest-inspection/localities?governorateId=${gov}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.ok(data.governorates.some((g) => g.id === gov));
  assert.ok(data.regions.some((r) => r.id === region));
  assert.ok(!data.regions.some((r) => r.id === otherRegion));
  assert.deepEqual(await tx.select().from(s.serviceRequests), before);
  assert.equal((await api.localities(get("/api/guest-inspection/localities?governorateId=bad"))).status, 422);
}));

test("invalid governorate/region relationship is rejected for lookup and creation", () => fixture(async ({ tx, gov, otherRegion, input, api }) => {
  const before = await tx.select().from(s.serviceRequests);
  const lookup = await api.providers(get(`/api/guest-inspection/providers?governorateId=${gov}&regionId=${otherRegion}`));
  assert.equal(lookup.status, 422);
  assert.ok((await lookup.json()).fields.regionId);
  assert.equal((await api.create(post({ ...input, regionId: otherRegion }))).status, 422);
  assert.deepEqual(await tx.select().from(s.serviceRequests), before);
}));

test("inactive locality rows cannot be selected or used to create requests", () => fixture(async ({ tx, gov, region, input, api }) => {
  await tx.update(s.regions).set({ isActive: false }).where(eq(s.regions.id, region));
  const response = await api.localities(get(`/api/guest-inspection/localities?governorateId=${gov}`));
  assert.ok(!(await response.json()).regions.some((r) => r.id === region));
  assert.equal((await api.create(post(input))).status, 422);
  await tx.update(s.governorates).set({ isActive: false }).where(eq(s.governorates.id, gov));
  assert.equal((await api.localities(get(`/api/guest-inspection/localities?governorateId=${gov}`))).status, 422);
}));

test("guest matching is exactly active/open inspection providers in the selected locality", () => fixture(async ({ gov, region, ids, api }) => {
  const response = await api.providers(get(`/api/guest-inspection/providers?governorateId=${gov}&regionId=${region}`));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.providers.map((p) => p.id).sort(), [ids.active, ids.capable, ids.oldClosure].sort());
  assert.equal(data.contactPhone, originalSupportPhone);
  const emptyCapabilities = data.providers.find((p) => p.id === ids.active);
  assert.deepEqual(emptyCapabilities.brands, []);
  assert.deepEqual(emptyCapabilities.hours, { start: "08:00", end: "20:00" });
  for (const provider of data.providers) {
    assert.ok(!("passwordHash" in provider));
    assert.ok(!("whatsappNumber" in provider));
    assert.ok(!("locationLat" in provider));
  }
}));

test("required provider-card capabilities are informational and do not filter the guest", () => fixture(async ({ gov, region, ids, tx, group, brand, fuel }) => {
  const data = await listProviders(gov, region, tx, runtime);
  const provider = data.providers.find((p) => p.id === ids.capable);
  assert.deepEqual(provider.brandGroups, [group.nameAr]);
  assert.deepEqual(provider.brands, [brand.nameAr]);
  assert.deepEqual(provider.fuelTypes, [fuel.nameAr]);
  assert.deepEqual(provider.yearCategories, ["classic"]);
  assert.deepEqual(provider.vehicleCategories, ["truck"]);
  assert.ok(data.providers.some((p) => p.id === ids.active));
}));

test("matched confirmation creates exactly one guest request and its provider notification", () => fixture(async ({ tx, input, ids, api }) => {
  const response = await api.create(post(input));
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.matchingStatus, "matched");
  assert.equal(result.delivery, "not_implemented");
  assert.equal(result.provider.id, ids.active);
  const [request] = await tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, result.requestId));
  const notices = await tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, result.requestId));
  assert.equal(request.guestName, input.guestName);
  assert.equal(request.guestPhone, input.guestPhone);
  assert.equal(request.userType, "guest");
  assert.equal(request.serviceType, "inspection");
  assert.equal(request.userId, null);
  assert.equal(request.vehicleId, null);
  assert.equal(request.inspectionGovernorateId, input.governorateId);
  assert.equal(request.inspectionRegionId, input.regionId);
  assert.equal(request.originGovernorateId, null);
  assert.equal(request.destGovernorateId, null);
  assert.equal(request.matchingStatus, "matched");
  assert.equal(request.createdAt.toISOString(), noon.toISOString());
  assert.equal(notices.length, 1);
  assert.equal(notices[0].id, result.notificationId);
  assert.equal(notices[0].providerId, ids.active);
  assert.equal(notices[0].guestPhone, input.guestPhone);
  assert.equal(notices[0].guestName, input.guestName);
  assert.equal(notices[0].followupStatus, "pending");
  assert.ok(!("matchingStatus" in notices[0]));
}));

test("no-match confirmation creates one request, explicit no_match, and no notification", () => fixture(async ({ tx, input }) => {
  const api = inspectionHandlers(() => tx, { now: () => friday });
  const result = await (await api.create(post({ ...input, providerId: null }))).json();
  assert.equal(result.matchingStatus, "no_match");
  assert.equal(result.notificationId, null);
  assert.equal(result.provider, null);
  assert.equal(result.contactPhone, originalSupportPhone);
  const [row] = await tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, result.requestId));
  assert.equal(row.matchingStatus, "no_match");
  assert.equal(row.inspectionGovernorateId, input.governorateId);
  assert.equal(row.inspectionRegionId, input.regionId);
  assert.equal((await tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, row.id))).length, 0);
}));

test("server rejects wrong-locality, wrong-service, inactive, closed, and invented provider selections", () => fixture(async ({ tx, input, ids, api }) => {
  const before = await tx.select().from(s.serviceRequests);
  for (const providerId of [ids.otherRegion, ids.otherGovernorate, ids.towing, ids.pending,
    ids.disabled, ids.closedToday, ids.closedSchedule, randomUUID()]) {
    assert.equal((await api.create(post({ ...input, providerId }))).status, 409);
  }
  assert.deepEqual(await tx.select().from(s.serviceRequests), before);
}));

test("confirmation rechecks stale availability and rejects a client-forced no-match outcome", () => fixture(async ({ tx, input, gov, region, ids, api }) => {
  assert.ok((await listProviders(gov, region, tx, runtime)).providers.some((p) => p.id === ids.active));
  await tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, ids.active));
  assert.equal((await api.create(post(input))).status, 409);
  assert.equal((await api.create(post({ ...input, providerId: null }))).status, 409);
  assert.equal((await api.create(post({ ...input, matchingStatus: "no_match" }))).status, 422);
  assert.equal((await tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.inspectionGovernorateId, gov))).length, 0);
}));

test("one-to-many notification model remains intact without an additional parent per provider", () => fixture(async ({ tx, input, ids }) => {
  const first = await createGuestInspection(input, tx, runtime);
  // Model verification only: the slice exposes first confirmation, not a later-notification API.
  await tx.insert(s.notifications).values({
    id: randomUUID(), serviceRequestId: first.requestId, providerId: ids.capable,
    serviceType: "inspection", userType: "guest", guestName: input.guestName,
    guestPhone: input.guestPhone, createdAt: noon,
  });
  assert.equal((await tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, first.requestId))).length, 1);
  const notices = await tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, first.requestId));
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map((n) => n.providerId).sort(), [ids.active, ids.capable].sort());
}));

test("notification creation failure rolls back the new request and returns a safe API error", () => fixture(async ({ tx, input }) => {
  const existing = await createGuestInspection(input, tx, runtime);
  const failedId = randomUUID();
  const generated = [failedId, existing.notificationId];
  const api = inspectionHandlers(() => tx, { ...runtime, id: () => generated.shift() });
  const response = await api.create(post(input));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "حدث خطأ. حاول مجدداً." });
  assert.equal((await tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, failedId))).length, 0);
  assert.equal((await tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, existing.requestId))).length, 1);
}));

test("name/phone/consent validation rejects creation before any database writes", () => fixture(async ({ tx, input, api }) => {
  const before = await tx.select().from(s.serviceRequests);
  for (const change of [{ guestName: "" }, { guestPhone: "09000" }, { acceptedTerms: false }]) {
    const response = await api.create(post({ ...input, ...change }));
    assert.equal(response.status, 422);
    assert.ok((await response.json()).fields);
  }
  assert.deepEqual(await tx.select().from(s.serviceRequests), before);
}));

test("API rejects malformed/non-JSON/oversized bodies with no writes", () => fixture(async ({ tx, api }) => {
  const before = await tx.select().from(s.serviceRequests);
  for (const [body, contentType, expected] of [
    ["{", "application/json", 422],
    ["{}", "text/plain", 422],
    [JSON.stringify({ guestName: "x".repeat(9000) }), "application/json", 413],
  ]) {
    const response = await api.create(new Request("http://inspection.test/api/guest-inspection/requests", {
      method: "POST", headers: { "Content-Type": contentType }, body,
    }));
    assert.equal(response.status, expected);
  }
  assert.deepEqual(await tx.select().from(s.serviceRequests), before);
}));

test("confirmed matching history is not reclassified when provider state later changes", () => fixture(async ({ tx, input, ids }) => {
  const result = await createGuestInspection(input, tx, runtime);
  await tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, ids.active));
  const [row] = await tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, result.requestId));
  assert.equal(row.matchingStatus, "matched");
}));

test("configured support phone is read from system_config rather than an example or gateway", () => fixture(async ({ tx, input, gov, region, ops }) => {
  // A verification-only config row, attributed to the uncommitted fixture actor.
  await tx.insert(s.systemConfig).values({ key: "contact_phone", value: "+19990000000", updatedBy: ops, updatedAt: noon })
    .onConflictDoUpdate({ target: s.systemConfig.key, set: { value: "+19990000000", updatedBy: ops, updatedAt: noon } });
  const result = await createGuestInspection({ ...input, providerId: null }, tx, { now: () => friday });
  assert.equal(result.contactPhone, "+19990000000");
  assert.equal((await listProviders(gov, region, tx, runtime)).contactPhone, "+19990000000");
}));

test("real HTTP transport completes matched and no-match flows against isolated PostgreSQL", () => fixture(async ({ tx, input, gov, region, api }) => {
  // Test-only transport binds the identical HTTP handlers used by Next routes.
  // Its DB dependency is the uncommitted fixture transaction: no commit/cleanup
  // window, public test bypass, alternate production client, or real seed.
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
      const url = new URL(request.url, "http://inspection.test");
      const handler = {
        "/api/guest-inspection/localities": api.localities,
        "/api/guest-inspection/providers": api.providers,
        "/api/guest-inspection/requests": api.create,
      }[url.pathname];
      if (!handler) { response.writeHead(404).end(); return; }
      const result = await handler(new Request(url, {
        method: request.method, headers,
        ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    } catch {
      response.writeHead(500).end("Test transport failed");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const lookup = await fetch(`${origin}/api/guest-inspection/providers?governorateId=${gov}&regionId=${region}`);
    assert.equal(lookup.status, 200);
    assert.ok((await lookup.json()).providers.some((p) => p.id === input.providerId));
    const matchedResponse = await fetch(`${origin}/api/guest-inspection/requests`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    assert.equal(matchedResponse.status, 201);
    const matched = await matchedResponse.json();
    assert.equal(matched.matchingStatus, "matched");
    assert.equal((await tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, matched.requestId))).length, 1);

    await tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.governorateId, gov));
    const empty = await fetch(`${origin}/api/guest-inspection/providers?governorateId=${gov}&regionId=${region}`);
    assert.deepEqual((await empty.json()).providers, []);
    const noMatchResponse = await fetch(`${origin}/api/guest-inspection/requests`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, providerId: null, guestName: "ضيف تحقق آخر" }),
    });
    assert.equal(noMatchResponse.status, 201);
    const noMatch = await noMatchResponse.json();
    assert.equal(noMatch.matchingStatus, "no_match");
    assert.equal((await tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, noMatch.requestId))).length, 0);
    const parents = await tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.inspectionGovernorateId, gov));
    assert.equal(parents.length, 2);
    assert.equal(parents.find((p) => p.id === matched.requestId).matchingStatus, "matched");
    assert.notEqual(matched.requestId, noMatch.requestId);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}));