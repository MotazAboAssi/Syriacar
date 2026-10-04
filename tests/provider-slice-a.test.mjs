import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { SignJWT, decodeJwt } from "jose";
import { eq, desc, sql, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as s from "../src/server/db/schema.ts";
import { closeDatabase, getDatabase } from "../src/server/db/client.ts";
import { assertManualSeedSafety, assertManualSeedEnvironment } from "../src/server/db/seed/manual-seed-safety.ts";
import { sessionCookie, rateLimitHash } from "../src/modules/account/security.ts";
import { accountHandlers } from "../src/modules/account/http.ts";
import { providerHandlers } from "../src/modules/provider-management/http.ts";
import { providerSessionCookie, providerSessionId, providerCookieName } from "../src/modules/provider-management/security.ts";
import { withProviderFixture, password, origin, req, parsed } from "./fixtures/provider.mjs";

let publicBefore;
async function businessDigest() {
  const result = {};
  for (const table of Object.values(s).filter(value => is(value, PgTable))) {
    const tableName = table[PgTable.Symbol.Name];
    const row = await getDatabase().execute(sql.raw(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text), '')) AS digest
      FROM "public"."${tableName}" t`));
    result[tableName] = row.rows[0];
  }
  return result;
}
before(async () => { assertManualSeedSafety(true); publicBefore = await businessDigest(); });
after(async () => {
  try {
    assert.deepEqual(await businessDigest(), publicBefore, "Public business rows must remain unchanged");
    console.log(`Provider Slice A integrity: ${Object.keys(publicBefore).length} public business tables unchanged`);
  } finally { await closeDatabase(); }
});
const run = (name, check) => test(name, () => withProviderFixture(check));

test("fixture guard rejects production/published environments before setup", () => {
  for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "test", REPLIT_DEPLOYMENT: "1" }])
    assert.throws(() => assertManualSeedEnvironment(env, true));
});
run("only active credentials create a separate secure 30-day cookie; profile is a safe projection", async f => {
  const result = await f.logIn();
  assert.equal(result.status, 200);
  const cookie = result.headers.get("set-cookie");
  assert.ok(cookie.startsWith("syriacar_provider="));
  for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=2592000"]) assert.ok(cookie.includes(part));
  assert.equal(result.data.businessName, "مركز اختبار أ");
  for (const name of ["id", "passwordHash", "password_hash", "whatsappNumber", "whatsapp_number", "locationUrl", "location_url"])
    assert.ok(!(name in result.data));
  assert.equal(result.headers.get("cache-control"), "no-store");
  const token = cookie.split(";")[0].split("=")[1], payload = decodeJwt(token);
  assert.equal(payload.role, "provider"); assert.equal(payload.exp - payload.iat, 2592000);
  assert.equal(await providerSessionId(req("/profile", "GET", undefined, cookie), f.runtime), f.a);
  for (const phone of [f.numbers.pending, f.numbers.disabled]) {
    const denied = await f.logIn(phone);
    assert.equal(denied.status, 403);
    assert.ok(denied.headers.get("set-cookie").includes("Max-Age=0"));
  }
});
run("all protected reads and logout recheck disabled status after JWT issuance", async f => {
  await f.db.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, f.a));
  for (const response of [
    () => f.api.profile(req("/profile", "GET", undefined, f.cookieA)),
    () => f.api.references(req("/references", "GET", undefined, f.cookieA)),
    () => f.api.notifications(req("/notifications", "GET", undefined, f.cookieA)),
    () => f.api.notification(req("/notifications/" + f.guestNotice, "GET", undefined, f.cookieA), f.guestNotice),
    () => f.api.logout(req("/logout", "POST", undefined, f.cookieA)),
  ]) {
    const result = await parsed(response()); assert.equal(result.status, 403);
    assert.ok(result.headers.get("set-cookie").includes("Max-Age=0"));
  }
});
run("pending or missing provider cannot use a previously signed provider token", async f => {
  for (const id of [f.pending, randomUUID()]) {
    const cookie = await providerSessionCookie(id, f.runtime);
    assert.equal((await parsed(f.api.profile(req("/profile", "GET", undefined, cookie)))).status, 403);
  }
});
run("user, registration, tampered, duplicate, wrong-role and wrong-purpose cookies fail closed", async f => {
  const userCookie = await sessionCookie(f.user, f.runtime);
  const accountJwt = userCookie.split(";")[0].split("=")[1];
  const providerJwt = f.cookieA.split("=")[1];
  const sign = (purpose, claims) => new SignJWT(claims).setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(+f.now() / 1000)).setExpirationTime(Math.floor(+f.now() / 1000) + 1000)
    .sign(createHmac("sha256", f.runtime.secret).update(purpose).digest());
  const forged = await sign("syriacar:account:jwt", { id: f.a, role: "provider" });
  const wrongRole = await sign("syriacar:provider:jwt", { id: f.a, role: "user" });
  for (const cookie of [userCookie, "syriacar_registration=x", `${providerCookieName}=${accountJwt}`,
    `${providerCookieName}=${forged}`, `${providerCookieName}=${wrongRole}`,
    `${providerCookieName}=${providerJwt.slice(0, -3)}bad`, f.cookieA + "; " + f.cookieA]) {
    assert.equal((await parsed(f.api.profile(req("/profile", "GET", undefined, cookie)))).status, 401);
  }
  const result = await parsed(accountHandlers(() => f.db, f.runtime).profile(req("/profile", "GET", undefined,
    "syriacar_user=" + providerJwt)));
  assert.equal(result.status, 401);
});
run("session expires exactly after 30 days; logout clears only provider cookie", async f => {
  f.advance(2592000000 - 1000);
  assert.equal((await parsed(f.api.profile(req("/profile", "GET", undefined, f.cookieA)))).status, 200);
  const logout = await parsed(f.api.logout(req("/logout", "POST", {}, f.cookieA)));
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.get("set-cookie").startsWith("syriacar_provider="));
  assert.ok(!logout.headers.get("set-cookie").includes("syriacar_user"));
  f.advance(1000);
  assert.equal((await parsed(f.api.profile(req("/profile", "GET", undefined, f.cookieA)))).status, 401);
});
run("existing login policy commits each failure, locks at fifth, and resets after unblock/success", async f => {
  for (let index = 1; index <= 5; index++) {
    const result = await f.logIn(f.numbers.a, "wrong-password");
    assert.equal(result.status, index < 5 ? 401 : 429);
    const bucket = await f.db.execute(sql`SELECT count, EXTRACT(EPOCH FROM(window_expires_at-NOW())) AS window_seconds,
      EXTRACT(EPOCH FROM(blocked_until-NOW())) AS blocked_seconds FROM security_rate_limits
      WHERE key_hash=${rateLimitHash("account.login.failures.phone", "provider:" + f.numbers.a, f.runtime)}`);
    assert.equal(bucket.rows[0].count, index);
    assert.ok(Number(bucket.rows[0].window_seconds) > 880 && Number(bucket.rows[0].window_seconds) <= 900);
    if (index === 5) {
      assert.ok(Number(bucket.rows[0].blocked_seconds) > 880);
      assert.ok(Number(result.headers.get("retry-after")) > 880);
    }
  }
  assert.equal((await f.logIn()).status, 429);
  await f.ageLoginBucket("provider:" + f.numbers.a);
  assert.equal((await f.logIn()).status, 200);
  const rows = await f.db.execute(sql`SELECT count, blocked_until FROM security_rate_limits
    WHERE key_hash=${rateLimitHash("account.login.failures.phone", "provider:" + f.numbers.a, f.runtime)}`);
  assert.equal(rows.rows[0].count, 0); assert.equal(rows.rows[0].blocked_until, null);
});
run("failed-login window expiration starts a new count without a new policy", async f => {
  for (let index = 0; index < 4; index++) assert.equal((await f.logIn(f.numbers.a, "wrong")).status, 401);
  await f.ageLoginBucket("provider:" + f.numbers.a);
  assert.equal((await f.logIn(f.numbers.a, "wrong")).status, 401);
  const result = await f.db.execute(sql`SELECT count FROM security_rate_limits`);
  assert.equal(result.rows[0].count, 1);
});
run("same-phone user and provider budgets remain separate in both directions", async f => {
  const account = accountHandlers(() => f.db, f.runtime);
  const userLogin = pass => parsed(account.login(req("/login", "POST", { phone: f.numbers.a, password: pass })));
  for (let index = 0; index < 5; index++) await f.logIn(f.numbers.a, "wrong");
  assert.equal((await f.logIn()).status, 429);
  assert.equal((await userLogin(password)).status, 200);
  await f.ageLoginBucket("provider:" + f.numbers.a);
  for (let index = 0; index < 5; index++) await userLogin("wrong");
  assert.equal((await userLogin(password)).status, 429);
  assert.equal((await f.logIn()).status, 200);
});
run("simultaneous failed logins on separate pooled clients serialize the same existing budget", async f => {
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => f.logIn(f.numbers.a, "wrong")));
  assert.equal(outcomes.filter(row => row.status === 401).length, 4);
  assert.equal(outcomes.filter(row => row.status === 429).length, 1);
  assert.equal((await f.logIn()).status, 429);
});
run("Guest/Registered/null-contact history uses existing identity and safe request context", async f => {
  const list = await parsed(f.api.notifications(req("/notifications", "GET", undefined, f.cookieA)));
  assert.equal(list.status, 200); assert.equal(list.data.items.length, 3);
  const guest = list.data.items.find(row => row.id === f.guestNotice);
  const registered = list.data.items.find(row => row.id === f.registeredNotice);
  const deleted = list.data.items.find(row => row.id === f.deletedNotice);
  assert.equal(guest.customerName, "عميل زائر"); assert.equal(registered.customerName, "عميل مسجل");
  assert.equal(deleted.customerName, null); assert.equal(deleted.customerPhone, null);
  assert.equal(registered.context.vehicle.year, 2005); assert.equal(guest.context.governorate, f.gov.nameAr);
  const serialized = JSON.stringify(list.data);
  for (const secretField of ["passwordHash", "whatsappNumber", "locationUrl", "plateNumber", "followupNotes", "userId", "serviceRequestId"])
    assert.ok(!serialized.includes(secretField));
  const owned = await parsed(f.api.notification(req("/notifications/" + f.guestNotice, "GET", undefined, f.cookieA), f.guestNotice));
  assert.deepEqual(owned.data, guest);
});
run("provider A/B IDOR and request IDs never grant ownership", async f => {
  for (const [cookie, id] of [[f.cookieA, f.otherNotice], [f.cookieB, f.guestNotice],
    [f.cookieA, f.otherRequest], [f.cookieA, f.guestRequest], [f.cookieA, randomUUID()]]) {
    const result = await parsed(f.api.notification(req("/notifications/" + id, "GET", undefined, cookie), id));
    assert.equal(result.status, 404);
    assert.deepEqual(result.data, { error: "الإشعار غير موجود." });
  }
  const b = await parsed(f.api.notifications(req("/notifications", "GET", undefined, f.cookieB)));
  assert.deepEqual(b.data.items.map(row => row.id), [f.otherNotice]);
  assert.equal(b.data.items[0].context.destination, f.otherGov.nameAr);
});
run("stable keyset pagination preserves microseconds/ties and ignores newer inserts across pages", async f => {
  const added = await f.addNotices(9);
  for (let index = 0; index < added.length; index++) await f.db.execute(sql`UPDATE notifications
    SET created_at=${"2026-10-04T09:00:00.123" + String(Math.floor(index / 2)).padStart(3, "0")}::timestamp
    WHERE id=${added[index].id}`);
  const expected = await f.db.select({ id: s.notifications.id }).from(s.notifications)
    .where(eq(s.notifications.providerId, f.a)).orderBy(desc(s.notifications.createdAt), desc(s.notifications.id));
  let cursor = "", seen = [], pageIndex = 0;
  do {
    const result = await parsed(f.api.notifications(req("/notifications?limit=2" +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), "GET", undefined, f.cookieA)));
    assert.equal(result.status, 200); seen.push(...result.data.items.map(row => row.id));
    cursor = result.data.nextCursor;
    if (pageIndex++ === 0) {
      const [newer] = await f.addNotices(1);
      await f.db.execute(sql`UPDATE notifications SET created_at='2026-10-04T10:00:00' WHERE id=${newer.id}`);
    }
    assert.ok(pageIndex < 15);
  } while (cursor);
  assert.deepEqual(seen, expected.map(row => row.id)); assert.equal(new Set(seen).size, seen.length);
});
run("unknown fields/invalid cursor/id/body are rejected before DB acquisition", async f => {
  let calls = 0;
  const api = providerHandlers(() => { calls++; return f.db; }, f.runtime);
  for (const input of [{ phone: f.numbers.a, password, providerId: f.b }, { phone: "099999", password }, { password }])
    assert.equal((await parsed(api.login(req("/login", "POST", input)))).status, 422);
  for (const query of ["limit=0", "limit=51", "limit=foo", "cursor=bad", "providerId=" + f.b, "limit=1&limit=2"])
    assert.equal((await parsed(api.notifications(req("/notifications?" + query, "GET", undefined, f.cookieA)))).status, 422);
  assert.equal((await parsed(api.notification(req("/notifications/invalid", "GET", undefined, f.cookieA), "invalid"))).status, 422);
  assert.equal((await parsed(api.logout(req("/logout", "POST", { status: "active" }, f.cookieA)))).status, 422);
  assert.equal(calls, 0);
});
run("Origin/Host rejects absent/cross-origin/opaque origins before DB, supports proxy authority", async f => {
  let calls = 0;
  const api = providerHandlers(() => { calls++; return f.db; }, f.runtime);
  for (const headers of [{}, { Origin: "https://other.invalid" }, { Origin: "null" }, { Origin: origin, Host: "other.invalid" }]) {
    const request = new Request(origin + "/api/provider/login", { method: "POST", headers,
      body: JSON.stringify({ phone: f.numbers.a, password }) });
    assert.equal((await parsed(api.login(request))).status, 403);
  }
  assert.equal(calls, 0);
  const proxy = new Request("https://internal.example/api/provider/login", { method: "POST",
    headers: { Origin: origin, Host: new URL(origin).host, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: f.numbers.a, password }) });
  assert.equal((await parsed(api.login(proxy))).status, 200);
});
run("complete body EOF precedes DB even when a valid JSON prefix has arrived", async f => {
  let controller, acquisitions = 0;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const api = providerHandlers(() => { acquisitions++; return f.db; }, f.runtime);
  const response = api.login(new Request(origin + "/api/provider/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: stream, duplex: "half" }));
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ phone: f.numbers.a, password })));
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(acquisitions, 0);
  controller.close();
  assert.equal((await parsed(response)).status, 200); assert.equal(acquisitions, 1);
});
run("body bounds, malformed UTF-8, timeout and unauthenticated logout never acquire DB", async f => {
  let acquired = 0;
  const api = providerHandlers(() => { acquired++; return f.db; }, f.runtime, undefined, { deadlineMs: 20 });
  for (const [body, expected] of [["{", 422], ["x".repeat(8193), 413], [new Uint8Array([0xff]), 422]]) {
    assert.equal((await parsed(api.login(new Request(origin + "/api/provider/login",
      { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body })))).status, expected);
  }
  const never = () => new ReadableStream({ cancel() { return new Promise(() => {}); } });
  const slow = () => new Request(origin + "/api/provider/login", { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: never(), duplex: "half" });
  assert.equal((await parsed(api.login(slow()))).status, 408);
  assert.equal((await parsed(api.logout(new Request(origin + "/api/provider/logout", { method: "POST",
    headers: { Origin: origin }, body: never(), duplex: "half" })))).status, 401);
  assert.equal((await parsed(api.logout(new Request(origin + "/api/provider/logout", { method: "POST",
    headers: { Origin: origin, Cookie: f.cookieA, "Content-Type": "application/json" }, body: never(), duplex: "half" })))).status, 408);
  assert.equal(acquired, 0);
});
run("profile and references are read-only; towing coverage resolves names without private fields", async f => {
  const profile = await parsed(f.api.profile(req("/profile", "GET", undefined, f.cookieB)));
  assert.equal(profile.status, 200); assert.equal(profile.data.serviceType, "towing");
  assert.deepEqual(profile.data.coverage, [f.otherGov.nameAr]);
  const refs = await parsed(f.api.references(req("/references", "GET", undefined, f.cookieA)));
  assert.equal(refs.status, 200); assert.ok(refs.data.regions.some(row => row.id === f.region.id));
  assert.deepEqual(Object.keys(f.api).sort(), ["login", "logout", "notification", "notifications", "profile", "references"]);
  assert.equal((await parsed(f.api.profile(req("/profile")))).status, 401);
});