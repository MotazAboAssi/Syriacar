import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDatabase } from "../src/server/db/client.ts";
import * as s from "../src/server/db/schema.ts";
import { sessionCookie, sessionUserId } from "../src/modules/account/security.ts";
import { accountLimits, AccountLimits } from "../src/modules/account/rate-limits.ts";
import { sendWhapi, whapiEndpoint } from "../src/modules/account/whapi.ts";
import { derivedYear } from "../src/modules/account/vehicles.ts";
import { sendChallenge } from "../src/modules/account/otp.ts";
import { withAccountFixture, req, parsed, outcome, password, accountSnapshot } from "./fixtures/account.mjs";

after(closeDatabase);
const run = (name, check) => test(name, () => withAccountFixture(check));

run("registration stores inactive user, Argon2 and HMAC only; activation atomic, automatic secure login", async f => {
  const p = f.phone(), r = await f.register(p);
  assert.equal(r.status, 201);
  const user = await f.user(p), otp = await f.challenge(p);
  assert.equal(user.isActive, false); assert.equal(user.isDeleted, false);
  assert.match(user.passwordHash, /^\$argon2id\$/);
  assert.equal(otp.maxAttempts, 5); assert.equal(otp.attemptCount, 0);
  assert.equal(otp.expiresAt - otp.lastSentAt, 600000);
  assert.match(otp.codeHash, /^[a-f0-9]{64}$/);
  assert.notEqual(otp.codeHash, f.sends[0].code);
  for (const data of [r.data, otp.sendAttempts]) {
    assert.ok(!JSON.stringify(data).includes(f.sends[0].code)); assert.ok(!JSON.stringify(data).includes("code_hash"));
  }
  const a = await f.activate(p);
  assert.equal(a.status, 200);
  assert.match(a.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax; Max-Age=2592000/);
  assert.equal((await f.user(p)).isActive, true);
  assert.ok((await f.challenge(p)).consumedAt);
  assert.deepEqual(Object.keys(a.data).sort(), ["homeGovernorateId", "name", "phone"]);
  assert.equal((await parsed(await f.api.verify(req("otp", "POST", { phone: p, code: f.sends[0].code })))).status, 422);
  assert.equal((await parsed(await f.api.profile(req("profile", "GET", undefined, a.cookie)))).status, 200);
});
run("registration rejects non-Syrian, short password, unknown fields and blank names", async f => {
  for (const extra of [{ phone: "+19999999999" }, { password: "short" }, { name: " " }, { extra: "forbidden" }]) {
    assert.equal((await f.register(f.phone(), extra)).status, 422);
  }
  assert.equal(f.sends.length, 0);
});
run("inactive re-registration reuses user and expires old code; active duplicate returns exact409", async f => {
  const p = f.phone(); await f.register(p);
  const before = await f.user(p), first = await f.challenge(p), oldCode = f.sends.at(-1).code;
  assert.equal((await f.register(p, { name: "اسم جديد", password: "new-password" })).status, 201);
  assert.equal((await f.user(p)).id, before.id);
  assert.equal((await f.user(p)).name, "اسم جديد");
  const [old] = await f.tx.select().from(s.otpVerificationChallenges).where(eq(s.otpVerificationChallenges.id, first.id));
  assert.equal(old.consumedAt, null); assert.ok(old.expiresAt <= f.now());
  assert.equal((await parsed(await f.api.verify(req("otp", "POST", { phone: p, code: oldCode })))).status, 422);
  await f.activate(p);
  const duplicate = await f.register(p);
  assert.equal(duplicate.status, 409); assert.equal(duplicate.data.error, "الرقم مسجَّل مسبقاً.");
});
run("five incorrect OTP attempts persist, invalidate by expiry not consumption, early resend429", async f => {
  const p = f.phone(); await f.register(p);
  for (let i = 1; i <= 5; i++) {
    const result = await parsed(await f.api.verify(req("otp", "POST", { phone: p, code: i === 1 ? "bad" : "000000" })));
    assert.equal(result.status, 422); assert.equal((await f.challenge(p)).attemptCount, i);
  }
  const row = await f.challenge(p); assert.ok(row.expiresAt <= f.now()); assert.equal(row.consumedAt, null);
  const early = await parsed(await f.api.resend(req("otp/resend", "POST", { phone: p })));
  assert.equal(early.status, 429); assert.equal(early.data.error, "يرجى الانتظار دقيقتين قبل إعادة الإرسال.");
  f.advance(120000);
  assert.equal((await parsed(await f.api.resend(req("otp/resend", "POST", { phone: p })))).status, 200);
  assert.equal((await f.challenge(p)).attemptCount, 0);
  assert.equal((await f.challenge(p)).sendAttemptCount, 1);
  const rows = await f.tx.select().from(s.otpVerificationChallenges).where(eq(s.otpVerificationChallenges.phone, p));
  assert.equal(rows.filter(row => !row.consumedAt && row.expiresAt > f.now()).length, 1);
});
run("resend requires expiration/invalidation AND cooldown; expired OTP cannot activate", async f => {
  const p = f.phone(); await f.register(p);
  f.advance(120001);
  assert.equal((await parsed(await f.api.resend(req("otp/resend", "POST", { phone: p })))).status, 422);
  f.advance(480000);
  assert.equal((await f.activate(p)).status, 422);
  assert.equal((await parsed(await f.api.otpState(req("otp?phone=" + encodeURIComponent(p))))).data.canResend, true);
  assert.equal((await parsed(await f.api.resend(req("otp/resend", "POST", { phone: p })))).status, 200);
});
run("first failed send retries after5s with fresh code/hash and expiry; no third attempt", async f => {
  const p = f.phone(); f.plans.push(outcome("failed"), outcome());
  assert.equal((await f.register(p)).status, 201);
  assert.deepEqual(f.sleeps, [5000]); assert.equal(f.sends.length, 2);
  assert.notEqual(f.sends[0].code, f.sends[1].code);
  const row = await f.challenge(p);
  assert.equal(row.sendAttemptCount, 2); assert.equal(row.retryAt, null); assert.equal(row.sendStatus, "api_accepted");
  assert.equal(row.deliveryStatus, null); assert.equal(row.expiresAt - row.lastSentAt, 600000);
  await sendChallenge(f.tx, row.id, f.runtime, f.limits); assert.equal(f.sends.length, 2);
  assert.equal((await parsed(await f.api.verify(req("otp", "POST", { phone: p, code: f.sends[0].code })))).status, 422);
  assert.equal((await f.activate(p)).status, 200);
});
for (const kind of ["failed", "unknown"]) run(`two ${kind} sends produce generic500 and revised pending criterion`, async f => {
  f.plans.push(outcome(kind), outcome(kind)); const p = f.phone(), result = await f.register(p);
  assert.equal(result.status, 500); assert.equal(result.data.error, "حدث خطأ. حاول مجدداً.");
  const row = await f.challenge(p);
  assert.equal(row.consumedAt, null); assert.ok(row.expiresAt > f.now());
  assert.equal(row.sendAttemptCount, 2); assert.equal(row.retryAt, null);
  assert.ok(["failed", "unknown"].includes(row.sendStatus));
  assert.equal((await f.user(p)).isActive, false);
  assert.equal(result.data.otp.canResend, false);
});
run("login generic failure, inactive only after correct password, fifth failure locks15min", async f => {
  const p = f.phone(); await f.register(p);
  const wrong = async phone => parsed(await f.api.login(req("login", "POST", { phone, password: "wrong-password" })));
  const noAccount = await wrong(f.phone()), incorrect = await wrong(p);
  assert.equal(noAccount.status, 401); assert.deepEqual(noAccount.data, incorrect.data);
  const inactive = await parsed(await f.api.login(req("login", "POST", { phone: p, password })));
  assert.equal(inactive.status, 403); assert.equal(inactive.data.code, "inactive");
  await f.activate(p);
  for (let i = 1; i <= 5; i++) assert.equal((await wrong(p)).status, i < 5 ? 401 : 429);
  assert.equal((await parsed(await f.api.login(req("login", "POST", { phone: p, password })))).status, 429);
  f.advance(900000);
  assert.equal((await parsed(await f.api.login(req("login", "POST", { phone: p, password })))).status, 200);
});
run("30-day sliding JWT, modified/expired cookie, disabled/deleted/missing users rejected", async f => {
  const p = f.phone(); await f.register(p); const auth = await f.activate(p), user = await f.user(p);
  f.advance(29 * 86400000);
  const refreshed = await parsed(await f.api.profile(req("profile", "GET", undefined, auth.cookie)));
  assert.equal(refreshed.status, 200); assert.notEqual(refreshed.cookie, auth.cookie);
  f.advance(2 * 86400000);
  assert.equal((await parsed(await f.api.profile(req("profile", "GET", undefined, auth.cookie)))).status, 401);
  assert.equal((await parsed(await f.api.profile(req("profile", "GET", undefined, refreshed.cookie)))).status, 200);
  assert.equal((await parsed(await f.api.profile(req("profile", "GET", undefined, refreshed.cookie.slice(0, -10) + "corrupted")))).status, 401);
  await f.tx.update(s.users).set({ isActive: false }).where(eq(s.users.id, user.id));
  assert.equal((await parsed(await f.api.profile(req("profile", "GET", undefined, refreshed.cookie)))).status, 401);
  await f.tx.update(s.users).set({ isDeleted: true, name: null, phone: null }).where(eq(s.users.id, user.id));
  assert.equal((await parsed(await f.api.profile(req("profile", "GET", undefined, refreshed.cookie)))).status, 401);
  const missing = (await sessionCookie(randomUUID(), f.runtime)).split(";")[0];
  assert.equal((await parsed(await f.api.profile(req("profile", "GET", undefined, missing)))).status, 401);
});
run("profile active optional governorate only; logout changes no DB and removes cookie", async f => {
  const p = f.phone(); await f.register(p); const auth = await f.activate(p);
  const patch = async input => parsed(await f.api.saveProfile(req("profile", "PATCH", input, auth.cookie)));
  assert.equal((await patch({ homeGovernorateId: f.gov })).data.homeGovernorateId, f.gov);
  assert.equal((await patch({ homeGovernorateId: null })).data.homeGovernorateId, null);
  await f.tx.update(s.governorates).set({ isActive: false }).where(eq(s.governorates.id, f.gov));
  assert.equal((await patch({ homeGovernorateId: f.gov })).status, 422);
  for (const input of [{ name: "forbidden" }, { phone: p }, { homeGovernorateId: randomUUID() }])
    assert.equal((await patch(input)).status, 422);
  const before = await f.user(p); f.advance(1000);
  const logout = await parsed(await f.api.logout(req("logout", "POST", {}, auth.cookie)));
  assert.equal(logout.status, 200); assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.deepEqual(await f.user(p), before);
});
run("vehicle owned CRUD, year boundaries, active references, no forged derived status or VIN", async f => {
  const p = f.phone(); await f.register(p); const auth = await f.activate(p);
  const add = async input => parsed(await f.api.addVehicle(req("vehicles", "POST", input, auth.cookie)));
  const valid = await add(f.vehicleInput); assert.equal(valid.status, 201); assert.equal(valid.data.rejected, false);
  const [row] = await f.tx.select().from(s.vehicles).where(eq(s.vehicles.id, valid.data.id));
  assert.equal(row.yearCategory, "mid"); assert.equal(row.verificationStatus, "pending_verification");
  assert.ok(!("verificationStatus" in valid.data)); assert.ok(!("userId" in valid.data));
  for (const change of [{ year: 1969 }, { year: f.now().getUTCFullYear() + 1 }, { brandGroupId: randomUUID() },
    { vehicleCategory: "bus" }, { yearCategory: "classic" }, { vin: "forbidden" }, { verificationStatus: "verified" }]) {
    assert.equal((await add({ ...f.vehicleInput, ...change })).status, 422);
  }
  for (const [table, id] of [[s.brands, f.brand.id], [s.brandGroups, f.group.id], [s.fuelTypes, f.fuel.id]]) {
    await f.tx.update(table).set({ isActive: false }).where(eq(table.id, id));
    assert.equal((await add(f.vehicleInput)).status, 422);
    await f.tx.update(table).set({ isActive: true }).where(eq(table.id, id));
  }
  const other = f.phone(); await f.register(other); const otherAuth = await f.activate(other);
  assert.equal((await parsed(await f.api.vehicle(req("vehicles/" + row.id, "GET", undefined, otherAuth.cookie), row.id))).status, 404);
  assert.equal((await parsed(await f.api.editVehicle(req("vehicles/" + row.id, "PATCH", f.vehicleInput, otherAuth.cookie), row.id))).status, 404);
  assert.equal((await parsed(await f.api.vehicles(req("vehicles", "GET", undefined, otherAuth.cookie)))).data.length, 0);
});
run("core edits reset verified; non-core edits preserve; ANY actual rejected edit resets", async f => {
  const p = f.phone(); await f.register(p); const auth = await f.activate(p);
  const created = await parsed(await f.api.addVehicle(req("vehicles", "POST", f.vehicleInput, auth.cookie)));
  const id = created.data.id;
  const status = async value => f.tx.update(s.vehicles).set({ verificationStatus: value }).where(eq(s.vehicles.id, id));
  const edit = async change => parsed(await f.api.editVehicle(req("vehicles/" + id, "PATCH", { ...f.vehicleInput, ...change }, auth.cookie), id));
  const read = async () => (await f.tx.select().from(s.vehicles).where(eq(s.vehicles.id, id)))[0];
  await status("verified"); assert.equal((await edit({ color: "لون آخر", notes: "ملاحظة" })).status, 200);
  assert.equal((await read()).verificationStatus, "verified");
  await status("verified"); await edit({ plateNumber: "different" }); assert.equal((await read()).verificationStatus, "pending_verification");
  await status("verified"); await edit({ year: 1970 }); assert.equal((await read()).yearCategory, "classic");
  assert.equal((await read()).verificationStatus, "pending_verification");
  await status("rejected");
  assert.equal((await parsed(await f.api.vehicles(req("vehicles", "GET", undefined, auth.cookie)))).data[0].rejected, true);
  await edit({ year: 1970, notes: "changed" }); assert.equal((await read()).verificationStatus, "pending_verification");
});
run("account deletion atomically anonymizes user/vehicles, leaves all registered+guest requests/notices, allows same-phone registration", async f => {
  const p = f.phone(); await f.register(p); const auth = await f.activate(p), user = await f.user(p);
  const vehicle = await parsed(await f.api.addVehicle(req("vehicles", "POST", f.vehicleInput, auth.cookie)));
  const registered = randomUUID(), guest = randomUUID();
  await f.tx.insert(s.serviceRequests).values([
    { id: registered, serviceType: "towing", userType: "registered", userId: user.id,
      originGovernorateId: f.gov, destGovernorateId: f.otherGov, matchingStatus: "matched", createdAt: f.now() },
    { id: guest, serviceType: "inspection", userType: "guest", guestName: "ضيف", guestPhone: p,
      inspectionGovernorateId: f.gov, inspectionRegionId: f.region, matchingStatus: "matched", createdAt: f.now() },
  ]);
  await f.tx.insert(s.notifications).values([
    { id: randomUUID(), serviceRequestId: registered, providerId: f.ids.towing, serviceType: "towing",
      userType: "registered", userId: user.id, vehicleId: vehicle.data.id, createdAt: f.now() },
    { id: randomUUID(), serviceRequestId: guest, providerId: f.ids.active, serviceType: "inspection",
      userType: "guest", guestName: "ضيف", guestPhone: p, createdAt: f.now() },
  ]);
  const requests = await f.tx.select().from(s.serviceRequests), notices = await f.tx.select().from(s.notifications);
  const result = await parsed(await f.api.deleteAccount(req("profile", "DELETE", {}, auth.cookie)));
  assert.equal(result.status, 200); assert.match(result.headers.get("set-cookie"), /Max-Age=0/);
  const [deleted] = await f.tx.select().from(s.users).where(eq(s.users.id, user.id));
  assert.equal(deleted.isDeleted, true); assert.equal(deleted.isActive, false);
  assert.equal(deleted.name, null); assert.equal(deleted.phone, null); assert.equal(deleted.passwordHash, user.passwordHash);
  const [anonymized] = await f.tx.select().from(s.vehicles).where(eq(s.vehicles.id, vehicle.data.id));
  for (const key of ["plateNumber", "color", "notes"]) assert.equal(anonymized[key], null);
  assert.equal(anonymized.year, 2005); assert.equal(anonymized.userId, user.id);
  assert.ok((await f.challenge(p)).expiresAt <= f.now());
  assert.deepEqual(await f.tx.select().from(s.serviceRequests), requests);
  assert.deepEqual(await f.tx.select().from(s.notifications), notices);
  assert.equal((await parsed(await f.api.profile(req("profile", "GET", undefined, auth.cookie)))).status, 401);
  assert.equal((await parsed(await f.api.login(req("login", "POST", { phone: p, password })))).status, 401);
  assert.equal((await f.register(p)).status, 201); assert.notEqual((await f.user(p)).id, user.id);
});
test("exact in-memory rate-limit constants and IP/phone/OTP isolation", () => {
  assert.deepEqual(accountLimits, { registrationsPerIp: 5, registrationsPerPhone: 3, sendsPerPhone: 5,
    windowMs: 3600000, failedLogins: 5, lockMs: 900000 });
  const l = new AccountLimits();
  for (let i = 0; i < 5; i++) l.registration("phone" + i, "ip", 0);
  assert.throws(() => l.registration("other", "ip", 1), error => error.status === 429);
  for (let i = 0; i < 3; i++) l.registration("same", "ip" + i, 0);
  assert.throws(() => l.registration("same", "newip", 1), error => error.status === 429);
  for (let i = 0; i < 5; i++) l.send("same", 0);
  assert.throws(() => l.send("same", 1), error => error.status === 429);
  l.send("other", 1); l.send("same", 3600000); l.registration("same", "newip", 3600000);
});
test("year derivation exact boundaries", () => {
  for (const [year, expected] of [[1970,"classic"],[1999,"classic"],[2000,"mid"],[2011,"mid"],[2012,"modern"],[2026,"modern"]])
    assert.equal(derivedYear(year), expected);
});
run("same-origin mutations enforced, body bounded, no secrets in transport errors", async f => {
  const p = f.phone(), input = { name: "تجربة", phone: p, password };
  assert.equal((await f.api.register(req("register", "POST", input, undefined, { Origin: "https://attacker.example" }))).status, 403);
  assert.equal((await f.api.register(req("register", "POST", input, undefined, { "Content-Type": "text/plain" }))).status, 422);
  assert.equal((await f.api.register(req("register", "POST", { ...input, name: "a".repeat(9000) }))).status, 413);
  assert.equal((await f.api.profile(req("profile"))).status, 401);
});
test("all account fixture writes roll back, preserving original application records exactly", async () => {
  const before = await accountSnapshot();
  await withAccountFixture(async f => { const p = f.phone(); await f.register(p); await f.activate(p); });
  assert.deepEqual(await accountSnapshot(), before);
});
test("Whapi bearer endpoint digits-only; acceptance not delivery; sanitize all raw errors and payloads", async () => {
  let captured;
  const result = await sendWhapi("+963900000001", "123456", { token: "mock-token", fetch: async (url, options) => {
    captured = { url, options }; return Response.json({ sent: true, message: { id: "mock-id", status: "pending" } });
  } });
  assert.equal(captured.url, whapiEndpoint); assert.ok(!captured.url.includes("mock-token"));
  assert.equal(captured.options.headers.Authorization, "Bearer mock-token");
  assert.deepEqual(JSON.parse(captured.options.body), { to: "963900000001", body: "رمز التحقق الخاص بك: 123456" });
  assert.equal(result.api_outcome, "api_accepted"); assert.equal(result.provider_status, "pending");
  for (const [response, expected] of [[Response.json({ sent: false, error: "code123456 tokenmock-token" }), "failed"],
    [Response.json({ sent: true }), "unknown"], [Response.json({ sent: true, message: { id: "id", status: "failed" } }), "failed"],
    [new Response("error code123456", { status: 500 }), "failed"], [new Response("invalid-json"), "unknown"],
    [Response.json([], { status: 400 }), "failed"]]) {
    const value = await sendWhapi("+963900000001", "123456", { token: "mock-token", fetch: async () => response });
    assert.equal(value.api_outcome, expected);
    assert.ok(!JSON.stringify(value).includes("123456")); assert.ok(!JSON.stringify(value).includes("mock-token"));
  }
  const value = await sendWhapi("+963900000001", "123456", { token: "mock-token", fetch: async () => { throw new Error("123456 mock-token"); } });
  assert.equal(value.api_outcome, "unknown"); assert.ok(!JSON.stringify(value).includes("123456"));
});