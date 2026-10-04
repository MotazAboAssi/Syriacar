import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { closeDatabase } from "../../src/server/db/client.ts";
import { AccountLimits } from "../../src/modules/account/rate-limits.ts";
import { rateLimitHash } from "../../src/modules/account/security.ts";
import { securityRateLimits as rates } from "../../src/server/db/security-rate-limits.ts";
import { guestScopes as scopes } from "../../src/modules/guest-security/rate-limits.ts";
import { inspectionHandlers } from "../../src/modules/guest-inspection/http.ts";
import { towingHandlers } from "../../src/modules/guest-towing/http.ts";
import * as s from "../../src/server/db/schema.ts";
import { launchBrowser, browserFixture, chooseGovernorate, chooseRegion, chooseProvider, fillIdentity,
  confirm, posts } from "./inspection-harness.mjs";
import { towingBrowserFixture, chooseRoute, chooseTowProvider, reviewGuest, confirmTow, requestPosts } from "./towing-harness.mjs";

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); await closeDatabase(); });
const quotaMessage = "محاولات كثيرة. حاول مجدداً لاحقاً.";
async function prime(f, scope, count) {
  const p = f.input.guestPhone, secret = f.runtime.quotaSecret;
  await new AccountLimits().admit(f.tx, [{ scope, identity: p, limit: 100, seconds: 3600 }], { secret });
  await f.tx.execute(sql`UPDATE ${rates} SET count=${count}
    WHERE scope=${scope} AND key_hash=${rateLimitHash(scope,p,{secret})}`);
}
async function expire(f, scope) {
  await f.tx.execute(sql`UPDATE ${rates} SET window_expires_at=NOW()-INTERVAL '1 second',
    retire_at=NOW()+INTERVAL '1 hour' WHERE scope=${scope}`);
}
// Genuine PG query fault inside a savepoint, never fake HTTP/canned status.
const failingConnection = f => ({ transaction: action => f.tx.transaction(async tx => {
  await tx.execute(sql`SELECT 1/0`); return action(tx);
}) });
async function inspectionInput(f) {
  await chooseGovernorate(f.page, f.gov); await chooseRegion(f.page, f.region);
  await fillIdentity(f.page); await chooseProvider(f.page, f.ids.active);
}
async function towingInput(f) {
  await chooseRoute(f.page, f.gov, f.otherGov); await chooseTowProvider(f.page, f.ids.originA);
  await reviewGuest(f.page);
}

for (const mobile of [false,true]) {
  test(`Inspection ${mobile ? "mobile" : "desktop"}:429 shows server message, retains inputs, no retry, then explicit recovery`, () =>
    browserFixture(browser, async f => {
      await prime(f, scopes.parentPhone, 10); await inspectionInput(f); await confirm(f.page);
      await f.page.locator(".form-message").filter({ hasText: quotaMessage }).waitFor();
      assert.equal(posts(f.calls).length, 1); assert.equal(posts(f.calls)[0].status, 429);
      assert.equal(await f.page.locator(".guest-result").count(), 0);
      assert.equal(await f.page.inputValue("#guest-phone"), " +963900000001 ");
      assert.equal(await f.page.locator(`input[value="${f.ids.active}"]`).isChecked(), true);
      assert.equal(await f.page.locator(".submit-button").isDisabled(), false);
      await expire(f, scopes.parentPhone); await confirm(f.page);
      await f.page.locator(".guest-result").waitFor();
      assert.equal(posts(f.calls).length, 2); assert.equal(posts(f.calls)[1].status, 201);
    }, { mobile }));

  test(`Towing ${mobile ? "mobile" : "desktop"}: first parent429 creates no success/proof/link, retains identity and route, then recovers`, () =>
    towingBrowserFixture(browser, async f => {
      await prime(f, scopes.parentPhone, 10); await towingInput(f); await confirmTow(f.page);
      await f.page.getByRole("alert").filter({ hasText: quotaMessage }).waitFor();
      assert.equal(requestPosts(f.calls).length, 1);
      assert.deepEqual(Object.keys(requestPosts(f.calls)[0].result), ["error"]);
      assert.equal(await f.page.getByTestId("towing-success").count(), 0);
      assert.equal(await f.page.locator(".tow-wa-link").count(), 0);
      assert.equal(await f.page.inputValue("#origin-governorate"), f.gov);
      assert.equal(await f.page.getByTestId("confirm").isDisabled(), false);
      await expire(f, scopes.parentPhone); await f.page.getByTestId("confirm").click();
      await f.page.getByTestId("towing-success").waitFor();
      const calls = requestPosts(f.calls);
      assert.equal(calls.length, 2); assert.equal(calls[1].status, 201);
      assert.equal(calls[1].input.guestPhone, calls[0].input.guestPhone);
      assert.equal(calls[1].input.requestProof, undefined);
    }, { mobile }));
}

test("Inspection actual PG503 stays known failure, releases submission and explicit retry succeeds", () =>
  browserFixture(browser, async f => {
    const original = f.api.create;
    f.api.create = inspectionHandlers(() => failingConnection(f), f.runtime).create;
    await inspectionInput(f); await confirm(f.page);
    await f.page.locator(".form-message").filter({ hasText: "حدث خطأ أثناء تسجيل الطلب" }).waitFor();
    assert.equal(posts(f.calls)[0].status, 503);
    assert.equal(await f.page.locator(".guest-result,.unknown-result").count(), 0);
    assert.equal(await f.page.locator(".submit-button").isDisabled(), false);
    f.api.create = original; await confirm(f.page); await f.page.locator(".guest-result").waitFor();
    assert.equal(posts(f.calls).length, 2);
  }));

for (const status of [429,503]) {
  test(`Towing existing parent ${status}: no replacement proof or upgrade; explicit retry uses original proof/identity`, () =>
    towingBrowserFixture(browser, async f => {
      await chooseRoute(f.page, f.gov, f.otherGov); await chooseTowProvider(f.page, f.ids.originOnlyB);
      await reviewGuest(f.page); await confirmTow(f.page); await f.page.getByTestId("towing-success").waitFor();
      const first = requestPosts(f.calls)[0], original = f.api.create;
      if (status === 429) await prime(f, scopes.notificationPhone, 40);
      else f.api.create = towingHandlers(() => failingConnection(f), f.runtime).create;
      await f.page.getByTestId("another-provider").click(); await chooseTowProvider(f.page, f.ids.originA);
      await confirmTow(f.page);
      await f.page.getByRole("alert").filter({ hasText: status === 429 ? quotaMessage : "تعذر تسجيل الإشعار" }).waitFor();
      const denied = requestPosts(f.calls)[1];
      assert.equal(denied.status, status); assert.deepEqual(Object.keys(denied.result), ["error"]);
      assert.equal(denied.input.requestProof, first.result.requestProof);
      assert.equal(await f.page.locator("#guest-name").count(), 0);
      assert.equal(await f.page.locator("#origin-governorate").isDisabled(), true);
      assert.equal(await f.page.getByTestId("confirm").isDisabled(), false);
      const parent = (await f.tx.select().from(s.serviceRequests)).find(r => r.id === first.result.requestId);
      assert.equal(parent.matchingStatus, "no_match");
      if (status === 429) await expire(f, scopes.notificationPhone);
      else f.api.create = original;
      await f.page.getByTestId("confirm").click(); await f.page.waitForFunction(() => !document.querySelector(".tow-sheet"));
      const recovered = requestPosts(f.calls)[2];
      assert.equal(recovered.status, 201); assert.equal(recovered.input.requestProof, first.result.requestProof);
      assert.equal(recovered.result.requestId, first.result.requestId);
      assert.equal(recovered.result.matchingStatus, "matched");
    }, { mobile: true }));
}