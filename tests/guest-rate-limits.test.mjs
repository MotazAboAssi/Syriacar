import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import * as s from "../src/server/db/schema.ts";
import { securityRateLimits as rates } from "../src/server/db/security-rate-limits.ts";
import { closeDatabase } from "../src/server/db/client.ts";
import { GuestLimits, guestScopes as scopes, globalIdentity, guestTransaction } from "../src/modules/guest-security/rate-limits.ts";
import { inspectionHandlers } from "../src/modules/guest-inspection/http.ts";
import { towingHandlers } from "../src/modules/guest-towing/http.ts";
import { fixtureTableSnapshot } from "./fixtures/manual-seed-isolation.mjs";
import { withGuestScratch, bucket, counts, setCount, request, result, hash, runtime } from "./fixtures/guest-rate-scratch.mjs";

after(closeDatabase);
const run = (name, check) => test(name, { timeout: 60000 }, () => withGuestScratch(check));
const snapshot = async db => (await db.select().from(rates)).sort((a, b) =>
  (a.scope + a.keyHash).localeCompare(b.scope + b.keyHash));
function rejected(r, status) {
  assert.equal(r.status, status);
  assert.deepEqual(Object.keys(r.data), ["error"]);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.getSetCookie().length, 0);
  if (status === 429) {
    assert.match(r.headers.get("retry-after"), /^[1-9]\d*$/);
    assert.ok(Number(r.headers.get("retry-after")) <= 3600);
  }
}

run("Guest policy has exactly phone10, notification40, application20 and no IP/parent notification identity", async f => {
  const limits = new GuestLimits(), p = f.phone();
  assert.deepEqual(limits.budgets(p, true, true).map(b => [b.scope, b.identity, b.limit, b.seconds]), [
    [scopes.parentGlobal, globalIdentity, 20, 3600], [scopes.parentPhone, p, 10, 3600],
    [scopes.notificationPhone, p, 40, 3600],
  ]);
  assert.deepEqual(limits.budgets(p, false, true).map(b => b.scope), [scopes.notificationPhone]);
  assert.deepEqual(limits.budgets(p, true, false).map(b => b.scope), [scopes.parentGlobal, scopes.parentPhone]);
});

run("parent phone10 is shared across Inspection/Towing, normalized phones and untrusted headers", async f => {
  const p = f.phone();
  for (let i = 0; i < 10; i++) {
    const kind = i % 2 ? "inspection" : "towing";
    const body = { ...f[kind](p), guestPhone: " " + p + " ", guestName: "Guest " + i };
    const r = await f.create(kind, body, { "X-Forwarded-For": "forged-" + i, "X-Real-IP": "arbitrary" });
    assert.equal(r.status, 201);
  }
  const before = await snapshot(f.db);
  rejected(await f.create("inspection", f.inspection(p)), 429);
  assert.deepEqual(await snapshot(f.db), before, "later bucket rejection rolls back notification/global increments");
  assert.deepEqual(await counts(f.db), { parents: 10, notifications: 10 });
  assert.equal((await bucket(f.db, scopes.parentPhone, p)).count, 10);
  assert.equal((await bucket(f.db, scopes.parentGlobal, globalIdentity)).count, 10);
  assert.equal((await bucket(f.db, scopes.notificationPhone, p)).count, 10);
  assert.equal((await f.create("inspection", f.inspection())).status, 201, "another phone still works below global20");
});

run("global20 counts Guest service_request inserts across both services including no-match, not notices", async f => {
  for (let i = 0; i < 20; i++) {
    const r = i % 3 === 0 ? await f.create("inspection", f.inspection(f.phone(), false))
      : await f.create(i % 2 ? "inspection" : "towing", f[i % 2 ? "inspection" : "towing"]());
    assert.equal(r.status, 201);
  }
  assert.deepEqual(await counts(f.db), { parents: 20, notifications: 13 });
  const before = await snapshot(f.db);
  for (const kind of ["inspection", "towing"]) rejected(await f.create(kind, f[kind]()), 429);
  assert.deepEqual(await snapshot(f.db), before, "rejected new phones create no partial buckets");
  assert.equal((await bucket(f.db, scopes.parentGlobal, globalIdentity)).count, 20);
  assert.deepEqual(await counts(f.db), { parents: 20, notifications: 13 });
  assert.ok(before.every(r => /^[0-9a-f]{64}$/.test(r.keyHash)));
});

run("no-match debits both creation scopes but no notification scope", async f => {
  const p = f.phone(), r = await f.create("inspection", f.inspection(p, false));
  assert.equal(r.status, 201); assert.equal(r.data.notificationId, null);
  assert.equal((await bucket(f.db, scopes.parentGlobal, globalIdentity)).count, 1);
  assert.equal((await bucket(f.db, scopes.parentPhone, p)).count, 1);
  assert.equal(await bucket(f.db, scopes.notificationPhone, p), undefined);
});

run("existing proof allows more than20 notices; notification40 is shared with Inspection and counts the first", async f => {
  const p = f.phone(), input = f.towing(p), first = await f.create("towing", input);
  const existing = { ...input, requestProof: first.data.requestProof };
  assert.equal((await bucket(f.db, scopes.notificationPhone, p)).count, 1);
  for (let i = 1; i < 22; i++) assert.equal((await f.create("towing", {
    ...existing, providerId: i % 2 ? f.ids.partial : f.ids.towing,
  })).status, 201);
  assert.equal((await bucket(f.db, scopes.parentGlobal, globalIdentity)).count, 1);
  assert.equal((await bucket(f.db, scopes.parentPhone, p)).count, 1);
  await setCount(f.db, scopes.notificationPhone, p, 39);
  assert.equal((await f.create("inspection", f.inspection(p))).status, 201);
  const before = await snapshot(f.db), business = await counts(f.db);
  rejected(await f.create("towing", existing), 429);
  rejected(await f.create("inspection", f.inspection(p)), 429);
  assert.deepEqual(await counts(f.db), business);
  assert.deepEqual(await snapshot(f.db), before);
  assert.ok((await snapshot(f.db)).every(r => Object.values(scopes).includes(r.scope)));
});

run("global exhaustion blocks new parents, never existing-parent notification or manual location", async f => {
  const input = f.towing(), first = await f.create("towing", { ...input, providerId: f.ids.partial });
  await setCount(f.db, scopes.parentGlobal, globalIdentity, 20);
  const next = await f.create("towing", { ...input, requestProof: first.data.requestProof });
  assert.equal(next.status, 201); assert.equal(next.data.requestId, first.data.requestId);
  assert.equal(next.data.matchingStatus, "matched");
  assert.equal((await bucket(f.db, scopes.parentGlobal, globalIdentity)).count, 20);
  assert.equal((await bucket(f.db, scopes.parentPhone, input.guestPhone)).count, 1);
  const before = await snapshot(f.db);
  const location = await result(f.api.towing.location(request("towing", {
    requestProof: first.data.requestProof, notificationId: next.data.notificationId,
    governorateId: f.gov, regionId: f.region,
  }, "location")));
  assert.equal(location.status, 200);
  assert.deepEqual(await snapshot(f.db), before);
  rejected(await f.create("towing", f.towing()), 429);
});

run("notice quota denial cannot upgrade existing no-match, change proof or emit a fresh URL", async f => {
  const input = f.towing(), first = await f.create("towing", { ...input, providerId: f.ids.partial });
  await setCount(f.db, scopes.notificationPhone, input.guestPhone, 40);
  const before = await f.db.select().from(s.serviceRequests);
  rejected(await f.create("towing", { ...input, requestProof: first.data.requestProof }), 429);
  assert.deepEqual(await f.db.select().from(s.serviceRequests), before);
  assert.equal(first.data.matchingStatus, "no_match");
  assert.deepEqual(await counts(f.db), { parents: 1, notifications: 1 });
});

run("invalid/mismatched proof, stale provider and malformed/oversized input create no victim debit", async f => {
  const input = f.towing(), first = await f.create("towing", input), before = await snapshot(f.db);
  for (const change of [{ requestProof: "forged" },
    { requestProof: first.data.requestProof, guestPhone: f.phone() },
    { requestProof: first.data.requestProof, guestName: "Changed" },
    { requestProof: first.data.requestProof, originGovernorateId: f.otherGov }]) {
    const r = await f.create("towing", { ...input, ...change });
    assert.ok([403, 409].includes(r.status));
  }
  assert.equal((await f.create("inspection", { ...f.inspection(), providerId: randomUUID() })).status, 409);
  for (const kind of ["inspection", "towing"]) {
    for (const [body, type, status] of [["{", "application/json", 422], ["{}", "text/plain", 422],
      [JSON.stringify({ guestName: "x".repeat(9000) }), "application/json", 413]]) {
      assert.equal((await f.api[kind].create(new Request("https://guest-verification.example/api/test", {
        method: "POST", headers: { "Content-Type": type }, body,
      }))).status, status);
    }
    assert.equal((await f.create(kind, { ...f[kind](), acceptedTerms: false })).status, 422);
  }
  assert.deepEqual(await snapshot(f.db), before);
});

run("browsing has no quota rows", async f => {
  assert.equal((await f.api.inspection.localities(new Request("https://guest-verification.example/api/?governorateId=" + f.gov))).status, 200);
  assert.equal((await f.api.inspection.providers(new Request(
    `https://guest-verification.example/api/?governorateId=${f.gov}&regionId=${f.region}`))).status, 200);
  assert.equal((await f.api.towing.providers(new Request(
    `https://guest-verification.example/api/?originGovernorateId=${f.gov}&destGovernorateId=${f.otherGov}`))).status, 200);
  assert.deepEqual(await snapshot(f.db), []);
});

run("PG-only window expiry and stable Retry-After; Node clock cannot reset Guest quotas", async f => {
  const p = f.phone();
  await setCount(f.db, scopes.parentPhone, p, 10);
  const api = inspectionHandlers(() => f.db, { ...runtime, now: () => new Date("2099-01-01Z") });
  const before = await snapshot(f.db);
  rejected(await result(api.create(request("inspection", f.inspection(p, false)))), 429);
  assert.deepEqual(await snapshot(f.db), before);
  await f.db.execute(sql`UPDATE ${rates} SET window_expires_at=NOW()-INTERVAL '1 second',
    retire_at=NOW()+INTERVAL '1 hour' WHERE scope=${scopes.parentPhone} AND key_hash=${hash(scopes.parentPhone,p)}`);
  assert.equal((await f.create("inspection", f.inspection(p, false))).status, 201);
  assert.equal((await bucket(f.db, scopes.parentPhone, p)).count, 1);
});

for (const kind of ["inspection", "towing"]) {
  for (const phase of ["missing table", "read", "insert", "update", "commit", "cleanup"]) {
    run(`${kind}: real PG ${phase} fault is503 with zero committed business/quota writes`, async f => {
      if (phase === "missing table") await f.db.execute(sql.raw(`DROP TABLE "${f.name}".security_rate_limits`));
      else if (phase === "read") await f.db.execute(sql.raw(`ALTER TABLE "${f.name}".security_rate_limits RENAME COLUMN count TO broken_count`));
      else {
        await f.db.execute(sql.raw(`CREATE FUNCTION "${f.name}".fail_guest() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'isolated database fault' USING ERRCODE='58000'; END $$`));
        if (phase === "cleanup") await f.db.execute(sql`INSERT INTO ${rates} VALUES
          ('expired',${"a".repeat(64)},1,NOW()-INTERVAL '3 hours',NULL,NOW()-INTERVAL '2 hours')`);
        const deferred = phase === "commit", event = phase === "insert" || deferred ? "INSERT"
          : phase === "cleanup" ? "DELETE" : "UPDATE";
        await f.db.execute(sql.raw(`CREATE ${deferred ? "CONSTRAINT " : ""}TRIGGER fail_guest_trigger
          AFTER ${event} ON "${f.name}".security_rate_limits ${deferred ? "DEFERRABLE INITIALLY DEFERRED" : ""}
          FOR EACH ROW EXECUTE FUNCTION "${f.name}".fail_guest()`));
      }
      rejected(await f.create(kind, f[kind]()), 503);
      assert.deepEqual(await counts(f.db), { parents: 0, notifications: 0 });
      if (!["missing table","read"].includes(phase)) assert.equal((await snapshot(f.db)).length, phase === "cleanup" ? 1 : 0);
    });
  }
}

run("notification INSERT and deferred business commit failures roll back complete creation and quotas", async f => {
  await f.db.execute(sql.raw(`CREATE FUNCTION "${f.name}".fail_notice() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'isolated business fault' USING ERRCODE='58000'; END $$`));
  for (const deferred of [false, true]) {
    await f.db.execute(sql.raw(`CREATE ${deferred ? "CONSTRAINT " : ""}TRIGGER fail_notice_trigger
      AFTER INSERT ON "${f.name}".notifications ${deferred ? "DEFERRABLE INITIALLY DEFERRED" : ""}
      FOR EACH ROW EXECUTE FUNCTION "${f.name}".fail_notice()`));
    for (const kind of ["inspection","towing"]) rejected(await f.create(kind, f[kind]()), 503);
    assert.deepEqual(await counts(f.db), { parents: 0, notifications: 0 });
    assert.deepEqual(await snapshot(f.db), []);
    await f.db.execute(sql.raw(`DROP TRIGGER fail_notice_trigger ON "${f.name}".notifications`));
  }
});

run("fault during existing-parent notification rolls back matching upgrade and prior quota state exactly", async f => {
  const input = f.towing(), first = await f.create("towing", { ...input, providerId: f.ids.partial });
  const before = await snapshot(f.db), parents = await f.db.select().from(s.serviceRequests);
  await f.db.execute(sql.raw(`CREATE FUNCTION "${f.name}".fail_existing() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'isolated commit fault' USING ERRCODE='58000'; END $$`));
  await f.db.execute(sql.raw(`CREATE CONSTRAINT TRIGGER fail_existing_trigger AFTER INSERT ON "${f.name}".notifications
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.name}".fail_existing()`));
  rejected(await f.create("towing", { ...input, requestProof: first.data.requestProof }), 503);
  assert.deepEqual(await snapshot(f.db), before);
  assert.deepEqual(await f.db.select().from(s.serviceRequests), parents);
  assert.deepEqual(await counts(f.db), { parents: 1, notifications: 1 });
});

run("connection/config failure503 vs programming500; no in-memory fallback", async f => {
  for (const factory of [inspectionHandlers,towingHandlers]) {
    for (const fault of [Object.assign(new Error("connect fault"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("config fault"), { name: "DatabaseConfigurationError" })]) {
      const api = factory(() => { throw fault; }, runtime);
      rejected(await result(api.create(request("inspection", f.inspection()))), 503);
    }
    const api = factory(() => { throw new TypeError("programming fault"); }, runtime);
    rejected(await result(api.create(request("inspection", f.inspection()))), 500);
  }
  assert.deepEqual(await snapshot(f.db), []);
});

test("committed private Guest fixtures preserve genuine public business content", async () => {
  const before = await fixtureTableSnapshot();
  await withGuestScratch(async f => assert.equal((await f.create("inspection", f.inspection())).status, 201));
  assert.deepEqual(await fixtureTableSnapshot(), before);
});