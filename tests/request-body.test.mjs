import test, { after } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { readJsonBody, requestBodyLimit, requestBodyDeadlineMs } from "../src/server/http/request-body.ts";
import { accountHandlers } from "../src/modules/account/http.ts";
import { registeredHandlers } from "../src/modules/registered-services/http.ts";
import { inspectionHandlers } from "../src/modules/guest-inspection/http.ts";
import { towingHandlers } from "../src/modules/guest-towing/http.ts";
import { sessionCookie } from "../src/modules/account/security.ts";
import { closeDatabase } from "../src/server/db/client.ts";
import * as s from "../src/server/db/schema.ts";
import { withRateScratch } from "./fixtures/rate-limit-scratch.mjs";
import { fixtureTableSnapshot } from "./fixtures/manual-seed-isolation.mjs";
import { outcome } from "./fixtures/account.mjs";

after(closeDatabase);
const encode = value => new TextEncoder().encode(value);
const deferred = () => {
  let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;});
  return {promise,resolve,reject};
};
const runtime = { secret:"request-body-fixture", callbackSecret:"callback-body-fixture",
  code:()=>"123456", sender:async()=>outcome() };
const origin = "https://request-body.example";
const cookie = (await sessionCookie(randomUUID(),runtime)).split(";")[0];
function request(stream, extras={}) {
  return new Request(origin+"/api/test",{method:"POST",duplex:"half",body:stream,
    headers:{"Origin":origin,"Content-Type":"application/json",Cookie:cookie,
      "X-Whapi-Secret":runtime.callbackSecret,...extras}});
}
function controlled(value="{}") {
  let controller,cancels=0,closed=false;
  const stream=new ReadableStream({
    start(c){controller=c;},
    cancel(){cancels++;return new Promise(()=>{});}, // Cancellation must not block.
  },{highWaterMark:0});
  const req=request(stream);
  return {req,stream,get cancels(){return cancels;},get closed(){return closed;},
    chunk(text=value){controller.enqueue(encode(text));},
    close(){closed=true;controller.close();}};
}
function complete(value) {
  return request(new ReadableStream({start(c){c.enqueue(value);c.close();}}));
}
const status = (body,expected) => assert.rejects(body,e=>e.status===expected);

test("8192 bytes inclusive, byte-based limit and fatal UTF-8/JSON validation",async()=>{
  assert.equal(requestBodyLimit,8192);assert.equal(requestBodyDeadlineMs,10000);
  assert.equal(await readJsonBody(complete(encode('"'+ "x".repeat(8190)+'"'))),"x".repeat(8190));
  await status(readJsonBody(complete(encode('"'+ "x".repeat(8191)+'"'))),413);
  await status(readJsonBody(complete(encode('"'+ "أ".repeat(4096)+'"'))),413);
  for(const bytes of [encode("{"),encode(""),new Uint8Array([0x22,0xc3,0x28,0x22]),
    new Uint8Array([0x22,0xff,0x22]),new Uint8Array([0x22,0xe2,0x82])]){
    const req=complete(bytes);await status(readJsonBody(req),422);assert.equal(req.body.locked,false);
  }
  const arabic=encode(JSON.stringify({name:"سوريا"}));
  const req=request(new ReadableStream({start(c){
    for(const byte of arabic)c.enqueue(new Uint8Array([byte]));c.close();
  }}));
  assert.deepEqual(await readJsonBody(req),{name:"سوريا"});
});

test("EOF is required even after a complete JSON chunk; no partial JSON return",async()=>{
  const body=controlled('{"ok":true}');body.chunk();
  let returned=false;
  const reading=readJsonBody(body.req,{deadlineMs:1000}).then(value=>{returned=true;return value;});
  await delay(20);assert.equal(returned,false);body.close();
  assert.deepEqual(await reading,{ok:true});assert.equal(body.req.body.locked,false);
  assert.equal(body.cancels,0);assert.equal(getEventListeners(body.req.signal,"abort").length,0);
});

test("one total deadline wins despite successive chunks; producer cancellation may never resolve",async()=>{
  let chunks=0,cancelled=0,interval,finish;
  const stream=new ReadableStream({
    start(c){
      c.enqueue(encode("{}"));chunks++;
      interval=setInterval(()=>{c.enqueue(encode(" "));chunks++;},20);
      finish=setTimeout(()=>{clearInterval(interval);c.close();},350);
    },
    cancel(){cancelled++;clearInterval(interval);clearTimeout(finish);return new Promise(()=>{});},
  });
  const req=request(stream);
  await status(readJsonBody(req,{deadlineMs:120}),408);
  assert.ok(chunks>=2);assert.equal(cancelled,1);
  assert.equal(req.body.locked,false);assert.equal(getEventListeners(req.signal,"abort").length,0);
});

test("timer/listener/reader cleanup on success, oversize, malformed input, timeout and abort",async t=>{
  const active=new Set(),originalSet=setTimeout,originalClear=clearTimeout;
  t.mock.method(globalThis,"setTimeout",(fn,...args)=>{
    let handle;handle=originalSet(()=>{active.delete(handle);fn();},...args);
    active.add(handle);return handle;
  });
  t.mock.method(globalThis,"clearTimeout",handle=>{active.delete(handle);return originalClear(handle);});
  for(const bytes of [encode("{}"),encode("{"),encode("x".repeat(8193))]){
    const req=complete(bytes);
    try{await readJsonBody(req,{deadlineMs:100});}catch{}
    assert.equal(active.size,0);assert.equal(req.body.locked,false);
    assert.equal(getEventListeners(req.signal,"abort").length,0);
  }
  const pending=controlled();
  await status(readJsonBody(pending.req,{deadlineMs:20}),408);
  assert.equal(active.size,0);assert.equal(pending.req.body.locked,false);
  const abort=new AbortController();
  const req=new Request(origin,{method:"POST",duplex:"half",signal:abort.signal,
    headers:{"Content-Type":"application/json"},body:new ReadableStream({})});
  const reading=readJsonBody(req,{deadlineMs:100});abort.abort();
  await status(reading,408);assert.equal(active.size,0);assert.equal(req.body.locked,false);
  assert.equal(getEventListeners(req.signal,"abort").length,0);
  await delay(120);assert.equal(active.size,0);
});

test("missing/type-mismatched/errored streams are422; pre-aborted read is408",async()=>{
  const empty=new Request(origin,{method:"POST",headers:{"Content-Type":"application/json"}});
  await status(readJsonBody(empty),422);
  await status(readJsonBody(request(new ReadableStream({}),{"Content-Type":"text/plain"})),422);
  await status(readJsonBody(request(new ReadableStream({start(c){c.error(new Error("fixture"));}}))),422);
  await status(readJsonBody(request(new ReadableStream({start(c){c.enqueue("not bytes");c.close();}}))),422);
  const abort=new AbortController();abort.abort();
  const req=new Request(origin,{method:"POST",duplex:"half",signal:abort.signal,
    headers:{"Content-Type":"application/json"},body:new ReadableStream({})});
  await status(readJsonBody(req),408);assert.equal(req.body.locked,false);
});

const cases=[
  ["account registration",a=>a.account.register],["account login",a=>a.account.login],
  ["OTP verify",a=>a.account.verify],["OTP resend",a=>a.account.resend],
  ["profile save",a=>a.account.saveProfile],["vehicle create",a=>a.account.addVehicle],
  ["vehicle edit",a=>req=>a.account.editVehicle(req,randomUUID())],
  ["account deletion",a=>a.account.deleteAccount],["logout",a=>a.account.logout],
  ["Whapi callback",a=>a.account.callback],
  ["registered inspection",a=>a.registered.inspection],["registered towing",a=>a.registered.towing],
  ["registered location",a=>a.registered.location],
  ["guest inspection",a=>a.inspection.create],["guest towing",a=>a.towing.create],
  ["guest location",a=>a.towing.location],
];
function handlers(db,options={deadlineMs:30}){
  return {account:accountHandlers(db,runtime,undefined,options),
    registered:registeredHandlers(db,runtime,options),
    inspection:inspectionHandlers(db,{quotaSecret:"request-body-fixture"},options),
    towing:towingHandlers(db,{quotaSecret:"request-body-fixture"},options)};
}
for(const [name,handler] of cases){
  test(`${name}: incomplete body408 precedes any connection/BEGIN/lock; never-awaited cancel`,async()=>{
    let calls=0;
    const api=handler(handlers(()=>{calls++;throw new Error("Unexpected connection acquisition");}));
    const body=controlled();body.chunk();
    const response=await api(body.req);
    assert.equal(response.status,408);assert.equal(response.headers.get("set-cookie"),null);
    assert.equal(calls,0);assert.equal(body.cancels,1);assert.equal(body.req.body.locked,false);
    assert.equal(getEventListeners(body.req.signal,"abort").length,0);
  });
}

test("every mutation rejects oversized and malformed input before database acquisition",async()=>{
  for(const [name,handler] of cases){
    let calls=0;
    const api=handler(handlers(()=>{calls++;throw new Error("Unexpected DB access");}));
    for(const [bytes,expected] of [[encode("x".repeat(8193)),413],[encode("{"),422],
      [new Uint8Array([0xff]),422]]){
      assert.equal((await api(complete(bytes))).status,expected,name);
    }
    assert.equal(calls,0,name);
  }
});

test("Origin/Host and signed-session/Whapi authorization precede body reading",async()=>{
  const api=handlers(()=>{throw new Error("Unexpected DB access");});
  for(const [invoke,extras,expected] of [
    [api.account.saveProfile,{Origin:"https://forged.example"},403],
    [api.account.saveProfile,{Host:"wrong.example"},403],
    [api.account.saveProfile,{Cookie:""},401],
    [api.registered.inspection,{Origin:"https://forged.example"},403],
    [api.registered.towing,{Cookie:""},401],
    [api.account.callback,{"X-Whapi-Secret":"wrong"},401],
  ]){
    const req=request(new ReadableStream({}, {highWaterMark:0}),extras);
    assert.equal((await invoke(req)).status,expected);
    assert.equal(req.bodyUsed,false);assert.equal(req.body.locked,false);
  }
});

test("late read fulfillment/rejection cannot re-enter any mutation even if cancellation is ineffective",async()=>{
  for(const mode of ["resolve","reject"]){
    for(const [name,handler] of cases){
      const late=deferred();let released=false,cancelled=0,db=0,reads=0;
      const fake={read:()=>++reads===1?late.promise:Promise.resolve({done:true}),
        cancel:()=>{cancelled++;return new Promise(()=>{});},
        releaseLock:()=>{released=true;}};
      const req=new Proxy(request(new ReadableStream({})),{
        get(target,key){return key==="body"?{getReader:()=>fake}:Reflect.get(target,key,target);}
      });
      const api=handler(handlers(()=>{db++;throw new Error("Late DB access");},{deadlineMs:10}));
      assert.equal((await api(req)).status,408,name);
      assert.equal(released,true);assert.equal(cancelled,1);
      if(mode==="resolve")late.resolve({done:false,value:encode('{"homeGovernorateId":null}')});
      else late.reject(new Error("Late producer failure"));
      await delay(0);assert.equal(db,0,name);
    }
  }
});

test("real PG profile/vehicle/callback mutations read EOF before BEGIN/locks and work normally",async()=>{
  await withRateScratch(async f=>{
    const id=randomUUID();
    await f.db.insert(s.users).values({id,name:"Body fixture",phone:"+963900008001",
      passwordHash:"fixture-only",isActive:true,isDeleted:false,createdAt:new Date(),lastActiveAt:new Date()});
    const auth=(await sessionCookie(id,runtime)).split(";")[0];
    const [brand]=await f.db.select().from(s.brands);
    const [fuel]=await f.db.select().from(s.fuelTypes);
    const vehicle={brandGroupId:brand.brandGroupId,brandId:brand.id,fuelTypeId:fuel.id,
      year:2005,vehicleCategory:"car",plateNumber:"BODY-FIXTURE",color:"تجربة",notes:""};
    let current,connections=0,begins=0,locks=0;
    const originals=new Map();
    const observe=client=>{
      if(originals.has(client))return;
      const original=client.query;originals.set(client,original);
      client.query=function(...args){
        const text=typeof args[0]==="string"?args[0]:args[0]?.text??"";
        if(/^begin\b/i.test(text)||/for update|pg_advisory_xact_lock/i.test(text)){
          assert.equal(current.closed,true);assert.equal(current.req.body.locked,false);
          if(/^begin\b/i.test(text))begins++;else locks++;
        }
        return original.apply(this,args);
      };
    };
    f.pool.on("acquire",observe);
    const api=accountHandlers(()=>{
      connections++;assert.equal(current.closed,true);assert.equal(current.req.body.locked,false);return f.db;
    },runtime,undefined,{deadlineMs:2000});
    try{
      let vehicleId;
      for(const [invoke,data,status] of [
        [r=>api.saveProfile(r),{homeGovernorateId:null},200],
        [r=>api.addVehicle(r),vehicle,201],
        [r=>api.editVehicle(r,vehicleId),{...vehicle,color:"جديد"},200],
        [r=>api.callback(r),{statuses:[]},200],
      ]){
        current=controlled(JSON.stringify(data));
        current.req=request(current.req.body,{Cookie:auth});
        current.chunk();const before=connections,pending=invoke(current.req);
        await delay(15);
        assert.equal(connections,before);
        assert.equal(f.pool.idleCount,f.pool.totalCount);
        current.close();
        const response=await pending;assert.equal(response.status,status);
        const value=await response.json();if(status===201)vehicleId=value.id;
      }
      assert.equal(begins,3);assert.ok(locks>=3);
      assert.equal((await f.db.select().from(s.vehicles).where(eq(s.vehicles.id,vehicleId)))[0].color,"جديد");
    }finally{
      f.pool.removeListener("acquire",observe);
      for(const [client,original] of originals)client.query=original;
    }
  });
});

test("real PG pool keeps full headroom during slow profile body; timeout/late bytes write nothing",async()=>{
  await withRateScratch(async f=>{
    const id=randomUUID();
    await f.db.insert(s.users).values({id,name:"Slow body fixture",phone:"+963900008002",
      passwordHash:"fixture-only",isActive:true,isDeleted:false,
      createdAt:new Date("2020-01-01"),lastActiveAt:new Date("2020-01-01")});
    const before=await fixtureTableSnapshot(f.db);
    const auth=(await sessionCookie(id,runtime)).split(";")[0];
    let connections=0;
    const api=accountHandlers(()=>{connections++;return f.db;},runtime,undefined,{deadlineMs:70});
    const body=controlled('{"homeGovernorateId":null}');
    body.req=request(body.req.body,{Cookie:auth});body.chunk();
    const pending=api.saveProfile(body.req);
    assert.equal((await f.db.execute(sql`SELECT 42 AS n`)).rows[0].n,42);
    const active=await f.db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name=${f.name} AND state='idle in transaction'`);
    assert.equal(active.rows[0].n,0);
    assert.equal(f.pool.totalCount,1);assert.equal(f.pool.idleCount,1);
    assert.equal((await pending).status,408);assert.equal(connections,0);
    assert.throws(()=>body.chunk()); // Real Web Stream rejects data after cancellation.
    await delay(20);assert.deepEqual(await fixtureTableSnapshot(f.db),before);
  });
});

test("real Whapi receipt reads complete body before candidate lookup/phone lock and updates delivery",async()=>{
  await withRateScratch(async f=>{
    const setup=accountHandlers(()=>f.db,runtime);
    const register=await setup.register(complete(encode(JSON.stringify({
      name:"Callback body fixture",phone:"+963900008003",password:"body-fixture-password",
    }))));
    assert.equal(register.status,201);
    const before=await f.db.select().from(s.otpVerificationChallenges);
    let calls=0,current;
    const api=accountHandlers(()=>{
      calls++;assert.equal(current.closed,true);assert.equal(current.req.body.locked,false);return f.db;
    },runtime,undefined,{deadlineMs:2000});
    current=controlled(JSON.stringify({statuses:[{id:"mock-message",status:"delivered",
      timestamp:Math.ceil(Date.now()/1000)+1}]}));
    current.chunk();const pending=api.callback(current.req);
    await delay(15);assert.equal(calls,0);assert.equal(f.pool.idleCount,f.pool.totalCount);
    assert.deepEqual(await f.db.select().from(s.otpVerificationChallenges),before);
    current.close();assert.equal((await pending).status,200);
    assert.equal((await f.db.select().from(s.otpVerificationChallenges))[0].deliveryStatus,"delivered");
  });
});

test("bodyless logout remains supported without content-type or authentication",async()=>{
  assert.equal((await handlers(()=>{throw new Error("No DB");}).account.logout(
    new Request(origin,{method:"POST",headers:{Origin:origin}}))).status,200);
});