import assert from "node:assert/strict";
import test from "node:test";
const origin = process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000";
test("real Next account transport permits proxy Origin and rejects malformed input without DB writes", async () => {
  const response = await fetch(origin + "/api/account/register", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "", phone: "invalid", password: "invalid" }),
  });
  assert.equal(response.status, 422);
  const data = await response.json(); assert.ok(data.fields?.phone);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const attack = await fetch(origin + "/api/account/register", {
    method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "", phone: "invalid", password: "invalid" }),
  });
  assert.equal(attack.status, 403);
});
test("real Next account APIs guard protected data and never expose internal credentials", async () => {
  for (const path of ["profile", "vehicles", "references"]) {
    const response = await fetch(origin + "/api/account/" + path);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "انتهت جلستك. الرجاء تسجيل الدخول مجدداً.");
  }
  const callback = await fetch(origin + "/api/account/whapi/callback", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(callback.status, 401);
});
test("new public auth screens are Arabic RTL with no recovery, Operations or code disclosure", async () => {
  for (const path of ["/register", "/login"]) {
    const response = await fetch(origin + path); assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<html[^>]*lang="ar"/); assert.match(html, /<html[^>]*dir="rtl"/);
    assert.ok(!html.includes("WHAPI_TOKEN")); assert.ok(!html.includes("code_hash"));
    assert.ok(!html.includes("password-reset"));
  }
});