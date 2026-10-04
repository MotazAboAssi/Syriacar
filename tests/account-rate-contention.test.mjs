import test from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { withRateScratch } from "./fixtures/rate-limit-scratch.mjs";
import { req, parsed, outcome, password } from "./fixtures/account.mjs";
import * as s from "../src/server/db/schema.ts";
import { securityRateLimits as rates } from "../src/server/db/security-rate-limits.ts";
import { AccountLimits, accountTransaction } from "../src/modules/account/rate-limits.ts";
import { accountHandlers } from "../src/modules/account/http.ts";
import { sendChallenge } from "../src/modules/account/otp.ts";

const run = (name, fn) => test(name, { timeout: 45000 }, () => withRateScratch(fn));
function fixture(db) {
  let time = new Date(), nextCode = 500000;
  const codes = new Map(), sends = [], limits = new AccountLimits();
  const runtime = { secret: "scratch-only", callbackSecret: "scratch-callback", now: () => new Date(time),
    code: () => String(++nextCode),
    sleep: async ms => { time = new Date(time.getTime() + ms); },
    sender: async (phone, code) => {
      codes.set(phone, code); sends.push({ phone, code }); return outcome("api_accepted", "message-" + sends.length);
    } };
  const a = accountHandlers(() => db, runtime, limits), b = accountHandlers(() => db, runtime, new AccountLimits());
  return { a, b, runtime, limits, codes, sends, advance: ms => { time = new Date(time.getTime() + ms); },
    register: async (phone, api = a) => parsed(await api.register(req("register", "POST", { phone, name: "Fixture", password }))),
    verify: (phone, r, api = a) => api.verify(req("otp", "POST",
      { phone, attemptId: r.data.attemptId, code: codes.get(phone) }, r.cookie)),
    callback: (id, status, api = a) => api.callback(req("whapi/callback", "POST",
      { statuses: [{ id, status, timestamp: time.getTime() / 1000 }] }, undefined,
      { "X-Whapi-Secret": runtime.callbackSecret })),
  };
}
const latest = async (db, p) => (await db.select().from(s.otpVerificationChallenges)
  .where(eq(s.otpVerificationChallenges.phone, p))).sort((a, b) => b.createdAt - a.createdAt)[0];

run("small pool sorted overlapping budgets with opposite input order cannot deadlock or lose increments", async ({ db }) => {
  const limits = new AccountLimits(), rt = { secret: "scratch-only" };
  const budgets = [{ scope: "shared.a", identity: "one", limit: 100, seconds: 3600 },
    { scope: "shared.b", identity: "two", limit: 100, seconds: 3600 }];
  await Promise.all(Array.from({ length: 24 }, (_, n) => accountTransaction(db,
    tx => limits.admit(tx, n % 2 ? budgets : [...budgets].reverse(), rt))));
  assert.deepEqual((await db.select().from(rates)).map(r => r.count), [24, 24]);
});

run("small pool resend versus retry and callback has no inverse locks and only one replacement send", async ({ db }) => {
  const f = fixture(db), p = "+963900001001", r = await f.register(p), old = await latest(db, p);
  f.advance(601000);
  await db.update(s.otpVerificationChallenges).set({ retryAt: f.runtime.now() })
    .where(eq(s.otpVerificationChallenges.id, old.id));
  const [resend, retry, callback] = await Promise.all([
    f.b.resend(req("otp/resend", "POST", { phone: p, attemptId: r.data.attemptId }, r.cookie)),
    sendChallenge(db, old.id, f.runtime, f.limits), f.callback("message-1", "failed"),
  ]);
  assert.equal(resend.status, 200);
  assert.equal(retry.id, old.id);
  assert.equal(callback.status, 200);
  const current = await latest(db, p);
  assert.notEqual(current.id, old.id);
  assert.equal(current.sendAttemptCount, 1);
  assert.equal(f.sends.length, 2);
  assert.equal((await db.select().from(rates)).find(r => r.scope === "account.otp.send.phone").count, 2);
  assert.equal(current.deliveryStatus, null, "old receipt cannot affect replacement");
});

run("small pool register versus verify and delete versus phone operations remain serializable", async ({ db }) => {
  const f = fixture(db);
  for (let i = 0; i < 4; i++) {
    const p = "+96390000101" + i, r = await f.register(p);
    const [verification, replacement] = await Promise.all([f.verify(p, r), f.register(p, f.b)]);
    if (verification.status === 200) assert.equal(replacement.status, 409);
    else {
      assert.equal(verification.status, 422); assert.equal(replacement.status, 201);
      assert.equal((await f.verify(p, replacement)).status, 200);
    }
  }
  const p = "+963900001020", r = await f.register(p), auth = await parsed(await f.verify(p, r));
  const [deletion, login, repeat] = await Promise.all([
    f.a.deleteAccount(req("profile", "DELETE", {}, auth.cookie)),
    f.b.login(req("login", "POST", { phone: p, password })),
    f.register(p, f.b),
  ]);
  assert.equal(deletion.status, 200);
  assert.ok([200, 401].includes(login.status));
  assert.ok([201, 409].includes(repeat.status));
  const users = await db.select().from(s.users).where(eq(s.users.phone, p));
  assert.ok(users.length <= 1);
  if (users.length) assert.equal(users[0].isActive, false);
});

run("callback versus real retry/finalization cannot attach first receipt to replacement hash", async ({ db }) => {
  const f = fixture(db), p = "+963900001030", r = await f.register(p);
  const old = await latest(db, p), firstCode = f.codes.get(p);
  f.advance(1000);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const original = f.runtime.sender;
  f.runtime.sender = async (...args) => { started(); await gate; return original(...args); };
  const failure = f.callback("message-1", "failed");
  await ready;
  const replacement = await latest(db, p);
  assert.notEqual(replacement.codeHash, old.codeHash);
  assert.equal(replacement.sendAttemptCount, 2);
  assert.equal((await f.callback("message-1", "delivered", f.b)).status, 200);
  assert.equal((await latest(db, p)).deliveryStatus, null);
  release();
  assert.equal((await failure).status, 200);
  const final = await latest(db, p);
  assert.equal(final.deliveryStatus, null);
  assert.notEqual(f.codes.get(p), firstCode);
  assert.equal((await f.verify(p, r)).status, 200);
});

for (const operation of ["verify", "login", "delete"]) {
  run(`real deferred commit failure during ${operation} rolls back writes and issues no session cookie`, async ({ db, name }) => {
    const f = fixture(db), p = "+963900001040", r = await f.register(p);
    let auth;
    if (operation !== "verify") auth = await parsed(await f.verify(p, r));
    f.advance(1000);
    const users = await db.select().from(s.users), otp = await db.select().from(s.otpVerificationChallenges);
    await db.execute(sql.raw(`CREATE FUNCTION "${name}".reject_commit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'scratch commit fault' USING ERRCODE='58000'; END $$`));
    await db.execute(sql.raw(`CREATE CONSTRAINT TRIGGER reject_commit_trigger AFTER INSERT OR UPDATE
      ON "${name}".security_rate_limits DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "${name}".reject_commit()`));
    const response = operation === "verify" ? await f.verify(p, r) : operation === "login"
      ? await f.a.login(req("login", "POST", { phone: p, password }))
      : await f.a.deleteAccount(req("profile", "DELETE", {}, auth.cookie));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await db.select().from(s.users), users);
    assert.deepEqual(await db.select().from(s.otpVerificationChallenges), otp);
    assert.equal(f.sends.length, 1);
  });
}

run("DB failure at retry preserves earlier admitted creation and own proof but performs no new send/hash change", async ({ db, name }) => {
  const f = fixture(db), p = "+963900001050";
  let first;
  f.runtime.sender = async (phone, code) => {
    f.codes.set(phone, code); f.sends.push({ phone, code }); first = await latest(db, p);
    return outcome("failed");
  };
  f.runtime.sleep = async ms => {
    f.advance(ms);
    await db.execute(sql.raw(`CREATE FUNCTION "${name}".reject_retry() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'scratch retry fault' USING ERRCODE='58000'; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER reject_retry AFTER UPDATE ON "${name}".security_rate_limits
      FOR EACH ROW EXECUTE FUNCTION "${name}".reject_retry()`));
  };
  const response = await f.register(p);
  assert.equal(response.status, 503); assert.ok(response.cookie);
  assert.equal(response.data.otp.attemptId, first.id);
  const row = await latest(db, p);
  for (const key of ["codeHash", "expiresAt", "lastSentAt"]) assert.deepEqual(row[key], first[key]);
  assert.equal(row.sendAttemptCount, 1);
  assert.equal(f.sends.length, 1);
  assert.equal((await db.select().from(s.users))[0].isActive, false);
});

run("legacy unclaimed first send needs admission; crashed claimed send is never implicitly resent", async ({ db }) => {
  const f = fixture(db), p = "+963900001060";
  await f.register(p);
  const first = await latest(db, p);
  await sendChallenge(db, first.id, f.runtime, f.limits);
  assert.equal(f.sends.length, 1);
  await db.update(s.otpVerificationChallenges).set({ sendAttemptCount: 0, sendAttempts: [], sendStatus: "pending" })
    .where(eq(s.otpVerificationChallenges.id, first.id));
  await sendChallenge(db, first.id, f.runtime, f.limits);
  assert.equal(f.sends.length, 2);
  assert.equal((await db.select().from(rates)).find(r => r.scope === "account.otp.send.phone").count, 2);
  const row = await latest(db, p);
  await db.update(s.otpVerificationChallenges).set({ sendStatus: "pending",
    sendAttempts: [{ ...row.sendAttempts[0], api_outcome: "pending" }] })
    .where(eq(s.otpVerificationChallenges.id, row.id));
  await sendChallenge(db, row.id, f.runtime, f.limits);
  assert.equal(f.sends.length, 2, "without RAM code/retry claim pending is not resent");
});