import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { eq, inArray } from "drizzle-orm";
import { closeDatabase } from "../src/server/db/client.ts";
import * as s from "../src/server/db/schema.ts";
import { withManualSeedIsolation, fixtureTableSnapshot } from "./fixtures/manual-seed-isolation.mjs";
import { seedManualScenarios } from "../src/server/db/seed/manual-scenarios.ts";
import { seedProviderFixtures } from "../src/server/db/seed/provider-fixtures.ts";
import { removeProviderFixtures } from "../src/server/db/seed/provider-fixture-reset.ts";
import { providerFixtures, providerFixtureOwner, providerFixtureRoutes } from "../src/server/db/seed/provider-fixture-data.ts";
import { manualScenarios, manualLocality } from "../src/server/db/seed/manual-scenario-data.ts";
import { inspectionProviders } from "../src/modules/registered-services/inspection.ts";
import { confirm } from "../src/modules/registered-services/service.ts";
import { listProviders, createGuestInspection } from "../src/modules/guest-inspection/service.ts";
import { listTowingProviders, notifyTowing } from "../src/modules/guest-towing/service.ts";
import { openWindow } from "../src/modules/guest-inspection/availability.ts";
import { coordinates } from "../src/modules/registered-services/contracts.ts";

after(closeDatabase);
const baseline = await fixtureTableSnapshot();
const options = { confirmDevelopment: true };
const time = new Date("2026-10-04T09:00:00Z");
const fixture = key => providerFixtures.find(f => f.key === key);
const vehicle = manualScenarios.find(x => x.key === "verified");
const noMatch = manualScenarios.find(x => x.key === "no-match");
const route = {
  originGovernorateId: providerFixtureRoutes.originGovernorateId,
  destGovernorateId: providerFixtureRoutes.destGovernorateId,
};
const run = (name, fn) => test(name, () => withManualSeedIsolation(async tx => {
  await seedManualScenarios(options, tx);
  await fn(tx);
}));
const seed = tx => seedProviderFixtures(options, tx);
const remove = tx => removeProviderFixtures(options, tx);
const requestRows = tx => tx.select().from(s.serviceRequests);
const noticeRows = tx => tx.select().from(s.notifications);
const inspection = { vehicleId: vehicle.vehicle.id, ...manualLocality, acceptedTerms: true };
async function user(tx, scenario = vehicle) {
  return (await tx.select().from(s.users).where(eq(s.users.id, scenario.id)))[0];
}

test("provider fixture and removal CLI refuse production, published runtime, unapproved DB and missing acknowledgment before connecting", () => {
  for (const mode of ["--provider-fixtures", "--remove-provider-fixtures"]) {
    for (const [NODE_ENV, flags, extra] of [
      ["production", [mode, "--confirm-development"], {}],
      ["development", [mode, "--confirm-development"], { REPLIT_DEPLOYMENT: "1" }],
      ["test", [mode, "--confirm-development"], {}],
      ["development", [mode], {}],
      ["development", [mode, "--manual-scenarios", "--confirm-development"], {}],
    ]) {
      const r = spawnSync(process.execPath, ["--conditions=react-server", "src/server/db/seed/seed-cli.ts", ...flags], {
        env: { ...process.env, NODE_ENV, DATABASE_URL: "postgresql://127.0.0.1:1/forbidden", ...extra },
        encoding: "utf8", timeout: 10000,
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /no partial seed committed/);
      assert.doesNotMatch(r.stderr, /forbidden|ECONNREFUSED/);
    }
  }
});

test("provider functions themselves reject missing opt-in before touching supplied DB", async () => {
  const connection = { transaction: () => assert.fail("Must not connect") };
  for (const fn of [seedProviderFixtures, removeProviderFixtures]) {
    await assert.rejects(fn({ confirmDevelopment: false }, connection), /confirmation/);
  }
});

run("development fixtures insert exactly six providers/eight coverage/fifteen capabilities and one inactive creator", async tx => {
  const before = await fixtureTableSnapshot(tx), result = await seed(tx), after = await fixtureTableSnapshot(tx);
  assert.deepEqual(result.providers, { inserted: 6, preserved: 0 });
  assert.equal(result.coverageInserted, 8); assert.equal(result.capabilitiesInserted, 15);
  assert.equal(result.creator.active, false);
  for (const [name, original] of Object.entries(before)) {
    const added = name === "providers" ? 6 : name === "provider_coverage" ? 8 : name === "ops_users" ? 1 :
      ["provider_brands", "provider_brand_groups", "provider_year_categories", "provider_fuel_types", "provider_vehicle_categories"].includes(name) ? 3 : 0;
    assert.equal(after[name].count - original.count, added, name);
    if (!added) assert.equal(after[name].digest, original.digest, name + " content preserved");
  }
  const providers = await tx.select().from(s.providers);
  for (const p of providers) {
    assert.match(p.businessName, /^تجريبي فقط/);
    assert.match(p.phone, /^\+1202555011[1-6]$/);
    assert.match(p.whatsappNumber, /^\+1202555012[1-6]$/);
    assert.match(p.passwordHash, /^\$argon2id\$/);
    assert.equal(p.status, "active");
    for (let i = 0; i < 7; i++) assert.ok(openWindow(p, new Date(time.getTime() + i * 86400000)), "All seven Damascus weekdays open");
  }
  const [owner] = await tx.select().from(s.opsUsers).where(eq(s.opsUsers.id, providerFixtureOwner.id));
  assert.equal(owner.isActive, false); assert.equal(owner.role, "operations");
});

run("second run is byte-preserving and inserts no provider/coverage/capability/owner duplicates", async tx => {
  await seed(tx); const before = await fixtureTableSnapshot(tx);
  const result = await seed(tx);
  assert.deepEqual(result.providers, { inserted: 0, preserved: 6 });
  assert.equal(result.coverageInserted, 0); assert.equal(result.capabilitiesInserted, 0); assert.equal(result.creator.inserted, 0);
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
  // Account seed can still be rerun after provider fixtures: old no_match vehicle stays incompatible.
  assert.equal((await seedManualScenarios(options, tx)).users.inserted, 0);
});

run("manual edits to existing fixture availability/coordinates/coverage/capabilities are never overwritten or backfilled", async tx => {
  await seed(tx);
  const id = fixture("inspection-map").provider.id;
  await tx.update(s.providers).set({ status: "disabled", locationLat: null, locationLng: null }).where(eq(s.providers.id, id));
  await tx.delete(s.providerCoverage).where(eq(s.providerCoverage.providerId, id));
  await tx.delete(s.providerFuelTypes).where(eq(s.providerFuelTypes.providerId, id));
  const before = await fixtureTableSnapshot(tx);
  assert.equal((await seed(tx)).providers.inserted, 0);
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
});

run("inspection map and list-only providers both match all five dimensions; incompatible fuel provider is unsuitable", async tx => {
  await seed(tx);
  const result = await inspectionProviders(tx, vehicle.id, vehicle.vehicle.id,
    manualLocality.governorateId, manualLocality.regionId, time);
  const good = result.providers.filter(p => p.suitable);
  assert.deepEqual(good.map(p => p.id).sort(), [fixture("inspection-map").provider.id, fixture("inspection-list").provider.id].sort());
  assert.ok(good.find(p => p.id === fixture("inspection-map").provider.id).coordinates);
  assert.equal(good.find(p => p.id === fixture("inspection-list").provider.id).coordinates, null);
  assert.equal(result.providers.find(p => p.id === fixture("inspection-incompatible").provider.id).suitable, false);
});

run("registered inspection map/list-only confirms matched; incompatible choice refused without writes", async tx => {
  await seed(tx); const owner = await user(tx);
  for (const key of ["inspection-map", "inspection-list"]) {
    const result = await tx.transaction(inner => confirm(inner, owner, { ...inspection, providerId: fixture(key).provider.id }, "inspection", time));
    assert.equal(result.matchingStatus, "matched"); assert.equal(result.delivery, "not_implemented");
    assert.match(result.whatsappUrl, /^https:\/\/wa\.me\/1202555012/);
  }
  const before = await fixtureTableSnapshot(tx);
  await assert.rejects(tx.transaction(inner => confirm(inner, owner,
    { ...inspection, providerId: fixture("inspection-incompatible").provider.id }, "inspection", time)), /لم يعد مناسب/);
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
});

run("old verified truck/diesel/classic no-match scenario stays unmatched in the same locality", async tx => {
  await seed(tx);
  const result = await inspectionProviders(tx, noMatch.id, noMatch.vehicle.id,
    manualLocality.governorateId, manualLocality.regionId, time);
  assert.equal(result.providers.filter(p => p.suitable).length, 0);
  const confirmation = await tx.transaction(async inner => confirm(inner, await user(inner, noMatch),
    { ...inspection, vehicleId: noMatch.vehicle.id, providerId: null }, "inspection", time));
  assert.equal(confirmation.matchingStatus, "no_match"); assert.equal(confirmation.notificationId, null);
});

run("guest inspection retains locality-only behavior and can notify even the vehicle-incompatible fixture", async tx => {
  await seed(tx);
  const result = await listProviders(manualLocality.governorateId, manualLocality.regionId, tx, { now: () => time });
  assert.equal(result.providers.length, 3);
  for (const key of ["inspection-map", "inspection-list", "inspection-incompatible"]) {
    const confirmation = await createGuestInspection({ guestName: "ضيف اختبار فقط", guestPhone: "+12025550199",
      ...manualLocality, providerId: fixture(key).provider.id, acceptedTerms: true }, tx, { now: () => time });
    assert.equal(confirmation.matchingStatus, "matched"); assert.equal(confirmation.delivery, "not_implemented");
  }
  assert.equal((await requestRows(tx)).length, 3); assert.equal((await noticeRows(tx)).length, 3);
});

run("towing fixture graph produces two route-eligible A providers and one contactable B with valid coordinates", async tx => {
  await seed(tx);
  const result = await listTowingProviders(route.originGovernorateId, route.destGovernorateId, tx, { now: () => time });
  assert.deepEqual(result.sectionA.map(p => p.id).sort(),
    [fixture("towing-a-map").provider.id, fixture("towing-a-second").provider.id].sort());
  assert.deepEqual(result.sectionB.map(p => p.id), [fixture("towing-b-map").provider.id]);
  const providers = await tx.select().from(s.providers).where(inArray(s.providers.id,
    [...result.sectionA, ...result.sectionB].map(p => p.id)));
  for (const p of providers) assert.ok(coordinates(p.locationLat, p.locationLng));
});

for (const kind of ["registered", "guest"]) {
  run(kind + " towing B => no_match, later A => matched, later B never downgrades; one parent/multiple notifications", async tx => {
    await seed(tx);
    const owner = await user(tx, manualScenarios.find(x => x.key === "towing-home"));
    let previous;
    for (const [key, expected] of [["towing-b-map", "no_match"], ["towing-a-map", "matched"],
      ["towing-a-second", "matched"], ["towing-b-map", "matched"]]) {
      const input = { ...route, acceptedTerms: true, providerId: fixture(key).provider.id };
      const result = kind === "registered"
        ? await tx.transaction(inner => confirm(inner, owner, { ...input, ...(previous ? { requestId: previous.requestId } : {}) }, "towing", time))
        : await notifyTowing({ ...input, guestName: "ضيف سطحة تجريبي", guestPhone: "+12025550198",
          ...(previous ? { requestProof: previous.requestProof } : {}) }, tx, { now: () => time });
      assert.equal(result.matchingStatus, expected); assert.equal(result.delivery, "not_implemented");
      if (previous) assert.equal(result.requestId, previous.requestId);
      previous = result;
    }
    const requests = await requestRows(tx), notices = await noticeRows(tx);
    assert.equal(requests.length, 1); assert.equal(notices.length, 4);
    assert.equal(requests[0].matchingStatus, "matched"); assert.equal(requests[0].userType, kind);
    assert.ok(notices.every(n => n.serviceRequestId === requests[0].id && n.userType === kind));
  });
}

run("alternative Damascus-Aleppo route has only B fixtures; registered and guest requests remain no_match", async tx => {
  await seed(tx);
  const onlyB = { ...route, destGovernorateId: providerFixtureRoutes.bOnlyDestinationId };
  const result = await listTowingProviders(onlyB.originGovernorateId, onlyB.destGovernorateId, tx, { now: () => time });
  assert.equal(result.sectionA.length, 0); assert.equal(result.sectionB.length, 3);
  const registered = await tx.transaction(async inner => confirm(inner, await user(inner),
    { ...onlyB, providerId: fixture("towing-b-map").provider.id, acceptedTerms: true }, "towing", time));
  const guest = await notifyTowing({ ...onlyB, providerId: fixture("towing-a-map").provider.id,
    acceptedTerms: true, guestName: "ضيف اختبار", guestPhone: "+12025550197" }, tx, { now: () => time });
  assert.equal(registered.matchingStatus, "no_match"); assert.equal(guest.matchingStatus, "no_match");
});

run("real provider phone collision late in seed rolls back creator and all earlier graph inserts", async tx => {
  const ops = randomUUID(), id = randomUUID(), time = new Date();
  await tx.insert(s.opsUsers).values({ id: ops, name: "منشئ آخر يجب حفظه", username: "unrelated-ops", role: "operations",
    isActive: true, passwordHash: "test-only", createdAt: time });
  await tx.insert(s.providers).values({ ...fixture("towing-b-map").provider, id, createdBy: ops,
    businessName: "مزود آخر يجب حفظه", passwordHash: "test-only", createdAt: time });
  const before = await fixtureTableSnapshot(tx);
  await assert.rejects(seed(tx), /identity collision/);
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
});

run("coverage stable-ID collision rolls back all inserts without claiming another provider's row", async tx => {
  const ops = randomUUID(), id = randomUUID(), time = new Date();
  await tx.insert(s.opsUsers).values({ id: ops, name: "منشئ آخر", username: "other", role: "operations",
    isActive: true, passwordHash: "test-only", createdAt: time });
  await tx.insert(s.providers).values({ ...fixture("towing-b-map").provider, id, createdBy: ops,
    businessName: "مزود آخر", phone: "+12025550195", whatsappNumber: "+12025550196", passwordHash: "test-only", createdAt: time });
  await tx.insert(s.providerCoverage).values({ ...fixture("inspection-map").coverage[0], providerId: id });
  const before = await fixtureTableSnapshot(tx);
  await assert.rejects(seed(tx));
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
});

run("creator ID/username collision is refused without modifying a real Operations row", async tx => {
  await tx.insert(s.opsUsers).values({ ...providerFixtureOwner, id: randomUUID(), isActive: true,
    name: "حساب مختلف", passwordHash: "test-only", createdAt: time });
  const before = await fixtureTableSnapshot(tx);
  await assert.rejects(seed(tx), /creator identity collision/);
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
});

run("inactive references or missing compatible manual vehicle fail without repairing any data", async tx => {
  await tx.update(s.fuelTypes).set({ isActive: false }).where(eq(s.fuelTypes.id, fixture("inspection-incompatible").capabilities.fuelTypeId));
  const before = await fixtureTableSnapshot(tx);
  await assert.rejects(seed(tx), /active references/);
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
});

test("provider fixtures never create/replace missing account or vehicle prerequisite", () => withManualSeedIsolation(async tx => {
  const before = await fixtureTableSnapshot(tx);
  await assert.rejects(seed(tx), /manual test vehicle required/);
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
}));

run("safe removal affects only six fixture graphs, keeps accounts/references/inactive creator, and supports repeat remove/reseed", async tx => {
  const before = await fixtureTableSnapshot(tx);
  await seed(tx);
  assert.deepEqual(await remove(tx), { removed: 6, creatorRetained: true });
  const after = await fixtureTableSnapshot(tx);
  for (const [name, original] of Object.entries(before)) {
    if (name === "ops_users") assert.equal(after[name].count, original.count + 1);
    else assert.deepEqual(after[name], original, name);
  }
  assert.equal((await remove(tx)).removed, 0);
  const reseed = await seed(tx);
  assert.equal(reseed.providers.inserted, 6); assert.equal(reseed.creator.inserted, 0);
});

run("removal refuses linked notifications and preserves ALL registered/guest service history", async tx => {
  await seed(tx);
  await tx.transaction(async inner => confirm(inner, await user(inner),
    { ...route, providerId: fixture("towing-a-map").provider.id, acceptedTerms: true }, "towing", time));
  const before = await fixtureTableSnapshot(tx);
  await assert.rejects(remove(tx), /linked history/);
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
});

run("removal refuses a fixture-looking ID owned by another creator, never deleting unrelated provider data", async tx => {
  await seed(tx);
  const ops = randomUUID();
  await tx.insert(s.opsUsers).values({ id: ops, name: "منشئ آخر", username: "other",
    role: "operations", passwordHash: "test-only", createdAt: time });
  await tx.update(s.providers).set({ createdBy: ops }).where(eq(s.providers.id, fixture("inspection-map").provider.id));
  const before = await fixtureTableSnapshot(tx);
  await assert.rejects(remove(tx), /identity collision/);
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
});

test("all fixture tests leave all 24 real tables content unchanged", async () => {
  assert.ok(JSON.stringify(await fixtureTableSnapshot()) === JSON.stringify(baseline), "Real data changed");
});