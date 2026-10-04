import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { decodeJwt, SignJWT } from "jose";
import { closeDatabase } from "../src/server/db/client.ts";
import * as s from "../src/server/db/schema.ts";
import { sessionCookie, sessionUserId, registrationKey } from "../src/modules/account/security.ts";
import { registrationCookieName, registrationDuration } from "../src/modules/account/registration-flow.ts";
import { withAccountFixture, req, parsed, password, outcome } from "./fixtures/account.mjs";

after(closeDatabase);
const run = (name, check) => test(name, () => withAccountFixture(check));
const submit = async (f, phone, code, flow, attemptId = flow?.attemptId) =>
  parsed(await f.api.verify(req("otp", "POST", { phone, code, attemptId }, flow?.cookie)));
const status = async (f, phone, flow) => parsed(await f.api.otpState(req(
  `otp?phone=${encodeURIComponent(phone)}&attemptId=${encodeURIComponent(flow.attemptId)}`, "GET", undefined, flow.cookie)));

run("A/B takeover: B's OTP cannot activate B from A's page, including shared-cookie tabs", async f => {
  const p = f.phone();
  await f.register(p, { name: "Registration A" });
  const a = { ...f.flows.get(p) }, codeA = f.sends.at(-1).code;
  await f.register(p, { name: "Registration B", password: "password-chosen-by-B" });
  const b = { ...f.flows.get(p) }, codeB = f.sends.at(-1).code;
  for (const [flow, attempt, code] of [[a, a.attemptId, codeB], [b, a.attemptId, codeB], [a, a.attemptId, codeA]]) {
    const response = await submit(f, p, code, flow, attempt);
    assert.equal(response.status, 422); assert.equal(response.data.code, "otp_flow_invalid");
    assert.equal((await f.user(p)).isActive, false);
    assert.equal((await f.challenge(p)).attemptCount, 0);
    assert.equal((await f.challenge(p)).consumedAt, null);
  }
  assert.equal((await status(f, p, a)).data.code, "otp_flow_invalid");
  assert.equal((await submit(f, p, codeB, b)).status, 200);
  assert.equal((await f.user(p)).name, "Registration B");
});
run("valid A proof and OTP activate only A; proof reveals no credentials and is not a session", async f => {
  const p = f.phone(), r = await f.register(p, { name: "Registration A" }), a = f.flows.get(p);
  const cookie = r.headers.getSetCookie()[0];
  assert.match(cookie, /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800$/);
  assert.ok(!/Domain=/i.test(cookie));
  const claims = decodeJwt(a.cookie.slice(a.cookie.indexOf("=") + 1)), user = await f.user(p);
  assert.deepEqual(Object.keys(claims).sort(), ["attemptId", "exp", "fingerprint", "iat", "purpose"]);
  for (const privateValue of [p, user.name, password, user.passwordHash, f.sends.at(-1).code])
    assert.ok(!Object.values(claims).includes(privateValue));
  await assert.rejects(sessionUserId(req("profile", "GET", undefined, a.cookie), f.runtime));
  assert.equal((await parsed(await f.api.profile(req("profile", "GET", undefined, a.cookie)))).status, 401);
  assert.equal((await submit(f, p, f.sends.at(-1).code, a)).status, 200);
  assert.equal((await f.user(p)).name, "Registration A");
  assert.equal((await submit(f, p, f.sends.at(-1).code, a)).status, 422);
});
run("missing, wrong, tampered, duplicate and session-substituted proofs fail without consuming OTP", async f => {
  const p = f.phone(); await f.register(p);
  const a = { ...f.flows.get(p) }, code = f.sends.at(-1).code;
  const other = f.phone(); await f.register(other);
  const token = a.cookie.slice(a.cookie.indexOf("=") + 1).split(".");
  token[2] = (token[2][0] === "A" ? "B" : "A") + token[2].slice(1);
  const session = (await sessionCookie((await f.user(p)).id, f.runtime)).split(";")[0].split("=")[1];
  for (const cookie of [undefined, f.flows.get(other).cookie,
    `${registrationCookieName}=${token.join(".")}`, `${a.cookie}; ${a.cookie}`,
    `${registrationCookieName}=${session}`]) {
    const result = await submit(f, p, code, { attemptId: a.attemptId, cookie });
    assert.equal(result.data.code, "otp_flow_invalid");
    assert.equal((await f.challenge(p)).attemptCount, 0);
    assert.equal((await f.user(p)).isActive, false);
  }
});
run("expired proof fails even while its OTP remains valid", async f => {
  const p = f.phone(); await f.register(p);
  const flow = f.flows.get(p), payload = decodeJwt(flow.cookie.split("=")[1]);
  const issued = Math.floor(f.now().getTime() / 1000) - registrationDuration - 1;
  const token = await new SignJWT({ attemptId: flow.attemptId, fingerprint: payload.fingerprint, purpose: "registration" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt(issued)
    .setExpirationTime(issued + registrationDuration).sign(registrationKey(f.runtime));
  assert.equal((await submit(f, p, f.sends.at(-1).code, { ...flow, cookie: `${registrationCookieName}=${token}` })).data.code,
    "otp_flow_invalid");
  assert.equal((await f.challenge(p)).attemptCount, 0);
});
run("mismatched or missing page attempt and mismatched phone never consume the target challenge", async f => {
  const p = f.phone(); await f.register(p); const a = { ...f.flows.get(p) };
  for (const attemptId of [randomUUID(), "", null]) {
    assert.equal((await submit(f, p, f.sends.at(-1).code, a, attemptId)).data.code, "otp_flow_invalid");
  }
  const other = f.phone(); await f.register(other);
  assert.equal((await submit(f, other, f.sends.at(-1).code, a)).data.code, "otp_flow_invalid");
  assert.equal((await f.challenge(other)).attemptCount, 0);
});
run("registration fingerprint binds name and password hash, not merely phone/challenge", async f => {
  const p = f.phone(); await f.register(p); const a = f.flows.get(p), code = f.sends.at(-1).code;
  const original = await f.user(p);
  for (const change of [{ name: "unexpected replacement" }, { passwordHash: "unexpected hash" }]) {
    await f.tx.update(s.users).set(change).where(eq(s.users.id, original.id));
    assert.equal((await submit(f, p, code, a)).data.code, "otp_flow_invalid");
    assert.equal((await f.challenge(p)).attemptCount, 0);
    await f.tx.update(s.users).set({ name: original.name, passwordHash: original.passwordHash }).where(eq(s.users.id, original.id));
  }
  assert.equal((await submit(f, p, code, a)).status, 200);
});
run("resend rotates proof and page attempt; old page cannot adopt replacement via GET or POST", async f => {
  const p = f.phone(); await f.register(p); const a = { ...f.flows.get(p) };
  f.advance(600001);
  const sent = await parsed(await f.api.resend(req("otp/resend", "POST", { phone: p, attemptId: a.attemptId }, a.cookie)));
  assert.equal(sent.status, 200);
  const b = f.flows.get(p); assert.notEqual(b.attemptId, a.attemptId);
  for (const cookie of [a.cookie, b.cookie]) {
    assert.equal((await status(f, p, { ...a, cookie })).data.code, "otp_flow_invalid");
    assert.equal((await submit(f, p, f.sends.at(-1).code, { ...a, cookie })).data.code, "otp_flow_invalid");
    assert.equal((await parsed(await f.api.resend(req("otp/resend", "POST",
      { phone: p, attemptId: a.attemptId }, cookie)))).data.code, "otp_flow_invalid");
  }
  assert.equal((await submit(f, p, f.sends.at(-1).code, b)).status, 200);
});
run("inactive login requires current password; continuation still requires OTP", async f => {
  const p = f.phone(); await f.register(p);
  const wrong = await parsed(await f.api.login(req("login", "POST", { phone: p, password: "incorrect" })));
  assert.equal(wrong.status, 401); assert.equal(wrong.data.otp, undefined);
  assert.ok(!wrong.headers.getSetCookie().some(c => c.startsWith(registrationCookieName + "=")));
  const correct = await parsed(await f.api.login(req("login", "POST", { phone: p, password })));
  assert.equal(correct.status, 403); assert.equal(correct.data.code, "inactive");
  assert.equal(correct.data.otp.attemptId, (await f.challenge(p)).id);
  assert.equal((await f.user(p)).isActive, false);
  assert.ok(!correct.headers.getSetCookie().some(c => c.startsWith("syriacar_user=")));
  const flow = f.flows.get(p);
  assert.equal((await submit(f, p, "000000", flow)).data.code, "otp_invalid");
  const activated = await submit(f, p, f.sends.at(-1).code, flow);
  assert.equal(activated.status, 200);
  assert.equal(activated.headers.getSetCookie().length, 2);
  assert.ok(activated.headers.getSetCookie().some(c => c.startsWith(registrationCookieName + "=") && c.includes("Max-Age=0")));
});
run("Whapi failure preserves bound continuation, never activates or issues login; retry keeps attempt identity", async f => {
  const p = f.phone(); f.plans.push(outcome("failed"), outcome("failed"));
  const r = await f.register(p);
  assert.equal(r.status, 500); assert.equal(r.data.otp.attemptId, f.flows.get(p).attemptId);
  assert.equal((await f.user(p)).isActive, false);
  assert.ok(r.headers.getSetCookie().every(c => !c.startsWith("syriacar_user=")));
  assert.equal((await status(f, p, f.flows.get(p))).status, 200);
  f.advance(600001); f.plans.push(outcome("unknown"), outcome("unknown"));
  const result = await parsed(await f.api.resend(f.flowReq("otp/resend", "POST", { phone: p })));
  assert.equal(result.status, 500); assert.equal(result.data.otp.attemptId, f.flows.get(p).attemptId);
  assert.equal((await f.user(p)).isActive, false);
});
run("same-tick registrations and resends have deterministic challenge ordering", async f => {
  const p = f.phone();
  const make = async name => parsed(await f.api.register(req("register", "POST", { name, phone: p, password })));
  const first = await make("A"), second = await make("B");
  assert.notEqual(first.data.attemptId, second.data.attemptId);
  const state = await status(f, p, f.flows.get(p));
  assert.equal(state.data.attemptId, second.data.attemptId);
  assert.equal((await f.activate(p)).status, 200);
});