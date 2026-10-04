import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { securityRateLimits as rates } from "../src/server/db/security-rate-limits.ts";
import * as s from "../src/server/db/schema.ts";
import { closeDatabase } from "../src/server/db/client.ts";
import { AccountLimits, scopes, accountTransaction } from "../src/modules/account/rate-limits.ts";
import { rateLimitHash } from "../src/modules/account/security.ts";
import { accountHandlers } from "../src/modules/account/http.ts";
import { sendChallenge } from "../src/modules/account/otp.ts";
import { withRateScratch } from "./fixtures/rate-limit-scratch.mjs";
import { fixtureTableSnapshot } from "./fixtures/manual-seed-isolation.mjs";
import { req, parsed, outcome, password } from "./fixtures/account.mjs";

after(closeDatabase);
const run = (name, check) => test(name, { timeout: 45000 }, () => withRateScratch(check));
const runtime = { secret: "scratch-only", now: () => new Date("2000-01-01Z") };
const admit = (db, limits, budget) => accountTransaction(db, tx => limits.admit(tx, [budget], runtime));
const bucket = async (db, scope, identity) => (await db.select().from(rates)
  .where(and(eq(rates.scope, scope), eq(rates.keyHash, rateLimitHash(scope, identity, runtime)))))[0];
const expire = (db, scope, identity) => db.execute(sql`UPDATE ${rates} SET
  window_expires_at = NOW() - INTERVAL '1 second', blocked_until = NULL, retire_at = NOW() + INTERVAL '1 hour'
  WHERE scope = ${scope} AND key_hash = ${rateLimitHash(scope, identity, runtime)}`);
function app(db, extra = {}) {
  let time = new Date(), code = 800000;
  const sends = [], sleeps = [], plans = [];
  const rt = { secret: "scratch-only", callbackSecret: "scratch-callback",
    now: () => new Date(time), code: () => String(++code),
    sleep: async ms => { sleeps.push(ms); time = new Date(time.getTime() + ms); },
    sender: async (phone, value) => { sends.push({ phone, code: value });
      return plans.shift() ?? outcome("api_accepted", "scratch-" + sends.length); }, ...extra };
  const limits = new AccountLimits(), api = accountHandlers(() => db, rt, limits);
  const phone = () => "+963" + String(100000000 + Math.floor(Math.random() * 800000000));
  return { api, rt, limits, sends, sleeps, plans, phone, advance: ms => { time = new Date(time.getTime() + ms); } };
}
// parsed expects a resolved Response; keep helpers explicitly asynchronous.
const register = async (f, p) => parsed(await f.api.register(req("register", "POST", { phone: p, name: "Scratch user", password })));
const verify = (f, p, r, code = f.sends.at(-1).code) => f.api.verify(req("otp", "POST",
  { phone: p, attemptId: r.data.attemptId ?? r.data.otp?.attemptId, code }, r.cookie));
const challenge = async (db, p) => (await db.select().from(s.otpVerificationChallenges)
  .where(eq(s.otpVerificationChallenges.phone, p))).sort((a, b) => b.createdAt - a.createdAt)[0];

run("one infra migration preserves frozen business snapshot and enforces six-column constraints", async ({ db }) => {
  const old = JSON.parse(await readFile(new URL("../drizzle/meta/0000_snapshot.json", import.meta.url)));
  const next = JSON.parse(await readFile(new URL("../drizzle/meta/0001_snapshot.json", import.meta.url)));
  for (const name of Object.keys(old.tables)) assert.deepEqual(next.tables[name], old.tables[name]);
  assert.deepEqual(next.enums, old.enums);
  assert.equal(Object.keys(next.tables).length, 25);
  assert.equal(getTableConfig(rates).columns.length, 6);
  assert.equal(getTableConfig(rates).foreignKeys.length, 0);
  const value = { scope: "test", keyHash: "a".repeat(64), count: 0,
    windowExpiresAt: new Date(), retireAt: new Date(Date.now() + 3600000) };
  for (const change of [{ keyHash: "RAW-PHONE" }, { count: -1 }, { retireAt: new Date(0) },
    { blockedUntil: new Date(Date.now() + 7200000) }]) {
    await assert.rejects(db.insert(rates).values({ ...value, ...change }));
  }
  await db.insert(rates).values(value);
  await assert.rejects(db.insert(rates).values(value));
});

run("concurrent first-create N/N+1, independent connections/objects/process and PG-only time", async ({ db, pool, name }) => {
  const limits = new AccountLimits(), identity = "+963900000011", budget = limits.budget("send", identity);
  const results = await Promise.all(Array.from({ length: 18 }, () =>
    admit(db, new AccountLimits(), budget).then(() => 200, e => e.status)));
  assert.equal(results.filter(x => x === 200).length, 5);
  assert.equal(results.filter(x => x === 429).length, 13);
  assert.equal((await bucket(db, scopes.send, identity)).count, 5);
  const clients = await Promise.all([pool.connect(), pool.connect()]);
  try {
    const counts = await Promise.all(clients.map(c => c.query(`SELECT count FROM "${name}".security_rate_limits`)));
    assert.deepEqual(counts.map(r => r.rows[0].count), [5, 5]);
  } finally { clients.forEach(c => c.release()); }
  const child = spawnSync(process.execPath, ["--conditions=react-server", "tests/fixtures/rate-limit-worker.mjs",
    name, identity, scopes.send, "5"], { timeout: 12000, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /status:429/);
  const before = await bucket(db, scopes.send, identity);
  await assert.rejects(admit(db, limits, budget), e => e.status === 429 && e.retryAfter > 3500 && e.retryAfter <= 3600);
  assert.deepEqual(await bucket(db, scopes.send, identity), before, "denial never extends deadlines");
  assert.ok(before.windowExpiresAt.getFullYear() > 2000, "Node fixture clock is irrelevant");
  await expire(db, scopes.send, identity);
  await admit(db, limits, budget);
  assert.equal((await bucket(db, scopes.send, identity)).count, 1);
});

run("sorted multi-key admission rolls back the entire group and active blocks survive window expiry", async ({ db }) => {
  const limits = new AccountLimits(), phone = "+963900000012", send = limits.budget("send", phone);
  for (let i = 0; i < 5; i++) await admit(db, limits, send);
  const before = await bucket(db, scopes.send, phone);
  await assert.rejects(accountTransaction(db, tx => limits.admit(tx,
    [send, limits.budget("registration", phone)], runtime)), e => e.status === 429);
  assert.equal(await bucket(db, scopes.registration, phone), undefined);
  assert.deepEqual(await bucket(db, scopes.send, phone), before);
  const second = "+963900000015";
  for (let i = 0; i < 3; i++) await admit(db, limits, limits.budget("registration", second));
  await assert.rejects(accountTransaction(db, tx => limits.admit(tx,
    [limits.budget("send", second), limits.budget("registration", second)], runtime)), e => e.status === 429);
  assert.equal(await bucket(db, scopes.send, second), undefined, "earlier UPDATE also rolls back on later denial");
  await db.execute(sql`UPDATE ${rates} SET window_expires_at = NOW() - INTERVAL '1 second',
    blocked_until = NOW() + INTERVAL '15 minutes', retire_at = NOW() + INTERVAL '75 minutes'`);
  await assert.rejects(admit(db, limits, send), e => e.status === 429 && e.retryAfter === 900);
});

run("login fifth failure commits; another instance/correct password cannot bypass or extend block", async ({ db }) => {
  const f = app(db), p = f.phone(), r = await register(f, p);
  assert.equal((await verify(f, p, r)).status, 200);
  const login = async (api, value) => parsed(await api.login(req("login", "POST", { phone: p, password: value })));
  for (let i = 1; i <= 5; i++) assert.equal((await login(f.api, "wrong")).status, i < 5 ? 401 : 429);
  const before = await bucket(db, scopes.login, p);
  assert.equal(before.count, 5);
  const b = accountHandlers(() => db, f.rt, new AccountLimits());
  assert.equal((await login(b, password)).status, 429);
  assert.equal((await login(b, "wrong")).status, 429);
  assert.deepEqual(await bucket(db, scopes.login, p), before);
  await db.execute(sql`UPDATE ${rates} SET window_expires_at = NOW() - INTERVAL '1 second'
    WHERE scope = ${scopes.login}`);
  assert.equal((await login(b, password)).status, 429, "window expiry cannot erase active block");
  await expire(db, scopes.login, p);
  assert.equal((await login(b, password)).status, 200);
  assert.equal((await bucket(db, scopes.login, p)).count, 0);
  const unknown = f.phone();
  assert.equal((await parsed(await b.login(req("login", "POST", { phone: unknown, password: "wrong" })))).status, 401);
  assert.equal((await bucket(db, scopes.login, unknown)).count, 1);
});

run("registration three/hour; changed untrusted IP headers do not change quota; duplicate charges no send", async ({ db }) => {
  const f = app(db), p = f.phone();
  for (let i = 0; i < 3; i++) {
    const r = await parsed(await f.api.register(req("register", "POST", { phone: p, name: "Scratch", password },
      undefined, { "X-Forwarded-For": "forged-" + i, "X-Real-IP": "anything-" + i })));
    assert.equal(r.status, 201);
  }
  const before = await challenge(db, p);
  assert.equal((await register(f, p)).status, 429);
  assert.deepEqual(await challenge(db, p), before);
  assert.equal(f.sends.length, 3);
  const other = f.phone(), r = await register(f, other);
  assert.equal(r.status, 201);
  assert.equal((await verify(f, other, r)).status, 200);
  assert.equal((await register(f, other)).status, 409);
  assert.equal((await register(f, other)).status, 409);
  assert.equal((await register(f, other)).status, 429);
  assert.equal((await bucket(db, scopes.registration, other)).count, 3);
  assert.equal((await bucket(db, scopes.send, other)).count, 1);
  assert.ok((await db.select().from(rates)).every(row => /^[0-9a-f]{64}$/.test(row.keyHash)));
});

run("composite first-send denial creates no user, challenge, registration debit or network call", async ({ db }) => {
  const f = app(db), p = f.phone();
  for (let i = 0; i < 5; i++) await admit(db, f.limits, f.limits.budget("send", p));
  const result = await register(f, p);
  assert.equal(result.status, 429); assert.equal(result.cookie, undefined);
  assert.equal((await db.select().from(s.users)).length, 0);
  assert.equal((await db.select().from(s.otpVerificationChallenges)).length, 0);
  assert.equal(await bucket(db, scopes.registration, p), undefined);
  assert.equal(f.sends.length, 0);
});

run("valid proof verification has phone30/hour plus challenge5; stale proof never charges victim", async ({ db }) => {
  const f = app(db), p = f.phone(), r = await register(f, p);
  for (let i = 0; i < 29; i++) await admit(db, f.limits, f.limits.budget("verify", p));
  const bad = await parsed(await verify(f, p, r, "malformed"));
  assert.equal(bad.status, 422);
  assert.equal((await challenge(db, p)).attemptCount, 1);
  const capped = await parsed(await verify(f, p, r));
  assert.equal(capped.status, 429);
  assert.equal((await challenge(db, p)).attemptCount, 1);
  assert.equal((await db.select().from(s.users))[0].isActive, false);
  await expire(db, scopes.verify, p);
  for (let i = 1; i <= 4; i++) assert.equal((await verify(f, p, r, "000000")).status, 422);
  assert.equal((await challenge(db, p)).attemptCount, 5);
  assert.equal((await verify(f, p, r)).status, 422);
  const q = f.phone(), a = await register(f, q); await register(f, q);
  assert.equal((await verify(f, q, a, "000000")).status, 422);
  assert.equal(await bucket(db, scopes.verify, q), undefined);
});

run("deletion quota uses authenticated account identity and rejects before any anonymization", async ({ db }) => {
  const f = app(db), p = f.phone(), r = await register(f, p), auth = await parsed(await verify(f, p, r));
  const user = (await db.select().from(s.users))[0];
  for (let i = 0; i < 5; i++) await admit(db, f.limits, f.limits.budget("deletion", user.id));
  const result = await parsed(await f.api.deleteAccount(req("profile", "DELETE", { id: randomUUID() }, auth.cookie)));
  assert.equal(result.status, 429);
  assert.deepEqual((await db.select().from(s.users))[0], user);
  assert.equal((await f.api.deleteAccount(req("profile", "DELETE", {}))).status, 401);
  await expire(db, scopes.deletion, user.id);
  assert.equal((await f.api.deleteAccount(req("profile", "DELETE", {}, auth.cookie))).status, 200);
  assert.equal((await bucket(db, scopes.deletion, user.id)).count, 1);
  assert.equal((await db.select().from(s.users))[0].phone, null);
});

run("rejected retry retains byte-identical current code/hash/expiry; late receipt still matches it; no third send", async ({ db }) => {
  const f = app(db), p = f.phone();
  for (let i = 0; i < 4; i++) await admit(db, f.limits, f.limits.budget("send", p));
  let first;
  f.rt.sender = async (phone, code) => {
    f.sends.push({ phone, code }); first = await challenge(db, p);
    return { ...outcome("unknown"), provider_message_id: "actual-first" };
  };
  const result = await register(f, p);
  assert.equal(result.status, 429); assert.ok(result.cookie);
  const row = await challenge(db, p);
  for (const key of ["codeHash", "expiresAt", "lastSentAt"]) assert.deepEqual(row[key], first[key]);
  assert.equal(row.sendAttempts[1].error_code, "rate_limited");
  assert.equal(row.sendAttempts[1].provider_message_id, null);
  f.advance(1000);
  const receipt = { statuses: [{ id: "actual-first", status: "delivered", timestamp: f.rt.now().getTime() / 1000 }] };
  assert.equal((await f.api.callback(req("whapi/callback", "POST", receipt, undefined,
    { "X-Whapi-Secret": f.rt.callbackSecret }))).status, 200);
  assert.equal((await challenge(db, p)).deliveryStatus, "delivered");
  assert.equal((await challenge(db, p)).sendStatus, "api_accepted");
  await sendChallenge(db, row.id, f.rt, f.limits);
  assert.equal(f.sends.length, 1);
  assert.equal((await verify(f, p, result)).status, 200, "the admitted first code still activates its own attempt");
});

run("admitted first/retry share committed budget; network failures are not refunded; network/sleep have no open transaction", async ({ db, pool, name }) => {
  const f = app(db), p = f.phone();
  const idleTransactions = async () => (await pool.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND state LIKE 'idle in transaction%'", [name])).rows[0].n;
  const sender = f.rt.sender, sleep = f.rt.sleep;
  f.rt.sender = async (...args) => { assert.equal(await idleTransactions(), 0); return sender(...args); };
  f.rt.sleep = async ms => { assert.equal(await idleTransactions(), 0); return sleep(ms); };
  f.plans.push(outcome("failed"), outcome("failed"));
  const r = await register(f, p);
  assert.equal(r.status, 500);
  assert.equal((await bucket(db, scopes.send, p)).count, 2);
  assert.equal(f.sends.length, 2); assert.deepEqual(f.sleeps, [5000]);
  await sendChallenge(db, (await challenge(db, p)).id, f.rt, f.limits);
  assert.equal(f.sends.length, 2);
});

for (const phase of ["missing table", "insert", "update", "commit", "cleanup"]) {
  run(`real PG ${phase} fault fails closed503 with no creation/send/cookie`, async ({ db, name }) => {
    const f = app(db);
    if (phase === "missing table") await db.execute(sql.raw(`DROP TABLE "${name}".security_rate_limits`));
    else {
      await db.execute(sql.raw(`CREATE FUNCTION "${name}".fail_rate() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'isolated database fault' USING ERRCODE='58000'; END $$`));
      if (phase === "cleanup") {
        await db.execute(sql`INSERT INTO ${rates} VALUES ('expired', ${"e".repeat(64)}, 1,
          NOW()-INTERVAL '2 hours', NULL, NOW()-INTERVAL '1 hour')`);
      }
      const deferred = phase === "commit";
      const event = phase === "insert" || deferred ? "INSERT" : phase === "cleanup" ? "DELETE" : "UPDATE";
      await db.execute(sql.raw(`CREATE ${deferred ? "CONSTRAINT " : ""}TRIGGER fail_rate_trigger
        AFTER ${event} ON "${name}".security_rate_limits
        ${deferred ? "DEFERRABLE INITIALLY DEFERRED" : ""}
        FOR EACH ROW EXECUTE FUNCTION "${name}".fail_rate()`));
    }
    const r = await register(f, f.phone());
    assert.equal(r.status, 503); assert.equal(r.cookie, undefined);
    assert.equal(f.sends.length, 0);
    assert.equal((await db.select().from(s.users)).length, 0);
    assert.equal((await db.select().from(s.otpVerificationChallenges)).length, 0);
    assert.deepEqual(Object.keys(r.data), ["error"], "no internal database details");
  });
}

run("connection acquisition failure503; programming errors remain500, never an in-memory fallback", async ({ db }) => {
  const broken = accountHandlers(() => { throw Object.assign(new Error("connection fault"), { code: "ECONNREFUSED" }); }, runtime);
  assert.equal((await broken.register(req("register", "POST", { phone: "+963900000013", name: "test", password }))).status, 503);
  const bug = accountHandlers(() => { throw new TypeError("programming fault"); }, runtime);
  assert.equal((await bug.register(req("register", "POST", { phone: "+963900000014", name: "test", password }))).status, 500);
  assert.equal((await db.select().from(rates)).length, 0);
});

run("indexed cleanup caps50, skips locked rows, retains blocked/active state without waiting", async ({ db, pool, name }) => {
  await db.execute(sql`INSERT INTO ${rates} (scope,key_hash,count,window_expires_at,blocked_until,retire_at)
    SELECT 'expired', lpad(to_hex(n),64,'0'), 1, NOW()-INTERVAL '3 hours', NULL, NOW()-INTERVAL '2 hours'
    FROM generate_series(1,61) n`);
  const limits = new AccountLimits();
  await admit(db, limits, limits.budget("send", "active"));
  await admit(db, limits, limits.budget("send", "blocked"));
  await db.execute(sql`UPDATE ${rates} SET window_expires_at=NOW()-INTERVAL '1 hour',
    blocked_until=NOW()+INTERVAL '15 minutes', retire_at=NOW()+INTERVAL '75 minutes'
    WHERE key_hash=${rateLimitHash(scopes.send, "blocked", runtime)}`);
  const held = await pool.connect();
  try {
    await held.query("BEGIN");
    await held.query(`SELECT * FROM "${name}".security_rate_limits WHERE key_hash=$1 FOR UPDATE`, ["0".repeat(63) + "1"]);
    const start = Date.now();
    await accountTransaction(db, tx => limits.cleanup(tx));
    assert.ok(Date.now() - start < 4000);
    assert.equal((await db.select().from(rates)).length, 13, "50 deleted, locked+10 expired+active+blocked retained");
    assert.ok(await bucket(db, scopes.send, "active"));
  } finally { await held.query("ROLLBACK"); held.release(); }
  await accountTransaction(db, tx => limits.cleanup(tx));
  assert.equal((await db.select().from(rates)).length, 2);
});

test("all committed scratch tests leave genuine business content unchanged", async () => {
  const before = await fixtureTableSnapshot();
  await withRateScratch(async ({ db }) => {
    const f = app(db); assert.equal((await register(f, f.phone())).status, 201);
  });
  assert.deepEqual(await fixtureTableSnapshot(), before);
});