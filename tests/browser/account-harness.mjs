import assert from "node:assert/strict";
import { withAccountFixture } from "../fixtures/account.mjs";

export const appOrigin = process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000";
export async function accountBrowserFixture(browser, check, { width = 1280, path = "/register" } = {}) {
  await withAccountFixture(async fixture => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    await page.clock.install({ time: fixture.now() });
    const errors = [], calls = [];
    let queue = Promise.resolve(), beforeResponse = null;
    page.on("pageerror", error => errors.push(error));
    await context.route("**/api/**", async route => {
      const request = route.request(), url = new URL(request.url());
      const work = queue.then(async () => {
        const handlers = {
          "POST /api/account/register": fixture.api.register,
          "GET /api/account/otp": fixture.api.otpState,
          "POST /api/account/otp": fixture.api.verify,
          "POST /api/account/otp/resend": fixture.api.resend,
          "POST /api/account/login": fixture.api.login,
          "POST /api/account/logout": fixture.api.logout,
          "GET /api/account/profile": fixture.api.profile,
          "PATCH /api/account/profile": fixture.api.saveProfile,
          "DELETE /api/account/profile": fixture.api.deleteAccount,
          "GET /api/account/references": fixture.api.references,
          "GET /api/account/vehicles": fixture.api.vehicles,
          "POST /api/account/vehicles": fixture.api.addVehicle,
        };
        const id = url.pathname.match(/^\/api\/account\/vehicles\/([^/]+)$/)?.[1];
        const handler = handlers[request.method() + " " + url.pathname] ??
          (id && request.method() === "GET" ? req => fixture.api.vehicle(req, id) :
            id && request.method() === "PATCH" ? req => fixture.api.editVehicle(req, id) : null);
        assert.ok(handler, "Unexpected API; live fallback is forbidden");
        const data = request.postData();
        const response = await handler(new Request(url, { method: request.method(), headers: request.headers(),
          ...(data === null ? {} : { body: data }) }));
        const body = await response.text();
        const call = { path: url.pathname, method: request.method(), status: response.status, data: JSON.parse(body) };
        calls.push(call); if (beforeResponse) await beforeResponse(call);
        return { status: response.status, body, headers: Object.fromEntries(response.headers) };
      });
      queue = work.then(() => {}, error => { errors.push(error); });
      try { await route.fulfill(await work); } catch (error) {
        if (request.failure()?.errorText?.includes("ERR_ABORTED")) return;
        errors.push(error); await route.abort().catch(() => {});
      }
    });
    try {
      await page.goto(appOrigin + path);
      await check({ ...fixture, page, context, calls, drain: async () => {
        // Wait for late hydration/auth requests as well as the queue captured now,
        // before tests advance the server clock beyond a sliding session's expiry.
        await page.waitForLoadState("networkidle"); await queue;
      },
        setBeforeResponse: callback => { beforeResponse = callback; } });
      assert.equal(errors.length, 0, errors.map(error => error.message).join("\n"));
    } finally { await context.close(); await queue; }
  });
}
export async function registerBrowser(f, phone = f.phone()) {
  await f.page.fill("#reg-name", "مالك تحقق");
  await f.page.fill("#reg-phone", phone);
  await f.page.fill("#reg-password", "verification-password");
  await f.page.locator('form button[type="submit"]').click();
  await f.page.waitForURL("**/otp"); await f.page.locator(".sc-time").waitFor();
  return phone;
}
export async function verifyBrowser(f, code = f.sends.at(-1).code) {
  for (let i = 0; i < 6; i++) await f.page.locator(".sc-otp-digit").nth(i).fill(code[i]);
  await f.page.getByRole("button", { name: "تحقق من الرمز", exact: true }).click();
}
export async function activateBrowser(f) {
  const phone = await registerBrowser(f); await verifyBrowser(f);
  await f.page.waitForURL("**/account"); await f.page.getByRole("heading", { name: "مساحتك ومركباتك" }).waitFor();
  return phone;
}
export async function addBrowserVehicle(f) {
  await f.page.goto(appOrigin + "/account/vehicles/new");
  await f.page.locator("#vehicle-group").waitFor();
  await f.page.waitForFunction(id => {
    const options = document.querySelector("#vehicle-group")?.options;
    return options && [...options].some(o => o.value === id);
  }, f.group.id);
  await f.page.selectOption("#vehicle-group", f.group.id);
  await f.page.selectOption("#vehicle-brand", f.brand.id);
  await f.page.fill("#vehicle-year", "2005");
  await f.page.selectOption("#vehicle-fuel", f.fuel.id);
  await f.page.fill("#vehicle-plate", "TEST-ONLY");
  await f.page.fill("#vehicle-color", "لون تحقق");
  await f.page.getByRole("button", { name: "حفظ المركبة", exact: true }).click();
  await f.page.waitForURL("**/account/vehicles");
  await f.page.locator(".sc-vehicle").waitFor();
}