import assert from "node:assert/strict";
import { withProviderFixture, password } from "../fixtures/provider.mjs";

export const appOrigin = process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000";
export async function providerBrowserFixture(browser, check, { width = 1280, path = "/provider/login" } = {}) {
  await withProviderFixture(async fixture => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = [], calls = [];
    let queue = Promise.resolve();
    page.on("pageerror", error => errors.push(error));
    // Every API call is intercepted; real handler + real private PostgreSQL schema.
    // No public auth bypass, live API fallback or public/business fixture writes.
    await context.route("**/api/**", async route => {
      const request = route.request(), url = new URL(request.url());
      const work = queue.then(async () => {
        const handlers = {
          "POST /api/provider/login": fixture.api.login, "POST /api/provider/logout": fixture.api.logout,
          "GET /api/provider/profile": fixture.api.profile, "GET /api/provider/references": fixture.api.references,
          "GET /api/provider/notifications": fixture.api.notifications,
        };
        const id = url.pathname.match(/^\/api\/provider\/notifications\/([^/]+)$/)?.[1];
        const handler = handlers[request.method() + " " + url.pathname] ??
          (id && request.method() === "GET" ? req => fixture.api.notification(req, id) : null);
        assert.ok(handler, "Unexpected API; live fallback forbidden");
        const data = request.postData();
        const response = await handler(new Request(url, { method: request.method(), headers: await request.allHeaders(),
          ...(data === null ? {} : { body: data }) }));
        const body = await response.text();
        calls.push({ path: url.pathname, status: response.status, method: request.method(), data: JSON.parse(body) });
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(";")[0], equals = pair.indexOf("=");
          const name = pair.slice(0, equals), value = pair.slice(equals + 1);
          if (cookie.includes("Max-Age=0")) await context.clearCookies({ name });
          else await context.addCookies([{ name, value, url: appOrigin, httpOnly: true, secure: true, sameSite: "Lax" }]);
        }
        const headers = Object.fromEntries(response.headers); delete headers["set-cookie"];
        return { status: response.status, body, headers };
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
        await page.waitForLoadState("networkidle"); await queue;
      } });
      assert.equal(errors.length, 0, errors.map(error => error.message).join("\n"));
    } finally { await context.close(); await queue; }
  });
}
export async function loginProvider(f, phone = f.numbers.a) {
  await f.page.fill("#provider-phone", phone);
  await f.page.fill("#provider-password", password);
  await f.page.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
  await f.page.waitForURL("**/provider");
  await f.page.locator(".provider-profile-banner").waitFor();
}
export async function assertProviderView(f) {
  const text = await f.page.locator(".provider-app").innerText();
  assert.doesNotMatch(text, /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
  assert.ok(!text.includes("location-private") && !text.includes("password_hash") && !text.includes("whatsapp_number"));
  assert.equal(await f.page.locator(".provider-app").evaluate(node => getComputedStyle(node).direction), "rtl");
  assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No mobile horizontal overflow");
  const storage = await f.page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.ok(!JSON.stringify(storage).includes("+963"), "No contacts in browser storage");
}