import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { closeDatabase } from "../src/server/db/client.ts";
import * as s from "../src/server/db/schema.ts";
import { withManualSeedIsolation, fixtureTableSnapshot } from "./fixtures/manual-seed-isolation.mjs";
import { seedManualScenarios } from "../src/server/db/seed/manual-scenarios.ts";
import { seedProviderFixtures } from "../src/server/db/seed/provider-fixtures.ts";
import { seedProviderLoginFixtures } from "../src/server/db/seed/provider-login-fixtures.ts";
import { restoreManualFixtures } from "../src/server/db/seed/restore-manual-fixtures.ts";
import { providerLoginFixtures, providerLoginNoticeId } from "../src/server/db/seed/provider-login-fixture-data.ts";
import { manualScenarios, manualTestPassword } from "../src/server/db/seed/manual-scenario-data.ts";
import { providerHandlers } from "../src/modules/provider-management/http.ts";
import { providerSessionCookie } from "../src/modules/provider-management/security.ts";
import { accountHandlers } from "../src/modules/account/http.ts";
import { req, parsed } from "./fixtures/provider.mjs";

const options = { confirmDevelopment: true }, baseline = await fixtureTableSnapshot();
after(async () => {
  try { assert.deepEqual(await fixtureTableSnapshot(), baseline); }
  finally { await closeDatabase(); }
});
const run = (name, check) => test(name, () => withManualSeedIsolation(async tx => {
  await seedManualScenarios(options, tx);
  await seedProviderFixtures(options, tx);
  await check(tx);
}));

test("preparation CLI refuses production, published runtime, wrong DB and absent confirmation before connecting", () => {
  for (const [NODE_ENV, flags, extra] of [
    ["production", ["--confirm-development"], {}],
    ["development", ["--confirm-development"], { REPLIT_DEPLOYMENT: "1" }],
    ["development", ["--confirm-development"], {}],
    ["development", [], {}],
  ]) {
    const r = spawnSync(process.execPath, ["--conditions=react-server", "src/server/db/seed/test-account-setup-cli.ts", ...flags],
      { env: { ...process.env, NODE_ENV, DATABASE_URL: "postgres://127.0.0.1:1/notapproved", ...extra },
        encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 1); assert.match(r.stderr, /preparation refused/);
    assert.doesNotMatch(r.stderr, /ECONNREFUSED|notapproved/);
  }
});
test("copied test identities cannot login, register or read authenticated data outside approved development", () => {
  const program = `
    import assert from 'node:assert/strict';
    import * as account from './src/modules/account/service.ts';
    import * as provider from './src/modules/provider-management/service.ts';
    import {manualScenarios} from './src/server/db/seed/manual-scenario-data.ts';
    import {providerLoginFixtures} from './src/server/db/seed/provider-login-fixture-data.ts';
    const db={transaction(){assert.fail('DB touched')},select(){assert.fail('DB touched')}};
    const rejected=e=>e.status===403;
    for(const row of manualScenarios) {
      await assert.rejects(account.login({phone:row.phone,password:'test'},db,{},{}),rejected);
      await assert.rejects(account.register({name:'test',phone:row.phone,password:'test-password'},db,{},{}),rejected);
      await assert.rejects(account.authenticatedUser(row.id,db),rejected);
    }
    for(const row of providerLoginFixtures) {
      await assert.rejects(provider.login({phone:row.phone,password:'test'},db,{},{}),rejected);
      await assert.rejects(provider.activeProvider(db,row.id),rejected);
    }
  `;
  for (const extra of [{ NODE_ENV: "production" }, { NODE_ENV: "test", REPLIT_DEPLOYMENT: "1" },
    { NODE_ENV: "test", DATABASE_URL: "postgres://127.0.0.1:1/notapproved" }]) {
    const r = spawnSync(process.execPath, ["--conditions=react-server", "--input-type=module", "--eval", program],
      { env: { ...process.env, ...extra }, encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, "Runtime fixture fence must reject all tested identities before database access");
  }
});
test("setup function rejects missing confirmation before supplied DB", async () => {
  await assert.rejects(seedProviderLoginFixtures({ confirmDevelopment: false }, {
    transaction() { assert.fail("Must not connect"); },
  }), /confirmation/);
});
run("existing Active is reused, only Pending/Disabled inserted, all matching graphs and Operations preserved", async tx => {
  const before = await fixtureTableSnapshot(tx), result = await seedProviderLoginFixtures(options, tx);
  assert.deepEqual(result.providers, { inserted: 2, reused: 1 });
  const after = await fixtureTableSnapshot(tx);
  for (const name of Object.keys(before)) if (!["providers", "service_requests", "notifications"].includes(name))
    assert.deepEqual(after[name], before[name], name);
  assert.equal(after.providers.count - before.providers.count, 2);
  assert.equal(after.notifications.count - before.notifications.count, 1);
  await seedProviderFixtures(options, tx); // Legacy matching fixture management still accepts reused identity.
});
run("repeated preparation is idempotent; no duplicate accounts/notifications", async tx => {
  await seedProviderLoginFixtures(options, tx);
  const before = await fixtureTableSnapshot(tx), again = await seedProviderLoginFixtures(options, tx);
  assert.deepEqual(again.providers, { inserted: 0, reused: 3 });
  const after = await fixtureTableSnapshot(tx);
  for (const name of Object.keys(before)) if (name !== "providers") assert.deepEqual(after[name], before[name], name);
  assert.equal(after.providers.count, before.providers.count);
  assert.equal(again.requestsInserted, 0); assert.equal(again.notificationsInserted, 0);
});
run("all six user credentials work with original vehicle verification scenarios", async tx => {
  const api = accountHandlers(() => tx);
  for (const scenario of manualScenarios) {
    const result = await parsed(api.login(req("/login", "POST", { phone: scenario.phone, password: manualTestPassword })));
    assert.equal(result.status, 200);
    const vehicles = await tx.select().from(s.vehicles).where(eq(s.vehicles.userId, scenario.id));
    assert.equal(vehicles.length, scenario.vehicle ? 1 : 0);
    if (scenario.vehicle) assert.equal(vehicles[0].verificationStatus, scenario.vehicle.verificationStatus);
  }
});
run("explicit restoration repairs only marked fixture vehicle fields and preserves unrelated rows", async tx => {
  const fixture = manualScenarios[0], before = await fixtureTableSnapshot(tx);
  await tx.update(s.vehicles).set({ verificationStatus: "pending_verification", year: 1995 })
    .where(eq(s.vehicles.id, fixture.vehicle.id));
  await restoreManualFixtures(options, tx);
  assert.deepEqual(await fixtureTableSnapshot(tx), before);
  await tx.update(s.vehicles).set({ notes: "not-a-fixture" }).where(eq(s.vehicles.id, fixture.vehicle.id));
  await assert.rejects(restoreManualFixtures(options, tx), /identity mismatch/);
});
run("Active login reads own real fixture notification; Pending/Disabled login denied", async tx => {
  await seedProviderLoginFixtures(options, tx);
  const api = providerHandlers(() => tx);
  for (const row of providerLoginFixtures) {
    const result = await parsed(api.login(req("/login", "POST", { phone: row.phone, password: manualTestPassword })));
    assert.equal(result.status, row.status === "active" ? 200 : 403);
    if (row.status === "active") {
      const cookie = result.headers.get("set-cookie").split(";")[0];
      assert.equal((await parsed(api.notification(req("/notifications/" + providerLoginNoticeId, "GET", undefined, cookie),
        providerLoginNoticeId))).status, 200);
    }
  }
});
run("test Disabled account rejects an already issued JWT on first request after disabling", async tx => {
  await seedProviderLoginFixtures(options, tx);
  const row = providerLoginFixtures[2];
  await tx.update(s.providers).set({ status: "active" }).where(eq(s.providers.id, row.id));
  const cookie = await providerSessionCookie(row.id), api = providerHandlers(() => tx);
  assert.equal((await parsed(api.profile(req("/profile", "GET", undefined, cookie)))).status, 200);
  await tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, row.id));
  assert.equal((await parsed(api.profile(req("/profile", "GET", undefined, cookie)))).status, 403);
});