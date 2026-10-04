import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { eq, sql } from "drizzle-orm";
import { withRateScratch } from "./fixtures/rate-limit-scratch.mjs";
import { fixtureTableSnapshot } from "./fixtures/manual-seed-isolation.mjs";
import { req, parsed, password, outcome } from "./fixtures/account.mjs";
import { AccountLimits, scopes, accountTransaction } from "../src/modules/account/rate-limits.ts";
import { accountHandlers } from "../src/modules/account/http.ts";
import { RegistrationPreparation, registrationPreparationPolicy } from "../src/modules/account/registration-preparation.ts";
import { hashPassword } from "../src/modules/account/security.ts";
import { securityRateLimits as rates } from "../src/server/db/security-rate-limits.ts";
import * as s from "../src/server/db/schema.ts";
import { closeDatabase, registrationTransactionClient } from "../src/server/db/client.ts";

after(closeDatabase);
const run = (name, action) => test(name, { timeout: 60000 }, () => withRateScratch(action));
const deferred = () => {
  let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; });
  return { promise, resolve, reject };
};
async function until(predicate, ms = 5000) {
  const end = performance.now() + ms;
  while (!await predicate()) {
    if (performance.now() >= end) throw new Error("Fixture condition not reached");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function fixture(f, policy = {}, overrides = {}) {
  const gate = new RegistrationPreparation({ concurrency: 1, ...policy });
  let sequence = randomInt(100000000,900000000), hashes = 0;
  const sends = [];
  const runtime = {
    secret: "registration-preparation-fixture", code: () => "123456",
    registrationPreparation: gate,
    registrationHash: async value => { hashes++; return hashPassword(value); },
    sender: async (phone,code) => { sends.push({phone,code}); return outcome(); },
    ...overrides,
  };
  const limits = new AccountLimits();
  const api = accountHandlers(() => f.db, runtime, limits);
  return { gate, runtime, limits, sends, get hashes() { return hashes; },
    phone: () => "+963"+sequence++,
    post: async phone => parsed(await api.register(req("register","POST",{phone,password,name:"تحقق التحضير"}))),
  };
}
const rows = (f, phone) => f.db.select().from(s.users).where(eq(s.users.phone,phone));
const buckets = f => f.db.select().from(rates);
async function charge(f, app, kind, phone, count) {
  for (let i=0;i<count;i++) await accountTransaction(f.db, tx =>
    app.limits.admit(tx,[app.limits.budget(kind,phone)],app.runtime));
}

run("exhausted registration and send quotas perform zero Argon2, no partial debit", async f => {
  const app = fixture(f), p=app.phone(), q=app.phone();
  await charge(f,app,"registration",p,3);
  await charge(f,app,"send",q,5);
  const before=await buckets(f);
  assert.equal((await app.post(p)).status,429);
  assert.equal((await app.post(q)).status,429);
  assert.equal(app.hashes,0); assert.equal(app.sends.length,0);
  assert.deepEqual(await buckets(f),before);
  assert.deepEqual(await rows(f,p),[]);
  assert.deepEqual(await rows(f,q),[]);
});

run("last slot and simultaneous same-phone requests hash exactly once after admission", async f => {
  const app=fixture(f), p=app.phone();
  await charge(f,app,"registration",p,2);
  const results=await Promise.all(Array.from({length:6},()=>app.post(p)));
  assert.equal(results.filter(r=>r.status===201).length,1);
  assert.equal(results.filter(r=>r.status===429).length,5);
  assert.equal(app.hashes,1); assert.equal(app.sends.length,1);
  assert.equal((await buckets(f)).find(r=>r.scope===scopes.registration).count,3);
  assert.deepEqual(app.gate.state,{active:0,queued:0});
});

run("hash failure rolls back composite admission and preserves earlier credentials/proof", async f => {
  const app=fixture(f), p=app.phone();
  assert.equal((await app.post(p)).status,201);
  const before={users:await rows(f,p),rates:await buckets(f),
    challenges:await f.db.select().from(s.otpVerificationChallenges)};
  app.runtime.registrationHash=async()=>{throw new Error("Fixture native failure");};
  const failed=await app.post(p);
  assert.equal(failed.status,500); assert.equal(failed.cookie,undefined);
  assert.deepEqual({users:await rows(f,p),rates:await buckets(f),
    challenges:await f.db.select().from(s.otpVerificationChallenges)},before);
  assert.equal(app.sends.length,1);
  assert.deepEqual(app.gate.state,{active:0,queued:0});
});

for (const finish of ["resolve","reject"]) {
  run(`hash timeout rolls back; late ${finish} cannot write or release native capacity early`, async f => {
    const start=deferred(), late=deferred();
    const app=fixture(f,{hashMs:70,transactionMs:10000,queueMs:30},
      {registrationHash:async()=>{start.resolve();return late.promise;}});
    const p=app.phone(), first=app.post(p);
    await start.promise;
    const response=await first;
    assert.equal(response.status,503); assert.equal(response.cookie,undefined);
    assert.deepEqual(await rows(f,p),[]); assert.deepEqual(await buckets(f),[]);
    assert.deepEqual(app.gate.state,{active:1,queued:0});
    assert.equal((await app.post(app.phone())).status,503);
    assert.deepEqual(app.gate.state,{active:1,queued:0});
    if(finish==="resolve") late.resolve(await hashPassword(password));
    else late.reject(new Error("Late fixture failure"));
    await until(()=>app.gate.state.active===0);
    assert.deepEqual(await rows(f,p),[]); assert.deepEqual(await buckets(f),[]);
    assert.equal(app.sends.length,0);
    app.runtime.registrationHash=hashPassword;
    assert.equal((await app.post(p)).status,201);
    assert.deepEqual(app.gate.state,{active:0,queued:0});
  });
}

run("transaction deadline wins independently of hash ceiling without late writes", async f => {
  const started=deferred(), late=deferred();
  const app=fixture(f,{transactionMs:1000,hashMs:10000},
    {registrationHash:async()=>{started.resolve();return late.promise;}});
  const p=app.phone(), pending=app.post(p); await started.promise;
  assert.equal((await pending).status,503);
  assert.deepEqual(await buckets(f),[]); assert.deepEqual(await rows(f,p),[]);
  late.resolve(await hashPassword(password));
  await until(()=>app.gate.state.active===0);
  assert.equal(app.sends.length,0); assert.deepEqual(await buckets(f),[]);
});

run("queue is bounded, queued callers own no connection, overflow/timeout debit nothing", async f => {
  const started=deferred(), finish=deferred();
  const app=fixture(f,{queueSize:1,queueMs:80,hashMs:2000},
    {registrationHash:async value=>{started.resolve();await finish.promise;return hashPassword(value);}});
  const first=app.post(app.phone()); await started.promise;
  const waiting=app.post(app.phone()); await until(()=>app.gate.state.queued===1);
  assert.equal(f.pool.totalCount,1); // No checkout for the queued request.
  assert.equal((await app.post(app.phone())).status,503);
  assert.equal((await waiting).status,503);
  finish.resolve(); assert.equal((await first).status,201);
  assert.equal((await buckets(f)).filter(r=>r.scope===scopes.registration).length,1);
  assert.deepEqual(app.gate.state,{active:0,queued:0});
});

run("different phones run concurrently up to local ceiling; sender owns no slot/transaction", async f => {
  const ready=deferred(), finish=deferred(); let running=0,max=0;
  const app=fixture(f,{concurrency:2},{registrationHash:async value=>{
    running++;max=Math.max(max,running);if(running===2)ready.resolve();
    await finish.promise;const result=await hashPassword(value);running--;return result;
  }});
  app.runtime.sender=async()=> {
    assert.ok(app.gate.state.active<2);
    const active=await f.db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name=${f.name} AND state='idle in transaction'`);
    // A DIFFERENT registration may still be in its own transaction.
    assert.ok(active.rows[0].n<=app.gate.state.active); return outcome();
  };
  const pending=[app.post(app.phone()),app.post(app.phone())];
  await ready.promise;assert.equal(max,2);finish.resolve();
  assert.ok((await Promise.all(pending)).every(r=>r.status===201));
  assert.deepEqual(app.gate.state,{active:0,queued:0});
});

run("pool2 headroom with preparation1 lets unrelated queries finish while hashing waits", async f => {
  const ready=deferred(),finish=deferred();
  const app=fixture(f,{}, {registrationHash:async value=>{
    ready.resolve();await finish.promise;return hashPassword(value);
  }});
  const pending=app.post(app.phone());await ready.promise;
  assert.equal((await f.db.execute(sql`SELECT 42 AS n`)).rows[0].n,42);
  finish.resolve();assert.equal((await pending).status,201);
});

run("pool5 preparation2 leaves checkout headroom and queued requests do not enter DB", async f => {
  f.pool.options.max=5; // Test the production pool size, without a second pool.
  const ready=deferred(),finish=deferred();let started=0;
  const app=fixture(f,{concurrency:2},{registrationHash:async value=>{
    if(++started===2)ready.resolve();await finish.promise;return hashPassword(value);
  }});
  const pending=Array.from({length:4},()=>app.post(app.phone()));
  await ready.promise;
  assert.deepEqual(app.gate.state,{active:2,queued:2});
  assert.equal(f.pool.totalCount,2);
  assert.equal((await f.db.execute(sql`SELECT 42 AS n`)).rows[0].n,42);
  assert.equal(f.pool.totalCount,3);
  finish.resolve();assert.ok((await Promise.all(pending)).every(r=>r.status===201));
  assert.deepEqual(app.gate.state,{active:0,queued:0});
});

run("slow gateway owns no preparation slot/transaction and permits another registration", async f => {
  const ready=deferred(),network=deferred();let sent=0;
  const app=fixture(f);
  app.runtime.sender=async()=>{
    if(++sent===1){
      assert.deepEqual(app.gate.state,{active:0,queued:0});
      const idle=await f.db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name=${f.name} AND state='idle in transaction'`);
      assert.equal(idle.rows[0].n,0);
      ready.resolve();await network.promise;
    }
    return outcome();
  };
  const first=app.post(app.phone());await ready.promise;
  try {assert.equal((await app.post(app.phone())).status,201);}
  finally {network.resolve();}
  assert.equal((await first).status,201);
  assert.deepEqual(app.gate.state,{active:0,queued:0});
});

run("PG window crossed during hashing retains transaction-time admission semantics", async f => {
  const ready=deferred(),finish=deferred();
  const app=fixture(f,{}, {registrationHash:async value=>{
    ready.resolve();await finish.promise;return hashPassword(value);
  }}),p=app.phone();
  await charge(f,app,"registration",p,2);
  await f.db.execute(sql`UPDATE ${rates} SET window_expires_at=NOW()+INTERVAL '2 seconds',
    retire_at=NOW()+INTERVAL '1 hour' WHERE scope=${scopes.registration}`);
  const before=(await buckets(f))[0],pending=app.post(p);await ready.promise;
  const wait=await f.db.execute(sql`SELECT GREATEST(0,EXTRACT(EPOCH FROM
    (${before.windowExpiresAt.toISOString()}::timestamptz-clock_timestamp()))) AS seconds`);
  await new Promise(resolve=>setTimeout(resolve,Number(wait.rows[0].seconds)*1000+25));finish.resolve();
  assert.equal((await pending).status,201);
  const bucket=(await buckets(f)).find(r=>r.scope===scopes.registration);
  assert.equal(bucket.count,3);assert.deepEqual(bucket.windowExpiresAt,before.windowExpiresAt);
  app.runtime.registrationHash=hashPassword;
  assert.equal((await app.post(p)).status,201);
  assert.equal((await buckets(f)).find(r=>r.scope===scopes.registration).count,1);
});

run("real deferred commit failure rolls back hash/admission and issues no proof", async f => {
  await f.db.execute(sql.raw(`CREATE FUNCTION "${f.name}".fail_registration_commit() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture commit failure'; END $$`));
  await f.db.execute(sql.raw(`CREATE CONSTRAINT TRIGGER fail_registration_commit AFTER INSERT ON "${f.name}".users
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.name}".fail_registration_commit()`));
  const app=fixture(f),p=app.phone(),response=await app.post(p);
  assert.equal(response.status,503);assert.equal(response.cookie,undefined);
  assert.equal(app.hashes,1);assert.equal(app.sends.length,0);
  assert.deepEqual(await rows(f,p),[]);assert.deepEqual(await buckets(f),[]);
  assert.deepEqual(app.gate.state,{active:0,queued:0});
});

run("real backend disconnect while idle hashing is handled and preserves native accounting", async f => {
  const ready=deferred(),finish=deferred();
  const app=fixture(f,{}, {registrationHash:async value=>{
    ready.resolve();await finish.promise;return hashPassword(value);
  }}),p=app.phone(),pending=app.post(p);await ready.promise;
  const found=await f.db.execute(sql`SELECT pid FROM pg_stat_activity
    WHERE application_name=${f.name} AND state='idle in transaction'`);
  assert.equal(found.rows.length,1);
  await f.db.execute(sql`SELECT pg_terminate_backend(${found.rows[0].pid})`);
  assert.equal((await pending).status,503);
  assert.equal(app.gate.state.active,1);
  finish.resolve();await until(()=>app.gate.state.active===0);
  assert.deepEqual(await rows(f,p),[]);assert.deepEqual(await buckets(f),[]);
});

run("deadline interrupts blocked phone lock before Argon2 or quota writes", async f => {
  const held=await f.pool.connect(),app=fixture(f,{transactionMs:80}),p=app.phone();
  try {
    await held.query("BEGIN");
    await held.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[p]);
    assert.equal((await app.post(p)).status,503);
    assert.equal(app.hashes,0);assert.deepEqual(app.gate.state,{active:0,queued:0});
  } finally {await held.query("ROLLBACK");held.release();}
  assert.deepEqual(await buckets(f),[]);assert.deepEqual(await rows(f,p),[]);
});

run("checkout fault releases preparation slot without hashing or consuming quota", async f => {
  const app=fixture(f),api=accountHandlers(()=>({transaction:async()=>{
    throw Object.assign(new Error("timeout exceeded when trying to connect"),{code:"ETIMEDOUT"});
  }}),app.runtime);
  const response=await parsed(await api.register(req("register","POST",
    {phone:app.phone(),password,name:"تحقق"})));
  assert.equal(response.status,503);assert.equal(app.hashes,0);
  assert.deepEqual(app.gate.state,{active:0,queued:0});assert.deepEqual(await buckets(f),[]);
});

run("driver query timeout plus pending rollback destroys uncertain client before pool reuse", async f => {
  const app=fixture(f),p=app.phone(),held=await f.pool.connect();
  const db={transaction:action=>f.db.transaction(async tx=>{
    // Only this fixture's checked-out registration client, after BEGIN.
    registrationTransactionClient(tx).connectionParameters.query_timeout=40;
    return action(tx);
  })};
  const api=accountHandlers(()=>db,app.runtime);
  try {
    await held.query("BEGIN");
    await held.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[p]);
    const response=await parsed(await api.register(req("register","POST",
      {phone:p,password,name:"Driver timeout fixture"})));
    assert.equal(response.status,503);assert.equal(response.cookie,undefined);
    assert.equal(app.hashes,0);
    // The held fixture client remains; the uncertain registration client is gone.
    assert.equal(f.pool.totalCount,1);assert.equal(f.pool.idleCount,0);
    assert.deepEqual(app.gate.state,{active:0,queued:0});
  } finally {await held.query("ROLLBACK");held.release();}
  assert.deepEqual(await buckets(f),[]);assert.deepEqual(await rows(f,p),[]);
});

run("actual native hashing keeps parameters and ample deadline under paired load/long inputs", async f => {
  const times=[],app=fixture(f,{concurrency:2},{registrationHash:async value=>{
    const start=performance.now(),result=await hashPassword(value);
    times.push(performance.now()-start);
    assert.match(result,/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    return result;
  }});
  for(let i=0;i<4;i++)assert.ok((await Promise.all([app.post(app.phone()),app.post(app.phone())])).every(r=>r.status===201));
  const start=performance.now();await hashPassword("x".repeat(7600));times.push(performance.now()-start);
  console.log("registration native hash measured milliseconds:",times.map(Math.round).join(","),
    "hash safeguard milliseconds:",registrationPreparationPolicy.hashMs);
  assert.ok(Math.max(...times)<registrationPreparationPolicy.hashMs);
});

function child(f,phone,label,hold) {
  const process=fork(new URL("./fixtures/registration-preparation-worker.mjs",import.meta.url),
    [f.name,phone,label,hold],{execArgv:["--conditions=react-server"],stdio:["ignore","pipe","pipe","ipc"]});
  const events=[],waiters=[];let stderr="";
  process.stderr.on("data",data=>{stderr+=data;});
  process.on("message",event=>{events.push(event);for(const waiter of [...waiters])waiter();});
  return {process,events,async event(name){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("Child event timeout: "+name+" "+stderr)),12000);
      const check=()=>{const event=events.find(e=>e.event===name);if(!event)return;
        clearTimeout(timer);waiters.splice(waiters.indexOf(check),1);resolve(event);};
      waiters.push(check);check();
    });
  }};
}
run("simultaneous independent processes share final registration slot; waiter never hashes", async f => {
  const app=fixture(f),p=app.phone();await charge(f,app,"registration",p,2);
  const a=child(f,p,f.name+"_a","hold"),b=child(f,p,f.name+"_b","free");
  try {
    await Promise.all([a.event("ready"),b.event("ready")]);
    a.process.send("start");await a.event("hash");b.process.send("start");
    await until(async()=>{
      const result=await f.db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name=${f.name+"_b"} AND wait_event='advisory'`);
      return result.rows[0].n===1;
    });
    assert.ok(!b.events.some(e=>e.event==="hash"));
    a.process.send("release");
    assert.deepEqual(await a.event("done"),{event:"done",status:201,hashes:1});
    assert.deepEqual(await b.event("done"),{event:"done",status:429,hashes:0});
    assert.equal((await buckets(f)).find(r=>r.scope===scopes.registration).count,3);
  } finally {
    await Promise.all([a,b].map(async c=>{
      if(c.process.exitCode!==null)return;
      const exited=once(c.process,"exit");c.process.kill();await exited;
    }));
  }
});

test("preparation fixture tests leave genuine public business data unchanged",async()=>{
  const before=await fixtureTableSnapshot();
  await withRateScratch(async f=>assert.equal((await fixture(f).post(fixture(f).phone())).status,201));
  assert.deepEqual(await fixtureTableSnapshot(),before);
});