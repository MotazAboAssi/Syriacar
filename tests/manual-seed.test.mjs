import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { eq, sql } from "drizzle-orm";
import { getDatabase, closeDatabase } from "../src/server/db/client.ts";
import * as s from "../src/server/db/schema.ts";
import { seedReferenceData } from "../src/server/db/seed/seed.ts";
import { seedManualScenarios } from "../src/server/db/seed/manual-scenarios.ts";
import { manualScenarios, manualTestPassword, manualLocality } from "../src/server/db/seed/manual-scenario-data.ts";
import { assertManualSeedEnvironment, targetFingerprint } from "../src/server/db/seed/manual-seed-safety.ts";
import { accountHandlers } from "../src/modules/account/http.ts";
import { registeredHandlers } from "../src/modules/registered-services/http.ts";
import { AccountLimits } from "../src/modules/account/rate-limits.ts";
import { checkPassword } from "../src/modules/account/security.ts";
import { req, parsed, accountSnapshot } from "./fixtures/account.mjs";

after(closeDatabase);
// npm test does not set NODE_ENV. Declare this isolated test process explicitly;
// never override a production or published runtime marker.
process.env.NODE_ENV ??= "test";
// Same rollback-only isolated frozen-schema pattern as existing foundation tests;
// no DDL or deletes touch application tables, including when rerun after real seeding.
const migration = await readFile(new URL("../drizzle/0000_database_foundation.sql", import.meta.url), "utf8");
const infraMigration = await readFile(new URL("../drizzle/0001_security_rate_limits.sql", import.meta.url), "utf8");
const baseline = await accountSnapshot();
const options = { confirmDevelopment: true };
async function isolated(check) {
  const rollback = new Error("ROLLBACK_MANUAL_SEED_TEST");
  try {
    await getDatabase().transaction(async tx => {
      const schema = `verify_manual_${randomUUID().replaceAll("-", "")}`;
      await tx.execute(sql.raw(`CREATE SCHEMA "${schema}"`));
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schema}", public`));
      for (const statement of (migration + "\n--> statement-breakpoint\n" + infraMigration)
        .replaceAll('"public"', `"${schema}"`).split("--> statement-breakpoint").filter(x => x.trim())) {
        await tx.execute(sql.raw(statement));
      }
      await seedReferenceData(tx);
      await check(tx);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
}
const seed = tx => seedManualScenarios(options, tx);
const run = (name, check) => test(name, () => isolated(check));
const allUsers = tx => tx.select().from(s.users).orderBy(s.users.id);
const allVehicles = tx => tx.select().from(s.vehicles).orderBy(s.vehicles.id);
const runtime = { secret: "manual-seed-test-only-signing-key", now: () => new Date(),
  sender: async () => { assert.fail("Seed/login must never invoke Whapi/OTP"); } };

test("manual seed fails closed for production/published/unknown modes and missing opt-in", () => {
  for (const env of [
    {}, { NODE_ENV: "production" }, { NODE_ENV: "staging" },
    { NODE_ENV: "development", REPLIT_DEPLOYMENT: "1" },
    { NODE_ENV: "test", REPLIT_DEPLOYMENT: "" },
  ]) assert.throws(() => assertManualSeedEnvironment(env, true));
  assert.throws(() => assertManualSeedEnvironment({ NODE_ENV: "development" }, false));
  for (const NODE_ENV of ["development", "test"]) assert.doesNotThrow(() => assertManualSeedEnvironment({ NODE_ENV }, true));
  assert.doesNotThrow(() => assertManualSeedEnvironment({ NODE_ENV: "development", REPLIT_ENVIRONMENT: "production" }, true),
    "Infrastructure metadata is not proof of a published app; documented deployment flag and pinned DB still apply");
  assert.equal(targetFingerprint("postgres://a:x@localhost/test"), targetFingerprint("postgresql://b:y@localhost:5432/test"));
  assert.notEqual(targetFingerprint("postgres://localhost/development"), targetFingerprint("postgres://localhost/production"));
});

test("real CLI production/changed target/missing confirmation refused BEFORE any database connection", () => {
  for (const [NODE_ENV, flags, extra] of [
    ["production", ["--manual-scenarios", "--confirm-development"], {}],
    ["development", ["--manual-scenarios", "--confirm-development"], { REPLIT_DEPLOYMENT: "1" }],
    ["test", ["--manual-scenarios", "--confirm-development"], {}],
    ["development", ["--manual-scenarios"], {}],
  ]) {
    const result = spawnSync(process.execPath, ["--conditions=react-server", "src/server/db/seed/seed-cli.ts", ...flags], {
      env: { ...process.env, NODE_ENV, DATABASE_URL: "postgresql://127.0.0.1:1/unapproved-target", ...extra },
      encoding: "utf8", timeout: 12000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no partial seed committed/);
    assert.doesNotMatch(result.stderr, /unapproved-target|ECONNREFUSED/);
  }
});

run("six active accounts/four vehicles have Arabic names, actual Argon2 passwords and exact approved states", async tx => {
  const result = await seed(tx);
  assert.deepEqual(result.users, { inserted: 6, preserved: 0 });
  assert.deepEqual(result.vehicles, { inserted: 4, preserved: 0 });
  const users = await allUsers(tx), vehicles = await allVehicles(tx);
  assert.equal(users.length, 6); assert.equal(vehicles.length, 4);
  for (const scenario of manualScenarios) {
    const user = users.find(u => u.id === scenario.id);
    assert.equal(user.isActive, true); assert.equal(user.isDeleted, false);
    assert.equal(user.name, scenario.name); assert.equal(user.phone, scenario.phone);
    assert.match(user.passwordHash, /^\$argon2id\$/);
    assert.equal(await checkPassword(manualTestPassword, user.passwordHash), true);
    assert.notEqual(user.passwordHash, manualTestPassword);
    const owned = vehicles.filter(v => v.userId === user.id);
    assert.equal(owned.length, scenario.vehicle ? 1 : 0);
    if (owned.length) assert.equal(owned[0].verificationStatus, scenario.vehicle.verificationStatus);
  }
  for (const table of [s.otpVerificationChallenges, s.providers, s.opsUsers, s.serviceRequests, s.notifications]) {
    assert.equal((await tx.select().from(table)).length, 0);
  }
});

run("repeat runs preserve IDs/hashes/timestamps and all manual vehicle/home edits, without duplicates", async tx => {
  await seed(tx);
  const home = manualScenarios.find(x => x.key === "towing-home");
  const rejected = manualScenarios.find(x => x.key === "rejected");
  await tx.update(s.users).set({ homeGovernorateId: null }).where(eq(s.users.id, home.id));
  await tx.update(s.vehicles).set({ color: "لون عدّله المستطلع", verificationStatus: "pending_verification" })
    .where(eq(s.vehicles.id, rejected.vehicle.id));
  const users = await allUsers(tx), vehicles = await allVehicles(tx);
  const result = await seed(tx);
  assert.deepEqual(result.users, { inserted: 0, preserved: 6 });
  assert.deepEqual(result.vehicles, { inserted: 0, preserved: 4 });
  assert.deepEqual(await allUsers(tx), users); assert.deepEqual(await allVehicles(tx), vehicles);
});

run("unchanged existing reference seed creates no manual accounts", async tx => {
  await seedReferenceData(tx);
  assert.equal((await allUsers(tx)).length, 0);
  assert.equal((await allVehicles(tx)).length, 0);
});

run("ordinary login and registered APIs accept these accounts, preserve rejected/empty/no-match/home rules without OTP", async tx => {
  await seed(tx);
  const api = accountHandlers(() => tx, runtime, new AccountLimits());
  const registered = registeredHandlers(() => tx, runtime);
  for (const scenario of manualScenarios) {
    const login = await parsed(await api.login(req("login", "POST", { phone: scenario.phone, password: manualTestPassword })));
    assert.equal(login.status, 200); assert.ok(login.cookie);
    const vehicles = await parsed(await api.vehicles(req("vehicles", "GET", undefined, login.cookie)));
    assert.equal(vehicles.data.length, scenario.vehicle ? 1 : 0);
    if (scenario.vehicle) {
      const q = new URLSearchParams({ vehicleId: scenario.vehicle.id, ...manualLocality });
      const response = await registered.providers(new Request("https://account-verification.example/api/inspection/providers?" + q, {
        headers: { Cookie: login.cookie },
      }));
      assert.equal(response.status, scenario.key === "rejected" ? 422 : 200);
      if (scenario.key === "no-match") assert.equal((await response.json()).providers.filter(p => p.suitable).length, 0);
    }
    if (scenario.key === "towing-home") {
      const profile = await parsed(await api.profile(req("profile", "GET", undefined, login.cookie)));
      assert.equal(profile.data.homeGovernorateId, manualLocality.governorateId);
    }
  }
  assert.equal((await tx.select().from(s.otpVerificationChallenges)).length, 0);
});

run("real phone collision late in seed rolls back all earlier inserts and never overwrites real user", async tx => {
  const id = randomUUID(), time = new Date(), phone = manualScenarios.at(-1).phone;
  await tx.insert(s.users).values({ id, name: "مستخدم آخر يجب حفظه", phone, passwordHash: "fixture-not-credential",
    createdAt: time, lastActiveAt: time, isActive: true });
  const before = await allUsers(tx);
  await assert.rejects(seed(tx), /collision/);
  assert.deepEqual(await allUsers(tx), before);
  assert.equal((await allVehicles(tx)).length, 0);
});

run("vehicle ID collision belonging to another user cannot overwrite or reassign ownership", async tx => {
  const id = randomUUID(), time = new Date();
  await tx.insert(s.users).values({ id, name: "حساب آخر", phone: "+963900099999", passwordHash: "fixture",
    createdAt: time, lastActiveAt: time, isActive: true });
  await tx.insert(s.vehicles).values({ ...manualScenarios[0].vehicle, userId: id, createdAt: time });
  const users = await allUsers(tx), vehicles = await allVehicles(tx);
  await assert.rejects(seed(tx), /Vehicle identity collision/);
  assert.deepEqual(await allUsers(tx), users); assert.deepEqual(await allVehicles(tx), vehicles);
});

run("disabled fixture aborts without restoring or changing existing users", async tx => {
  await seed(tx);
  await tx.update(s.users).set({ isActive: false }).where(eq(s.users.id, manualScenarios[0].id));
  const users = await allUsers(tx), vehicles = await allVehicles(tx);
  await assert.rejects(seed(tx), /modified fixture/);
  assert.deepEqual(await allUsers(tx), users); assert.deepEqual(await allVehicles(tx), vehicles);
});

run("inactive references abort with no accounts and without repairing Operations reference data", async tx => {
  await tx.update(s.governorates).set({ isActive: false }).where(eq(s.governorates.id, manualLocality.governorateId));
  await assert.rejects(seed(tx), /reference data missing/);
  assert.equal((await allUsers(tx)).length, 0);
  const [gov] = await tx.select().from(s.governorates).where(eq(s.governorates.id, manualLocality.governorateId));
  assert.equal(gov.isActive, false);
});

run("a capable even currently-closed provider aborts no-match scenario without changing provider or leaving accounts", async tx => {
  const ops = randomUUID(), p = randomUUID(), time = new Date();
  await tx.insert(s.opsUsers).values({ id: ops, name: "مشغل اختبار", username: "isolated-fixture",
    passwordHash: "fixture", role: "operations", createdAt: time });
  await tx.insert(s.providers).values({ id: p, businessName: "مزود لا يجوز تغييره", phone: "+963900099998",
    whatsappNumber: "+963900099997", passwordHash: "fixture", serviceType: "inspection", status: "active",
    governorateId: manualLocality.governorateId, regionId: manualLocality.regionId,
    createdAt: time, createdBy: ops, todayClosed: true, todayClosedDate: "2026-10-04" });
  const v = manualScenarios.find(x => x.key === "no-match").vehicle;
  for (const [table, key] of [[s.providerBrandGroups, "brandGroupId"], [s.providerBrands, "brandId"],
    [s.providerYearCategories, "yearCategory"], [s.providerFuelTypes, "fuelTypeId"], [s.providerVehicleCategories, "vehicleCategory"]]) {
    await tx.insert(table).values({ providerId: p, [key]: v[key] });
  }
  const providers = await tx.select().from(s.providers);
  await assert.rejects(seed(tx), /No-match scenario has a capable provider/);
  assert.equal((await allUsers(tx)).length, 0); assert.equal((await allVehicles(tx)).length, 0);
  assert.deepEqual(await tx.select().from(s.providers), providers);
});

test("all isolated manual seed tests roll back without changing genuine user/vehicle/OTP/request/notification data", async () => {
  assert.deepEqual(await accountSnapshot(), baseline);
});