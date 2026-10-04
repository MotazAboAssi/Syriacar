import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase } from "../src/server/db/client.ts";
import { withAccountFixture, req, parsed, outcome } from "./fixtures/account.mjs";
after(closeDatabase);
const run = (name, check) => test(name, () => withAccountFixture(check));
const callback = (f, id, status, timestamp = f.now().getTime() / 1000) => f.api.callback(
  req("whapi/callback", "POST", { statuses: [{ id, status, timestamp: String(timestamp), code: 1 }] },
    undefined, { "X-Whapi-Secret": f.runtime.callbackSecret }));

run("Whapi callbacks require HTTPS+secret, ignore unknown ID; API acceptance/pending not failure", async f => {
  const p = f.phone(); await f.register(p);
  const payload = { statuses: [{ id: "mock-1", status: "delivered", timestamp: String(f.now().getTime() / 1000) }] };
  assert.equal((await f.api.callback(req("whapi/callback", "POST", payload))).status, 401);
  assert.equal((await f.api.callback(req("whapi/callback", "POST", payload, undefined, { "X-Whapi-Secret": "wrong" }))).status, 401);
  assert.equal((await f.api.callback(new Request("http://account-verification.example/api/account/whapi/callback", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Whapi-Secret": f.runtime.callbackSecret },
    body: JSON.stringify(payload),
  }))).status, 401);
  assert.equal((await callback(f, "unknown-id", "failed")).status, 200);
  f.advance(1000); await callback(f, "mock-1", "pending");
  const row = await f.challenge(p); assert.equal(row.deliveryStatus, "pending"); assert.equal(row.retryAt, null);
  assert.equal(row.sendStatus, "api_accepted"); assert.equal(f.sends.length, 1);
});
run("callbacks idempotent and ordered; late/future pending/sent/failed cannot regress read delivery", async f => {
  const p = f.phone(); await f.register(p);
  f.advance(1000); await callback(f, "mock-1", "delivered");
  assert.equal((await f.challenge(p)).deliveryStatus, "delivered");
  const delivered = await f.challenge(p);
  await callback(f, "mock-1", "delivered"); assert.deepEqual(await f.challenge(p), delivered);
  await callback(f, "mock-1", "read"); assert.equal((await f.challenge(p)).deliveryStatus, "read");
  const earlier = (f.now().getTime() - 500) / 1000;
  await callback(f, "mock-1", "sent", earlier); assert.equal((await f.challenge(p)).deliveryStatus, "read");
  f.advance(1000); await callback(f, "mock-1", "read");
  for (const status of ["pending", "sent", "failed", "deleted"]) {
    f.advance(1000); await callback(f, "mock-1", status);
    assert.equal((await f.challenge(p)).deliveryStatus, "read");
  }
  assert.equal(f.sends.length, 1); assert.equal((await f.challenge(p)).retryAt, null);
});
run("confirmed current delivery corrects unknown aggregate without overwriting API history", async f => {
  const p = f.phone();
  f.plans.push(outcome("unknown", "ignored"), { ...outcome("unknown"), provider_message_id: "uncertain-message" });
  assert.equal((await f.register(p)).status, 500);
  f.advance(1000); await callback(f, "uncertain-message", "delivered");
  const row = await f.challenge(p);
  assert.equal(row.deliveryStatus, "delivered"); assert.equal(row.sendStatus, "api_accepted");
  assert.equal(row.sendAttempts[1].api_outcome, "unknown"); assert.equal(row.retryAt, null);
  assert.equal(f.sends.length, 2);
});
run("failed delivery retries fresh code, preserves verification attempts, old-attempt callbacks cannot change current", async f => {
  const p = f.phone(); await f.register(p);
  await f.api.verify(f.flowReq("otp", "POST", { phone: p, code: "000000" }));
  f.advance(1000); assert.equal((await callback(f, "mock-1", "failed")).status, 200);
  let row = await f.challenge(p);
  assert.equal(row.attemptCount, 1); assert.equal(row.sendAttemptCount, 2); assert.equal(row.retryAt, null);
  assert.equal(row.deliveryStatus, null); assert.equal(row.sendStatus, "api_accepted");
  assert.equal(row.expiresAt - row.lastSentAt, 600000);
  assert.equal(f.sends.length, 2); assert.notEqual(f.sends[0].code, f.sends[1].code);
  f.advance(1000); await callback(f, "mock-1", "delivered");
  row = await f.challenge(p); assert.equal(row.deliveryStatus, null);
  assert.equal(row.sendAttempts[0].provider_status, "delivered");
  await callback(f, "mock-2", "failed");
  row = await f.challenge(p); assert.equal(row.deliveryStatus, "failed"); assert.equal(row.retryAt, null);
  f.advance(1000); await callback(f, "mock-2", "failed"); assert.equal(f.sends.length, 2);
});
run("expired/consumed challenges never retry; malformed callbacks never leak raw payload", async f => {
  const p = f.phone(); await f.register(p); await f.activate(p); f.advance(1000);
  await callback(f, "mock-1", "failed"); assert.equal(f.sends.length, 1);
  const p2 = f.phone(); await f.register(p2); f.advance(600001);
  await callback(f, "mock-2", "failed"); assert.equal(f.sends.length, 2);
  const result = await parsed(await f.api.callback(req("whapi/callback", "POST", { body: "secret123456" },
    undefined, { "X-Whapi-Secret": f.runtime.callbackSecret })));
  assert.equal(result.status, 422); assert.ok(!JSON.stringify(result.data).includes("secret123456"));
});
run("hourly limit includes automatic retry and never exceeds five actual sends", async f => {
  const p = f.phone();
  f.plans.push(outcome("failed"), outcome("failed")); await f.register(p);
  f.advance(600001);
  f.plans.push(outcome("failed"), outcome("failed")); await f.api.resend(f.flowReq("otp/resend", "POST", { phone: p }));
  f.advance(600001);
  f.plans.push(outcome("failed"));
  const fifth = await parsed(await f.api.resend(f.flowReq("otp/resend", "POST", { phone: p })));
  assert.equal(fifth.status, 429); assert.equal(f.sends.length, 5);
  assert.ok(Number(fifth.headers.get("Retry-After")) > 0);
  assert.equal((await f.challenge(p)).sendAttemptCount, 2);
  assert.equal((await f.challenge(p)).sendAttempts[1].error_code, "rate_limited");
  f.advance(600001);
  assert.equal((await f.api.resend(f.flowReq("otp/resend", "POST", { phone: p }))).status, 429);
});