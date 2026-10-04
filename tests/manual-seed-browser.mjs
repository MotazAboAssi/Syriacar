import assert from "node:assert/strict";
import { launchBrowser } from "./browser/inspection-harness.mjs";
import { appOrigin } from "./browser/account-harness.mjs";
import { manualScenarios, manualLocality, manualTestPassword } from "../src/server/db/seed/manual-scenario-data.ts";

// Explicit manual verification AFTER seeding; not part of automatic test glob.
// Real login + actual Next APIs, not API mocks. No provider requests or OTP writes.
const browser = await launchBrowser();
try {
  for (const scenario of manualScenarios) {
    const context = await browser.newContext({ viewport: { width: 402, height: 874 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await context.route("**/api/**", async route => {
        const req = route.request(), url = new URL(req.url());
        if (req.method() !== "GET" && !(req.method() === "POST" && url.pathname === "/api/account/login")) {
          errors.push("Unexpected mutation prevented: " + url.pathname);
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(appOrigin + "/login");
      await page.fill("#login-phone", scenario.phone);
      await page.fill("#login-password", manualTestPassword);
      await page.locator('form button[type="submit"]').click();
      await page.waitForURL("**/account");
      await page.getByRole("link", { name: /الفحص الفني/ }).waitFor();
      if (scenario.key === "towing-home") {
        await page.goto(appOrigin + "/towing");
        await page.waitForFunction(id => document.querySelector("#tow-origin")?.value === id, manualLocality.governorateId);
        const alternative = await page.locator("#tow-origin option").evaluateAll(
          (options, home) => options.find(x => x.value && x.value !== home)?.value, manualLocality.governorateId);
        assert.ok(alternative); await page.selectOption("#tow-origin", alternative);
        const profile = await page.request.get(appOrigin + "/api/account/profile");
        assert.equal((await profile.json()).homeGovernorateId, manualLocality.governorateId);
      } else {
        await page.goto(appOrigin + "/inspection");
        if (scenario.key === "empty") {
          await page.getByRole("heading", { name: "أضف مركبتك أولًا لاستخدام خدمة الفحص." }).waitFor();
        } else {
          const vehicle = page.locator(".rs-vehicle-option").first(); await vehicle.waitFor();
          assert.equal(await vehicle.isDisabled(), scenario.key === "rejected");
          if (scenario.key === "no-match") {
            await vehicle.click();
            await page.selectOption("#inspection-governorate", manualLocality.governorateId);
            await page.waitForFunction(id => [...document.querySelector("#inspection-region").options].some(x => x.value === id),
              manualLocality.regionId);
            await page.selectOption("#inspection-region", manualLocality.regionId);
            await page.getByRole("button", { name: "عرض مزودي الفحص", exact: true }).click();
            await page.getByRole("button", { name: "تأكيد عدم وجود مزود مطابق", exact: true }).waitFor();
            // Deliberately do not confirm: no service_requests/notifications created.
          }
        }
      }
      assert.equal(errors.length, 0, errors.join("\n"));
      console.log("Passed real login + manual scenario: " + scenario.key);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }