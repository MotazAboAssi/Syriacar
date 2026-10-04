import test, { after } from "node:test";
import assert from "node:assert/strict";
import { accountSnapshot } from "./fixtures/account.mjs";
import { closeDatabase } from "../src/server/db/client.ts";
after(closeDatabase);
const origin = process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000";

test("real Next registered APIs enforce session/no-store over the proxied transport", async () => {
  const before = await accountSnapshot();
  for (const path of ["/api/inspection/providers?vehicleId=invalid&governorateId=invalid&regionId=invalid",
    "/api/inspection/requests", "/api/towing/requests", "/api/towing/location"]) {
    const mutation = !path.includes("providers?");
    const response = await fetch(origin + path, {
      ...(mutation ? { method: "POST", body: "{}", headers: { Origin: origin, "Content-Type": "application/json" } } : {}),
    });
    assert.equal(response.status, 401);
    const json = await response.json();
    assert.equal(json.error, "انتهت جلستك. الرجاء تسجيل الدخول مجدداً.");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(await accountSnapshot(), before);
});
test("real Next registered mutations reject cross-Origin without creating records", async () => {
  const before = await accountSnapshot();
  for (const path of ["/api/inspection/requests", "/api/towing/requests", "/api/towing/location"]) {
    const response = await fetch(origin + path, { method: "POST", body: "{}",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" } });
    assert.equal(response.status, 403);
  }
  assert.deepEqual(await accountSnapshot(), before);
});
test("registered Next page shells load Arabic RTL and expose no identity or internal secrets", async () => {
  for (const path of ["/inspection", "/towing"]) {
    const response = await fetch(origin + path); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /lang="ar" dir="rtl"/);
    for (const secret of ["WHAPI_TOKEN", "SESSION_SECRET", "password_hash", "code_hash"]) assert.equal(html.includes(secret), false);
  }
});