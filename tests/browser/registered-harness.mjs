import assert from "node:assert/strict";
import { withRegisteredFixture } from "../fixtures/registered-services.mjs";
import { appOrigin } from "./account-harness.mjs";
export { appOrigin };
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/pUAAAAASUVORK5CYII=", "base64");

export async function registeredBrowserFixture(browser, check, {
  path = "/inspection", width = 1280, tiles = "success", prepare = async () => {},
} = {}) {
  await withRegisteredFixture(async f => {
    await prepare(f);
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const base = new URL(appOrigin);
    await context.addCookies([{ name: "syriacar_user", value: f.cookieA.split("=")[1],
      domain: base.hostname, path: "/", secure: base.protocol === "https:", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(); page.setDefaultTimeout(14000);
    const calls = [], errors = [];
    let queue = Promise.resolve(), beforeResponse = null, afterHandler = null;
    page.on("pageerror", e => errors.push(e));
    // Whapi never involved. No live WhatsApp navigation/message is permitted.
    await context.route("https://wa.me/**", route => route.fulfill({ status: 200, body: "test-only WhatsApp destination" }));
    await context.route("**/*.tile.openstreetmap.org/**", async route => {
      if (tiles === "failure") return route.abort();
      if (tiles === "timeout") { await new Promise(r => setTimeout(r, 7000)); return route.abort().catch(() => {}); }
      return route.fulfill({ contentType: "image/png", body: pixel });
    });
    await context.route("**/api/**", async route => {
      const request = route.request(), url = new URL(request.url());
      const work = queue.then(async () => {
        const handlers = {
          "GET /api/account/profile": f.accountApi.profile,
          "GET /api/account/vehicles": f.accountApi.vehicles,
          "GET /api/account/references": f.accountApi.references,
          "GET /api/guest-inspection/localities": f.inspectionApi.localities,
          "GET /api/inspection/providers": f.api.providers,
          "POST /api/inspection/requests": f.api.inspection,
          "GET /api/guest-towing/governorates": f.towingApi.governorates,
          "GET /api/guest-towing/providers": f.towingApi.providers,
          "POST /api/towing/requests": f.api.towing,
          "POST /api/towing/location": f.api.location,
        };
        const id = url.pathname.match(/^\/api\/account\/vehicles\/([^/]+)$/)?.[1];
        const handler = handlers[request.method() + " " + url.pathname] ??
          (id && request.method() === "GET" ? req => f.accountApi.vehicle(req, id) : null);
        assert.ok(handler, "Unexpected API; live fallback forbidden");
        const input = request.postData();
        const response = await handler(new Request(url, { method: request.method(), headers: request.headers(),
          ...(input === null ? {} : { body: input }) }));
        const body = await response.text();
        const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: request.method(),
          input: input === null ? null : JSON.parse(input), status: response.status, data: JSON.parse(body) };
        calls.push(call);
        if (afterHandler) await afterHandler(call);
        return { call, response, body };
      });
      queue = work.then(() => {}, error => errors.push(error));
      try {
        const { call, response, body } = await work;
        if (beforeResponse) await beforeResponse(call);
        await route.fulfill({ status: response.status, body, headers: Object.fromEntries(response.headers) });
      } catch (e) {
        if (request.failure()?.errorText?.includes("ERR_ABORTED")) return;
        errors.push(e); await route.abort().catch(() => {});
      }
    });
    try {
      await page.goto(appOrigin + path);
      await check({ ...f, page, context, calls, drain: async () => { await queue; },
        setBeforeResponse: callback => { beforeResponse = callback; },
        setAfterHandler: callback => { afterHandler = callback; } });
      assert.equal(errors.length, 0, errors.map(e => e.message).join("\n"));
    } finally { await context.close(); await queue; }
  });
}
export async function selectInspection(f, region = f.region) {
  await f.page.locator(".rs-vehicle-option").waitFor();
  await f.page.locator(".rs-vehicle-option").first().click();
  await f.page.selectOption("#inspection-governorate", f.gov);
  await f.page.waitForFunction(id => [...document.querySelector("#inspection-region").options].some(o => o.value === id), region);
  await f.page.selectOption("#inspection-region", region);
  await f.page.getByRole("button", { name: "عرض مزودي الفحص", exact: true }).click();
}
export async function selectTowing(f, destination = f.otherGov) {
  await f.page.locator("#tow-origin").waitFor();
  await f.page.selectOption("#tow-destination", destination);
  await f.page.getByRole("button", { name: "عرض مزودي السطحات", exact: true }).click();
  await f.page.getByRole("heading", { name: "باقي المزودين", exact: true }).waitFor();
}
export async function confirmProvider(f, name, { inspection = false } = {}) {
  if (inspection) await f.page.locator(".rs-provider").filter({ hasText: name }).click();
  else await f.page.locator(".rs-tow-card").filter({ hasText: name }).getByRole("button").click();
  const dialog = f.page.getByRole("dialog");
  await dialog.getByRole("button", { name: "أبلغ المزود", exact: true }).click();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "تأكيد وإبلاغ المزود", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}