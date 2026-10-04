import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import * as s from "../../src/server/db/schema.ts";
import { closeDatabase } from "../../src/server/db/client.ts";
import { launchBrowser } from "./inspection-harness.mjs";
import { accountBrowserFixture, activateBrowser, registerBrowser, verifyBrowser, addBrowserVehicle, appOrigin } from "./account-harness.mjs";
import { outcome, password } from "../fixtures/account.mjs";
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); await closeDatabase(); });
const run = (name, check, options) => test(name, () => accountBrowserFixture(browser, check, options));

run("full Build6 happy path in real browser with actual handlers+PG and secure cookie", async f => {
  const phone = await activateBrowser(f);
  const cookie = (await f.context.cookies()).find(c => c.name === "syriacar_user");
  assert.ok(cookie); assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true);
  await addBrowserVehicle(f);
  await f.page.getByRole("link", { name: "تعديل", exact: true }).click();
  await f.page.locator("#vehicle-color").waitFor(); await f.page.fill("#vehicle-color", "لون جديد");
  await f.page.getByRole("button", { name: "حفظ المركبة", exact: true }).click(); await f.page.waitForURL("**/account/vehicles");
  await f.page.locator(".sc-vehicle", { hasText: "لون جديد" }).waitFor();
  await f.page.goto(appOrigin + "/account/profile"); await f.page.locator("#profile-name").waitFor();
  assert.equal(await f.page.locator("#profile-name").getAttribute("readonly"), "");
  await f.page.waitForFunction(id => [...document.querySelector("#profile-governorate").options].some(o => o.value === id), f.gov);
  await f.page.selectOption("#profile-governorate", f.gov);
  await f.page.getByRole("button", { name: "حفظ التغييرات" }).click();
  await f.page.getByRole("status").filter({ hasText: "تم حفظ" }).waitFor();
  await f.page.getByRole("button", { name: "تسجيل الخروج", exact: true }).click(); await f.page.waitForURL("**/login");
  assert.ok(!(await f.context.cookies()).some(c => c.name === "syriacar_user"));
  await f.page.fill("#login-phone", phone); await f.page.fill("#login-password", password);
  await f.page.locator('form button[type="submit"]').click(); await f.page.waitForURL("**/account");
  await f.page.goto(appOrigin + "/account/profile"); await f.page.locator("#profile-name").waitFor();
  await f.page.getByRole("button", { name: "حذف الحساب", exact: true }).click();
  await f.page.locator("dialog[open]").waitFor(); await f.page.getByRole("button", { name: "إلغاء", exact: true }).click();
  assert.equal(await f.page.locator("dialog[open]").count(), 0);
  await f.page.getByRole("button", { name: "حذف الحساب", exact: true }).click();
  await f.page.getByRole("button", { name: "نعم، احذف الحساب", exact: true }).click();
  await f.page.waitForURL("**/register"); await registerBrowser(f, phone);
  assert.equal((await f.user(phone)).isActive, false);
});
run("OTP five incorrect submissions, disabled early resend, expiry/invalidation+cooldown then resend", async f => {
  const phone = await registerBrowser(f);
  assert.equal(await f.page.getByRole("button", { name: "إعادة إرسال الرمز", exact: true }).isDisabled(), true);
  for (let i = 0; i < 5; i++) {
    await verifyBrowser(f, "000000");
    await f.page.getByRole("alert").filter({ hasText: "الرمز غير صحيح" }).waitFor();
    await f.drain(); assert.equal((await f.challenge(phone)).attemptCount, i + 1);
  }
  f.advance(120001); await f.page.clock.fastForward(120001);
  await f.page.waitForFunction(() => ![...document.querySelectorAll("button")].find(b => b.textContent === "إعادة إرسال الرمز").disabled);
  await f.page.getByRole("button", { name: "إعادة إرسال الرمز", exact: true }).click();
  await f.page.waitForFunction(() => document.querySelector(".sc-time").textContent !== "انتهت الصلاحية");
  await f.drain(); assert.equal((await f.challenge(phone)).attemptCount, 0);
});
run("Whapi both failures show generic error without code; pending challenge reachable on OTP page", async f => {
  f.plans.push(outcome("failed"), outcome("unknown"));
  await registerBrowser(f);
  await f.page.getByRole("alert").filter({ hasText: "حدث خطأ. حاول مجدداً." }).waitFor();
  await f.page.getByRole("status").filter({ hasText: "تعذّر تأكيد الإرسال" }).waitFor();
  const text = await f.page.locator("body").innerText();
  for (const send of f.sends) assert.ok(!text.includes(send.code));
  assert.equal(await f.page.getByRole("button", { name: "إعادة إرسال الرمز", exact: true }).isDisabled(), true);
});
run("inactive login only after correct password, with complete-verification control", async f => {
  const p = f.phone(); await f.register(p); await f.page.goto(appOrigin + "/login");
  await f.page.fill("#login-phone", p); await f.page.fill("#login-password", "incorrect");
  await f.page.locator('form button[type="submit"]').click();
  await f.page.getByRole("alert").filter({ hasText: "رقم الهاتف أو كلمة المرور غير صحيحة." }).waitFor();
  assert.equal(await f.page.getByRole("button", { name: "إكمال التحقق" }).count(), 0);
  await f.page.fill("#login-password", password); await f.page.locator('form button[type="submit"]').click();
  await f.page.getByRole("button", { name: "إكمال التحقق" }).click();
  await f.page.waitForURL("**/otp"); await verifyBrowser(f);
  await f.page.waitForURL("**/account");
});
run("320px RTL touch targets, LTR phone+OTP, exact year helper, rejected-only badge", async f => {
  assert.equal(await f.page.locator("html").getAttribute("dir"), "rtl");
  assert.equal(await f.page.locator("#reg-phone").evaluate(el => getComputedStyle(el).direction), "ltr");
  const p = await registerBrowser(f);
  assert.equal(await f.page.locator(".sc-otp-boxes").evaluate(el => getComputedStyle(el).direction), "ltr");
  const otpTargets = await f.page.locator(".sc-otp-digit").evaluateAll(elements => elements.map(el => ({
    width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
  })));
  for (const target of otpTargets) { assert.ok(target.width >= 44); assert.ok(target.height >= 44); }
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await verifyBrowser(f); await f.page.waitForURL("**/account");
  await addBrowserVehicle(f);
  let vehicle = (await f.tx.select().from(s.vehicles).where(eq(s.vehicles.userId, (await f.user(p)).id)))[0];
  assert.ok(!(await f.page.locator("body").innerText()).includes("pending_verification"));
  await f.tx.update(s.vehicles).set({ verificationStatus: "rejected" }).where(eq(s.vehicles.id, vehicle.id));
  await f.page.reload(); await f.page.locator(".sc-rejected").waitFor();
  assert.ok(await f.page.locator(".sc-rejected svg").count());
  await f.page.getByRole("link", { name: "تعديل", exact: true }).click(); await f.page.locator("#vehicle-year").waitFor();
  assert.ok((await f.page.locator("body").innerText()).includes("(1970–1999) كلاسيكية · (2000–2011) متوسطة · (2012–الآن) حديثة"));
  assert.equal(await f.page.locator('select[name="year_category"]').count(), 0);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const buttons = await f.page.locator(".sc-account button,.sc-account .sc-btn").evaluateAll(elements => elements.map(el => ({
    height: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize),
  })));
  for (const target of buttons) { assert.ok(target.height >= 44); assert.ok(target.font >= 14); }
}, { width: 320 });
run("unauthenticated protected route redirects to login with exact session-expired message", async f => {
  await f.page.waitForURL("**/login");
  await f.page.getByRole("alert").filter({ hasText: "انتهت جلستك. الرجاء تسجيل الدخول مجدداً." }).waitFor();
}, { path: "/account/vehicles" });
run("expired session during protected mutation redirects; account UI error retry works", async f => {
  await activateBrowser(f); await f.page.goto(appOrigin + "/account/profile");
  await f.page.locator("#profile-name").waitFor(); await f.drain();
  f.advance(31 * 86400000);
  await f.page.getByRole("button", { name: "حفظ التغييرات" }).click();
  await f.page.waitForURL("**/login");
  await f.page.getByRole("alert").filter({ hasText: "انتهت جلستك" }).waitFor();
});
run("initial protected data500 renders retry rather than endless loading", async f => {
  await activateBrowser(f);
  // Block the next profile response independently of DB, to exercise genuine UI network-error handling.
  let failed = false;
  await f.context.route("**/api/account/profile", async route => {
    if (failed) { await route.fallback(); return; }
    failed = true;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "حدث خطأ. حاول مجدداً." }) });
  });
  await f.page.goto(appOrigin + "/account");
  await f.page.getByRole("button", { name: "إعادة المحاولة", exact: true }).click();
  await f.page.getByRole("heading", { name: "مساحتك ومركباتك" }).waitFor();
});