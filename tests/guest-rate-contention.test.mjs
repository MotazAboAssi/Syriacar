import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { sql } from "drizzle-orm";
import * as s from "../src/server/db/schema.ts";
import { securityRateLimits as rates } from "../src/server/db/security-rate-limits.ts";
import { closeDatabase } from "../src/server/db/client.ts";
import { guestScopes as scopes, globalIdentity, guestTransaction } from "../src/modules/guest-security/rate-limits.ts";
import { AccountLimits } from "../src/modules/account/rate-limits.ts";
import { accountHandlers } from "../src/modules/account/http.ts";
import { sessionCookie } from "../src/modules/account/security.ts";
import { registeredHandlers } from "../src/modules/registered-services/http.ts";
import { req, parsed, outcome } from "./fixtures/account.mjs";
import { withGuestScratch, counts, bucket, setCount, request, result, hash, quotaSecret } from "./fixtures/guest-rate-scratch.mjs";

after(closeDatabase);
const run = (name, check) => test(name, { timeout: 60000 }, () => withGuestScratch(check));
const statuses = results => results.map(r => r.status).sort();
function child(f, kind, input) {
  const worker = spawnSync(process.execPath, ["--conditions=react-server", "tests/fixtures/guest-rate-worker.mjs",
    f.name, kind, JSON.stringify(input)], { encoding: "utf8", timeout: 12000 });
  assert.equal(worker.status, 0, worker.stderr);
  return JSON.parse(worker.stdout.trim().split("\n").at(-1));
}

run("pool2 concurrent mixed Guest creation: global accepts exactly20, failed admissions leave no rows", async f => {
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => {
    const kind = i % 2 ? "inspection" : "towing";
    return f.create(kind, kind === "inspection" ? f.inspection(f.phone(), i % 3 !== 0) : f.towing());
  }));
  assert.equal(results.filter(r => r.status === 201).length, 20);
  assert.equal(results.filter(r => r.status === 429).length, 10);
  const notices = results.filter(r => r.status === 201 && r.data.notificationId).length;
  assert.ok(notices < 20, "concurrent no-match creations must count toward global");
  assert.deepEqual(await counts(f.db), { parents: 20, notifications: notices });
  assert.equal((await bucket(f.db, scopes.parentGlobal, globalIdentity)).count, 20);
  assert.equal((await f.db.select().from(rates)).length, 21 + notices, "only successful phones plus global");
  const worker = child(f, "inspection", f.inspection());
  assert.equal(worker.status, 429); assert.deepEqual(worker.keys, ["error"]);
  assert.match(worker.retryAfter, /^[1-9]\d*$/);
});

run("pool2 same-phone Inspection/Towing burst accepts exactly10, child process shares phone quota", async f => {
  const p = f.phone();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => {
    const kind = i % 2 ? "inspection" : "towing";
    return f.create(kind, f[kind](p));
  }));
  assert.equal(results.filter(r => r.status === 201).length, 10);
  assert.equal(results.filter(r => r.status === 429).length, 10);
  assert.equal((await bucket(f.db, scopes.parentGlobal, globalIdentity)).count, 10);
  assert.equal((await bucket(f.db, scopes.parentPhone, p)).count, 10);
  assert.equal((await bucket(f.db, scopes.notificationPhone, p)).count, 10);
  assert.deepEqual(await counts(f.db), { parents: 10, notifications: 10 });
  assert.equal(child(f, "towing", f.towing(p)).status, 429);
});

run("different Guest parents for same phone race for final notice40; existing parents do not debit creation", async f => {
  const p = f.phone(), input = f.towing(p);
  const first = await f.create("towing", input), second = await f.create("towing", input);
  await setCount(f.db, scopes.notificationPhone, p, 39);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    f.create("towing", { ...input, requestProof: i % 2 ? first.data.requestProof : second.data.requestProof })));
  assert.deepEqual(statuses(results), [201,429,429,429,429,429,429,429]);
  assert.equal((await bucket(f.db, scopes.notificationPhone, p)).count, 40);
  assert.equal((await bucket(f.db, scopes.parentPhone, p)).count, 2);
  assert.equal((await bucket(f.db, scopes.parentGlobal, globalIdentity)).count, 2);
  assert.deepEqual(await counts(f.db), { parents: 2, notifications: 3 });
  assert.equal(child(f, "towing", { ...input, requestProof: first.data.requestProof }).status, 429);
});

run("same existing no-match parent serializes upgrade/location/notice races without extra parents or deadlocks", async f => {
  const input = f.towing(), first = await f.create("towing", { ...input, providerId: f.ids.partial });
  const operations = [];
  for (let i = 0; i < 4; i++) {
    operations.push(f.create("towing", { ...input, requestProof: first.data.requestProof }));
    operations.push(result(f.api.towing.location(request("towing", {
      requestProof: first.data.requestProof, notificationId: first.data.notificationId,
      governorateId: f.gov, regionId: f.region,
    }, "location"))));
    operations.push(f.create("inspection", f.inspection()));
  }
  const results = await Promise.all(operations);
  assert.ok(results.every(r => [200,201].includes(r.status)));
  const parent = (await f.db.select().from(s.serviceRequests)).find(r => r.id === first.data.requestId);
  assert.equal(parent.matchingStatus, "matched");
  assert.deepEqual(await counts(f.db), { parents: 5, notifications: 9 });
  assert.equal((await bucket(f.db, scopes.parentGlobal, globalIdentity)).count, 5);
});

run("real Account and registered creation share pool2 with Guest without debiting Guest counters or deadlocking", async f => {
  const userId = randomUUID(), p = f.phone();
  const rt = { now: f.runtime.now, secret: quotaSecret, code: () => "123456",
    sender: async () => outcome("api_accepted", randomUUID()) };
  await f.db.insert(s.users).values({ id: userId, name: "registered fixture", phone: p,
    passwordHash: "fixture-not-a-credential", isActive: true, createdAt: rt.now(), lastActiveAt: rt.now() });
  const cookie = (await sessionCookie(userId, rt)).split(";")[0];
  const registered = registeredHandlers(() => f.db, rt), account = accountHandlers(() => f.db, rt);
  const tow = () => result(registered.towing(new Request("https://guest-verification.example/api/towing/requests", {
    method: "POST", headers: { Origin: "https://guest-verification.example", "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ originGovernorateId: f.gov, destGovernorateId: f.otherGov,
      providerId: f.ids.towing, acceptedTerms: true }),
  })));
  const registrations = Array.from({ length: 3 }, async () => parsed(await account.register(req("register", "POST", {
    name: "account fixture", phone: f.phone(), password: "Strong-pass-123",
  }))));
  const results = await Promise.all([...registrations, tow(), tow(),
    f.create("inspection", f.inspection()), f.create("towing", f.towing())]);
  assert.ok(results.every(r => r.status === 201), JSON.stringify(results.map(r => ({ status: r.status, error: r.data.error }))));
  const rows = await f.db.select().from(s.serviceRequests);
  assert.equal(rows.filter(r => r.userType === "registered").length, 2);
  assert.equal(rows.filter(r => r.userType === "guest").length, 2);
  assert.equal((await bucket(f.db, scopes.parentGlobal, globalIdentity)).count, 2);
  assert.equal((await bucket(f.db, scopes.parentPhone, p)), undefined);
});

run("terminal Guest cleanup is bounded50, skips held expired Account row and preserves active buckets", async f => {
  const accountScope = "account.otp.send.phone", p = f.phone();
  await guestTransaction(f.db, tx => new AccountLimits().admit(tx,
    [{ scope: accountScope, identity: p, limit: 5, seconds: 3600 }], { secret: quotaSecret }));
  await f.db.execute(sql`UPDATE ${rates} SET window_expires_at=NOW()-INTERVAL '3 hours',
    retire_at=NOW()-INTERVAL '2 hours' WHERE scope=${accountScope}`);
  await f.db.execute(sql`INSERT INTO ${rates} (scope,key_hash,count,window_expires_at,retire_at)
    SELECT 'scratch.expired',lpad(to_hex(i),64,'0'),1,NOW()-INTERVAL '3 hours',NOW()-INTERVAL '2 hours'
    FROM generate_series(1,70) i`);
  const client = await f.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT scope FROM "${f.name}".security_rate_limits WHERE scope=$1 AND key_hash=$2 FOR UPDATE`,
      [accountScope,hash(accountScope,p)]);
    assert.equal((await f.create("inspection", f.inspection())).status, 201);
    const rows = await f.db.select().from(rates);
    assert.equal(rows.filter(r => r.scope === "scratch.expired").length, 20);
    assert.equal(rows.filter(r => r.scope === accountScope).length, 1);
    assert.equal(rows.filter(r => r.scope.startsWith("guest.")).length, 3);
  } finally { await client.query("ROLLBACK"); client.release(); }
});