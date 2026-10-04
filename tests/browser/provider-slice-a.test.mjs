import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as s from "../../src/server/db/schema.ts";
import { getDatabase, closeDatabase } from "../../src/server/db/client.ts";
import { assertManualSeedSafety } from "../../src/server/db/seed/manual-seed-safety.ts";
import { launchBrowser } from "./inspection-harness.mjs";
import { providerBrowserFixture, loginProvider, assertProviderView, appOrigin } from "./provider-harness.mjs";

async function businessDigest() {
  assertManualSeedSafety(true);
  const result = {};
  for (const table of Object.values(s).filter(value => is(value, PgTable))) {
    const tableName = table[PgTable.Symbol.Name];
    const rows = await getDatabase().execute(sql.raw(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text), '')) AS digest
      FROM "public"."${tableName}" t`));
    result[tableName] = rows.rows[0];
  }
  return result;
}
let browser, publicBefore;
before(async () => { publicBefore = await businessDigest(); browser = await launchBrowser(); });
after(async () => {
  try {
    await browser?.close();
    assert.deepEqual(await businessDigest(), publicBefore, "Browser checks must not change public business data");
    console.log(`Provider browser integrity: ${Object.keys(publicBefore).length} public business tables unchanged`);
  } finally { await closeDatabase(); }
});
const run = (name, check, options) => test(name, () => providerBrowserFixture(browser, check, options));

run("desktop RTL login keyboard access, read-only profile/references, refresh and provider-only logout", async f => {
  await f.page.locator("#provider-phone").focus(); await f.page.keyboard.press("Tab");
  assert.equal(await f.page.evaluate(() => document.activeElement.id), "provider-password");
  await loginProvider(f);
  assert.ok(f.calls.some(call => call.path === "/api/provider/references" && call.status === 200));
  assert.ok((await f.page.locator(".provider-details").innerText()).includes(f.gov.nameAr));
  assert.equal(await f.page.locator(".provider-app input, .provider-app select, .provider-app textarea").count(), 0);
  await assertProviderView(f);
  await f.page.reload(); await f.page.locator(".provider-profile-banner").waitFor();
  await f.page.getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
  await f.page.waitForURL("**/provider/login");
  assert.ok(!(await f.context.cookies()).some(cookie => cookie.name === "syriacar_provider"));
});
run("320px RTL list/detail displays Guest/Registered/deleted contacts and no raw resource IDs", async f => {
  await loginProvider(f);
  await f.page.getByRole("link", { name: "إشعارات العملاء", exact: true }).click();
  await f.page.locator(".provider-notice").first().waitFor();
  assert.equal(await f.page.locator(".provider-notice").count(), 3);
  await assertProviderView(f);
  const expectedDate = new Intl.DateTimeFormat("ar-SY", { timeZone: "Asia/Damascus",
    year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(f.now());
  assert.equal(await f.page.locator(".provider-date").first().innerText(), expectedDate);
  for (const [id, expected] of [[f.guestNotice, "عميل زائر"], [f.registeredNotice, "عميل مسجل"], [f.deletedNotice, "غير متاح"]]) {
    await f.page.goto(appOrigin + "/provider/notifications/" + id);
    await f.page.locator(".provider-customer").waitFor();
    assert.ok((await f.page.locator(".provider-customer").innerText()).includes(expected));
    if (id === f.deletedNotice) {
      const text = await f.page.locator(".provider-customer").innerText();
      assert.ok(!text.includes("+963") && !text.includes("عميل مسجل"));
    }
    await assertProviderView(f);
  }
}, { width: 320 });
run("mobile load-more appends owned pages once and foreign notification renders no customer data", async f => {
  await f.addNotices(23);
  await loginProvider(f);
  await f.page.getByRole("link", { name: "إشعارات العملاء", exact: true }).click();
  await f.page.locator(".provider-notice").first().waitFor();
  assert.equal(await f.page.locator(".provider-notice").count(), 20);
  await f.page.getByRole("button", { name: "تحميل المزيد", exact: true }).click();
  await f.page.waitForFunction(() => document.querySelectorAll(".provider-notice").length === 26);
  const links = await f.page.locator(".provider-notice").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
  assert.equal(new Set(links).size, 26);
  await assertProviderView(f);
  await f.page.goto(appOrigin + "/provider/notifications/" + f.otherNotice);
  await f.page.getByRole("heading", { name: "تعذّر تحميل الإشعار" }).waitFor();
  assert.ok(f.calls.some(call => call.path.endsWith(f.otherNotice) && call.status === 404));
  assert.equal(await f.page.locator(".provider-customer").count(), 0);
  assert.ok(!(await f.page.locator(".provider-app").innerText()).includes("عميل مزود ب"));
}, { width: 390 });
run("unauthenticated direct detail redirects without showing customer details", async f => {
  await f.page.goto(appOrigin + "/provider/notifications/" + f.guestNotice);
  await f.page.waitForURL("**/provider/login");
  assert.equal(await f.page.locator(".provider-customer").count(), 0);
  assert.ok(f.calls.some(call => call.path === "/api/provider/profile" && call.status === 401));
});
run("disabled after issued JWT rejects next navigation and removes protected UI/cookie", async f => {
  await loginProvider(f); await f.drain();
  await f.db.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, f.a));
  await f.page.getByRole("link", { name: "إشعارات العملاء", exact: true }).click();
  await f.page.waitForURL("**/provider/login");
  assert.ok(f.calls.some(call => call.path === "/api/provider/notifications" && call.status === 403));
  assert.equal(await f.page.locator(".provider-notice, .provider-customer, .provider-profile-banner").count(), 0);
  assert.ok(!(await f.context.cookies()).some(cookie => cookie.name === "syriacar_provider"));
});
run("pending/disabled login shows denial; no registration/OTP/reset links", async f => {
  for (const phone of [f.numbers.pending, f.numbers.disabled]) {
    await f.page.fill("#provider-phone", phone); await f.page.fill("#provider-password", "provider-test-only-password");
    const response = f.page.waitForResponse(res => res.url().endsWith("/api/provider/login") && res.request().method() === "POST");
    await f.page.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
    assert.equal((await response).status(), 403);
    await f.page.locator(".provider-login-error").waitFor();
    assert.ok((await f.page.locator(".provider-login-error").innerText()).includes("غير متاح"));
    assert.ok(f.page.url().endsWith("/provider/login"));
  }
  assert.equal(await f.page.locator('a[href*="register"], a[href*="otp"], a[href*="reset"]').count(), 0);
  await assertProviderView(f);
}, { width: 320 });
run("mobile towing profile resolves coverage/type and towing request route names", async f => {
  await loginProvider(f, f.numbers.b);
  const text = await f.page.locator(".provider-details").innerText();
  assert.ok(text.includes(f.otherGov.nameAr) && text.includes("نوع السطحة"));
  await f.page.goto(appOrigin + "/provider/notifications/" + f.otherNotice);
  await f.page.locator(".provider-request-card").waitFor();
  const route = await f.page.locator(".provider-request-card").innerText();
  assert.ok(route.includes(f.gov.nameAr) && route.includes(f.otherGov.nameAr));
  await assertProviderView(f);
}, { width: 320 });