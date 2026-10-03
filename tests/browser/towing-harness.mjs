import assert from "node:assert/strict";
import { withTowingFixture } from "../fixtures/guest-towing.mjs";

const origin = process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000";

export async function towingBrowserFixture(browser, check, { mobile = false } = {}) {
  await withTowingFixture(async (fixture) => {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const calls = [], errors = [];
    let queue = Promise.resolve(), beforeResponse = null, closing = false;
    page.on("pageerror", (error) => errors.push(error));
    // No canned responses and no live API escape: actual handlers on real PG.
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const work = queue.then(async () => {
        const url = new URL(request.url());
        const handlers = {
          "GET /api/guest-towing/governorates": fixture.api.governorates,
          "GET /api/guest-towing/providers": fixture.api.providers,
          "POST /api/guest-towing/requests": fixture.api.create,
          "POST /api/guest-towing/location": fixture.api.location,
        };
        const handler = handlers[`${request.method()} ${url.pathname}`];
        assert.ok(handler, "Unexpected API call; live fallback prohibited");
        const body = request.postData();
        const response = await handler(new Request(url, {
          method: request.method(), headers: request.headers(), ...(body !== null ? { body } : {}),
        }));
        const text = await response.text();
        const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: request.method(),
          input: body === null ? null : JSON.parse(body), status: response.status, result: JSON.parse(text) };
        calls.push(call);
        return { call, text, headers: Object.fromEntries(response.headers) };
      });
      queue = work.then(() => undefined, (e) => { errors.push(e); });
      try {
        const { call, text, headers } = await work;
        if (beforeResponse) await beforeResponse(call);
        await route.fulfill({ status: call.status, body: text, headers });
      } catch (error) {
        if (closing || request.failure()?.errorText?.includes("ERR_ABORTED")) return;
        errors.push(error);
        await route.abort().catch(() => {});
      }
    });
    // External WhatsApp is prepared, never contacted/sent during testing.
    await context.route("https://wa.me/**", (route) => route.abort());
    try {
      await page.goto(`${origin}/towing/guest`);
      await page.waitForFunction((id) =>
        [...document.querySelector("#origin-governorate").options].some((o) => o.value === id), fixture.gov);
      await check({ ...fixture, page, calls, setBeforeResponse: (fn) => { beforeResponse = fn; } });
      await queue;
      assert.equal(errors.length, 0, errors.map((e) => e.message).join("\n"));
    } finally {
      closing = true;
      await context.close();
      await queue;
    }
  });
}

export async function chooseRoute(page, origin, dest) {
  await page.selectOption("#origin-governorate", origin);
  await page.selectOption("#dest-governorate", dest);
  await page.locator('[data-section="A"]').waitFor();
  await page.locator('[data-section="B"]').waitFor();
}

export async function chooseTowProvider(page, id) {
  await page.locator(`[data-provider-id="${id}"]`).getByRole("button", { name: "أبلغ المزود", exact: true }).click();
  await page.locator('.tow-sheet[role="dialog"]').waitFor();
}

export async function reviewGuest(page) {
  await page.fill("#guest-name", "  ضيف تحقق  ");
  await page.fill("#guest-phone", " +963900000001 ");
  await page.getByTestId("review").click();
  await page.getByTestId("confirm").waitFor();
}

export async function confirmTow(page) {
  assert.equal(await page.getByTestId("confirm").isDisabled(), true);
  await page.getByTestId("terms-check").check();
  await page.getByTestId("confirm").click();
}

export const requestPosts = (calls) => calls.filter((c) => c.method === "POST" && c.path.endsWith("/requests"));