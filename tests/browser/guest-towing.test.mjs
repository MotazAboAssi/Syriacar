import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { closeDatabase } from "../../src/server/db/client.ts";
import * as s from "../../src/server/db/schema.ts";
import { coverageWarning, towingWarning } from "../../src/modules/guest-towing/contracts.ts";
import { inspectionSnapshot } from "../fixtures/guest-inspection.mjs";
import { launchBrowser } from "./inspection-harness.mjs";
import { towingBrowserFixture, chooseRoute, chooseTowProvider, reviewGuest, confirmTow, requestPosts } from "./towing-harness.mjs";

let browser, original;
test.before(async () => { original = await inspectionSnapshot(); browser = await launchBrowser(); });
test.after(async () => {
  try {
    if (browser) await browser.close();
    assert.deepEqual(await inspectionSnapshot(), original, "No towing business/reference/config fixtures may persist");
  } finally { await closeDatabase(); }
});
const run = (check, options) => towingBrowserFixture(browser, check, options);
const rows = (tx, gov) => tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.originGovernorateId, gov));
const notices = (tx, id) => tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, id));
const providerIds = (page, section) => page.locator(`[data-section="${section}"] [data-provider-id]`)
  .evaluateAll((cards) => cards.map((card) => card.dataset.providerId));

test("guest towing starts empty, requires both governorates, has no route region, and renders ordered A/B", () => run(async (f) => {
  const { page, gov, otherGov, ids, calls } = f;
  assert.equal(await page.inputValue("#origin-governorate"), "");
  assert.equal(await page.inputValue("#dest-governorate"), "");
  assert.equal(await page.locator("#region, #location-region").count(), 0);
  await page.locator(".tow-form .submit-button").click();
  assert.equal(await page.locator("#origin-governorate").getAttribute("aria-invalid"), "true");
  assert.equal(await page.locator("#dest-governorate").getAttribute("aria-invalid"), "true");
  await chooseRoute(page, gov, otherGov);
  const sectionA = await providerIds(page, "A");
  assert.equal(sectionA[0], ids.originA);
  assert.equal(sectionA[1], ids.destA);
  assert.deepEqual(sectionA.slice(2).sort(), [ids.otherA1, ids.otherA2].sort());
  assert.deepEqual((await providerIds(page, "B")).sort(), [ids.originOnlyB, ids.destOnlyB, ids.emptyB].sort());
  assert.ok((await page.locator(".tow-results").innerText()).includes(coverageWarning));
  assert.ok((await page.locator(".guest-towing").innerText()).includes(towingWarning));
  assert.equal(requestPosts(calls).length, 0);
}));

test("U-15 guest details, cancel/consent and matched confirmation persist the intended request/notice", () => run(async (f) => {
  const { page, tx, gov, otherGov, ids, input, calls } = f;
  await chooseRoute(page, gov, otherGov);
  await chooseTowProvider(page, ids.originA);
  await page.getByTestId("review").click();
  assert.equal(await page.getByTestId("confirm").count(), 0, "Missing identity cannot reach confirmation");
  await reviewGuest(page);
  assert.equal(requestPosts(calls).length, 0);
  assert.equal(await page.getByTestId("confirm").isDisabled(), true);
  await page.getByRole("button", { name: "إلغاء وإغلاق" }).click();
  assert.equal(requestPosts(calls).length, 0);
  await chooseTowProvider(page, ids.originA);
  await page.getByTestId("review").click();
  await confirmTow(page);
  await page.getByTestId("towing-success").waitFor();
  const call = requestPosts(calls)[0];
  assert.equal(requestPosts(calls).length, 1);
  assert.deepEqual(call.input, input);
  assert.equal(call.status, 201);
  assert.equal(call.result.matchingStatus, "matched");
  assert.ok((await page.getByTestId("towing-success").innerText()).includes("لم ترسل المنصة رسالة واتساب"));
  assert.equal((await rows(tx, gov)).length, 1);
  assert.equal((await notices(tx, call.result.requestId)).length, 1);
  const [provider] = await tx.select().from(s.providers).where(eq(s.providers.id, ids.originA));
  assert.equal(new URL(await page.locator(".tow-success .tow-wa-link").getAttribute("href")).pathname,
    `/${provider.whatsappNumber.slice(1)}`);
  await page.getByTestId("new-request").click();
  assert.equal(await page.inputValue("#origin-governorate"), "");
  assert.equal(await page.inputValue("#dest-governorate"), "");
  assert.equal(await page.locator(".tow-success").count(), 0);
}));

test("mobile Section B -> A -> B reuses one parent and identity, promotes then never downgrades matched", () => run(async (f) => {
  const { page, tx, gov, otherGov, ids, calls } = f;
  await chooseRoute(page, gov, otherGov);
  await chooseTowProvider(page, ids.originOnlyB);
  await reviewGuest(page);
  await confirmTow(page);
  await page.getByTestId("towing-success").waitFor();
  const first = requestPosts(calls)[0];
  assert.equal(first.result.matchingStatus, "no_match");
  assert.equal(await page.locator("#origin-governorate").isDisabled(), true);
  for (const providerId of [ids.originA, ids.destOnlyB]) {
    await page.getByTestId("another-provider").click();
    await chooseTowProvider(page, providerId);
    assert.equal(await page.locator("#guest-name").count(), 0, "Additional provider reuses locked identity");
    await confirmTow(page);
    await page.waitForFunction(() => !document.querySelector(".tow-sheet"));
  }
  const submitted = requestPosts(calls);
  assert.equal(submitted.length, 3);
  assert.deepEqual(submitted.map((c) => c.result.matchingStatus), ["no_match", "matched", "matched"]);
  for (const call of submitted.slice(1)) {
    assert.equal(call.input.requestProof, first.result.requestProof);
    assert.equal(call.result.requestId, first.result.requestId);
    assert.equal(call.input.guestPhone, first.input.guestPhone);
    assert.equal(call.input.guestName, first.input.guestName);
  }
  assert.equal((await rows(tx, gov)).length, 1);
  assert.equal((await notices(tx, first.result.requestId)).length, 3);
}, { mobile: true }));

test("stale provider is rejected in browser, refreshes options, and never persists partial records", () => run(async (f) => {
  const { page, tx, gov, otherGov, ids, calls } = f;
  await chooseRoute(page, gov, otherGov);
  await chooseTowProvider(page, ids.originA);
  await reviewGuest(page);
  await tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, ids.originA));
  await confirmTow(page);
  await page.locator(".tow-form-message").waitFor();
  await page.waitForFunction((id) => !!document.querySelector('[data-section="A"]')
    && !document.querySelector(`[data-provider-id="${id}"]`), ids.originA);
  assert.equal(requestPosts(calls).at(-1).status, 409);
  assert.equal(await page.getByTestId("towing-success").count(), 0);
  assert.equal(await page.locator(".tow-sheet").count(), 0);
  assert.equal((await rows(tx, gov)).length, 0);
}));

test("empty A omits absent support phone, keeps B visible, and B confirmation succeeds as no_match", () => run(async (f) => {
  const { page, tx, gov, extraDest, ids, calls } = f;
  await chooseRoute(page, gov, extraDest);
  const message = page.getByTestId("towing-no-match");
  assert.equal(await message.innerText(), "i\nلا يوجد مزود يغطي هذا المسار");
  assert.equal(await message.locator(".tow-phone, a[href^='tel:']").count(), 0);
  assert.equal((await providerIds(page, "A")).length, 0);
  assert.equal((await providerIds(page, "B")).length, 7);
  await chooseTowProvider(page, ids.emptyB);
  await reviewGuest(page);
  await confirmTow(page);
  await page.getByTestId("towing-success").waitFor();
  const call = requestPosts(calls)[0];
  assert.equal(call.result.matchingStatus, "no_match");
  const [row] = await rows(tx, gov);
  assert.equal(row.destGovernorateId, extraDest);
  assert.equal((await notices(tx, row.id)).length, 1);
}, { mobile: true }));

test("forged or newly inactive route governorate cannot produce provider choices or a confirmation", () => run(async (f) => {
  const { page, tx, gov, extraDest, calls } = f;
  await tx.update(s.governorates).set({ isActive: false }).where(eq(s.governorates.id, extraDest));
  await page.selectOption("#origin-governorate", gov);
  await page.selectOption("#dest-governorate", extraDest);
  await page.locator(".tow-inline-error").waitFor();
  assert.equal(calls.filter((c) => c.path.endsWith("/providers")).at(-1).status, 422);
  assert.equal(await page.locator("[data-provider-id], .tow-sheet").count(), 0);
  assert.equal(requestPosts(calls).length, 0);
  assert.equal((await rows(tx, gov)).length, 0);
}));

test("same governorate route is valid and matching includes origin-only coverage", () => run(async (f) => {
  const { page, gov, ids, calls } = f;
  await chooseRoute(page, gov, gov);
  assert.ok((await providerIds(page, "A")).includes(ids.originOnlyB));
  await chooseTowProvider(page, ids.originOnlyB);
  await reviewGuest(page);
  await confirmTow(page);
  await page.getByTestId("towing-success").waitFor();
  assert.equal(requestPosts(calls)[0].result.matchingStatus, "matched");
}));

test("U-16 manual location uses a dependent region and prepares WhatsApp without changing the stored route", () => run(async (f) => {
  const { page, tx, gov, otherGov, otherBase, otherBaseRegion, ids, calls } = f;
  await chooseRoute(page, gov, otherGov);
  await chooseTowProvider(page, ids.originA);
  await reviewGuest(page);
  await confirmTow(page);
  await page.getByTestId("towing-success").waitFor();
  const request = requestPosts(calls)[0];
  await page.getByRole("button", { name: "أرسل موقعك للمزود", exact: true }).click();
  await page.locator("[data-testid='location-dialog'][open]").waitFor();
  await page.waitForFunction((id) => [...document.querySelector("#location-governorate").options].some((o) => o.value === id), otherBase);
  await page.selectOption("#location-governorate", otherBase);
  await page.waitForFunction(() => !document.querySelector("#location-region").disabled);
  await page.selectOption("#location-region", otherBaseRegion);
  await page.getByRole("button", { name: "أرسل موقعي", exact: true }).click();
  await page.locator(".tow-location-dialog .tow-wa-link").waitFor();
  const link = new URL(await page.locator(".tow-location-dialog .tow-wa-link").getAttribute("href"));
  assert.equal(link.pathname, new URL(request.result.whatsappUrl).pathname);
  assert.ok(link.searchParams.get("text").includes("محافظة محافظة مقر تحقق، منطقة منطقة مقر تحقق"));
  assert.equal(requestPosts(calls).length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith("/location")).length, 1);
  const [stored] = await rows(tx, gov);
  assert.equal(stored.originGovernorateId, gov);
  assert.equal(stored.destGovernorateId, otherGov);
  assert.equal((await notices(tx, stored.id)).length, 1);
}));

test("delayed results for an old route cannot overwrite a changed destination", () => run(async (f) => {
  const { page, gov, otherGov, extraDest, calls, setBeforeResponse } = f;
  let release, arrived;
  const hold = new Promise((resolve) => { release = resolve; });
  const observed = new Promise((resolve) => { arrived = resolve; });
  setBeforeResponse(async (call) => {
    if (call.path.endsWith("/providers") && call.query.destGovernorateId === otherGov) { arrived(); await hold; }
  });
  try {
    await page.selectOption("#origin-governorate", gov);
    await page.selectOption("#dest-governorate", otherGov);
    await observed;
    await page.selectOption("#dest-governorate", extraDest);
    await page.getByTestId("towing-no-match").waitFor();
  } finally { release(); }
  await page.waitForTimeout(100);
  assert.equal(await page.inputValue("#dest-governorate"), extraDest);
  assert.equal((await providerIds(page, "A")).length, 0);
  assert.equal((await providerIds(page, "B")).length, 7);
  assert.equal(requestPosts(calls).length, 0);
}));