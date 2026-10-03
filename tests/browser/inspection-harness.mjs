import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { withInspectionFixture } from "../fixtures/guest-inspection.mjs";

const origin = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000";

export async function launchBrowser() {
  const executablePath = existsSync("/repl/tools/bin/chromium")
    ? "/repl/tools/bin/chromium" : execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  return chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

/** Real rendered app + actual handlers/PG, without commits or a public test bypass. */
export async function browserFixture(browser, check, { mobile = false } = {}) {
  await withInspectionFixture(async (fixture) => {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const calls = [], errors = [];
    let queue = Promise.resolve(), beforeResponse = null;
    page.on("pageerror", (error) => errors.push(error));

    // Fail closed for ALL API calls: no browser write can escape to the live DB.
    // Browser-only interception binds the same server-only handlers as Next.
    // Queue DB work because every fixture uses one transaction-pinned pg client.
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const work = queue.then(async () => {
        const url = new URL(request.url());
        const handlers = {
          "GET /api/guest-inspection/localities": fixture.api.localities,
          "GET /api/guest-inspection/providers": fixture.api.providers,
          "POST /api/guest-inspection/requests": fixture.api.create,
        };
        const handler = handlers[`${request.method()} ${url.pathname}`];
        assert.ok(handler, "Unexpected API call; live fallback is prohibited");
        const postData = request.postData();
        const response = await handler(new Request(url, {
          method: request.method(), headers: request.headers(),
          ...(postData !== null ? { body: postData } : {}),
        }));
        const body = await response.text();
        const call = {
          path: url.pathname, query: Object.fromEntries(url.searchParams), method: request.method(),
          input: postData === null ? null : JSON.parse(postData), status: response.status, result: JSON.parse(body),
        };
        calls.push(call);
        return { call, body, headers: Object.fromEntries(response.headers) };
      });
      queue = work.then(() => undefined, (error) => { errors.push(error); });
      try {
        const { call, body, headers } = await work;
        if (beforeResponse) await beforeResponse(call);
        await route.fulfill({ status: call.status, headers, body });
      } catch (error) {
        if (context.isClosed?.() || request.failure()?.errorText?.includes("ERR_ABORTED")) return;
        errors.push(error);
        await route.abort().catch(() => {});
      }
    });
    try {
      await page.goto(`${origin}/inspection/guest`);
      await page.waitForFunction((id) =>
        [...document.querySelector("#governorate").options].some((option) => option.value === id), fixture.gov);
      await check({
        ...fixture, page, calls,
        setBeforeResponse: (fn) => { beforeResponse = fn; },
        drain: async () => { await queue; },
      });
      assert.equal(errors.length, 0, errors.map((error) => error.message).join("\n"));
    } finally {
      await context.close();
      await queue;
    }
  }, { withoutContactPhone: true });
}

export async function chooseGovernorate(page, id) {
  await page.selectOption("#governorate", id);
  await page.waitForFunction(() => !document.querySelector("#region").disabled);
}

export async function chooseRegion(page, id, { matched = true } = {}) {
  await page.selectOption("#region", id);
  await page.locator(matched ? ".provider-list" : ".no-provider-inline").waitFor();
}

export async function fillIdentity(page) {
  await page.fill("#guest-name", "  ضيف تحقق  ");
  await page.fill("#guest-phone", " +963900000001 ");
}

export async function chooseProvider(page, id) {
  // The native radio is intentionally covered by its visible, clickable label.
  await page.locator(`.provider-option:has(input[value="${id}"])`).click();
  assert.equal(await page.locator(`input[value="${id}"]`).isChecked(), true);
}

export async function confirm(page) {
  await page.locator(".submit-button").click();
  await page.locator("dialog[open]").waitFor();
  const button = page.locator(".dialog-actions button").last();
  assert.equal(await button.isDisabled(), true, "Explicit consent must gate confirmation");
  await page.locator(".terms-check input").check();
  await button.click();
}

export const posts = (calls) => calls.filter((call) => call.method === "POST");