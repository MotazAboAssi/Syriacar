import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { closeDatabase } from "../../src/server/db/client.ts";
import * as s from "../../src/server/db/schema.ts";
import { inspectionSnapshot } from "../fixtures/guest-inspection.mjs";
import {
  launchBrowser, browserFixture, chooseGovernorate, chooseRegion, chooseProvider, fillIdentity, confirm, posts,
} from "./inspection-harness.mjs";

let browser, original;
test.before(async () => {
  original = await inspectionSnapshot();
  browser = await launchBrowser();
});
test.after(async () => {
  try {
    if (browser) await browser.close();
    if (original) assert.deepEqual(await inspectionSnapshot(), original,
      "Browser fixtures must preserve all table counts, reference values and support configuration");
  } finally {
    await closeDatabase();
  }
});

const run = (check, options) => browserFixture(browser, check, options);
const options = (page) => page.locator("#region option").evaluateAll((items) =>
  items.map((item) => item.value).filter(Boolean).sort());
const requestRows = (tx, gov) => tx.select().from(s.serviceRequests)
  .where(eq(s.serviceRequests.inspectionGovernorateId, gov));

test("governorate changes replace dependent region choices and clear the old selection", () => run(async (f) => {
  const { page, gov, otherGov, region, alternateRegion, emptyRegion, otherRegion, calls } = f;
  await chooseGovernorate(page, gov);
  assert.deepEqual(await options(page), [region, alternateRegion, emptyRegion].sort());
  await chooseRegion(page, region);
  await chooseGovernorate(page, otherGov);
  assert.deepEqual(await options(page), [otherRegion]);
  assert.equal(await page.inputValue("#region"), "");
  assert.equal(await page.inputValue("#governorate"), otherGov);
  assert.equal(await page.locator(".providers-section").count(), 0);
  assert.equal(calls.filter((c) => c.path.endsWith("/localities")).at(-1).query.governorateId, otherGov);
  assert.equal(posts(calls).length, 0);
}));

test("region selection retains the governorate and sends its intended parent relationship", () => run(async (f) => {
  const { page, gov, region, emptyRegion, calls } = f;
  await chooseGovernorate(page, gov);
  await chooseRegion(page, region);
  await chooseRegion(page, emptyRegion, { matched: false });
  assert.equal(await page.inputValue("#governorate"), gov);
  assert.equal(await page.inputValue("#region"), emptyRegion);
  const lookups = calls.filter((c) => c.path.endsWith("/providers"));
  assert.deepEqual(lookups.map((c) => c.query), [
    { governorateId: gov, regionId: region }, { governorateId: gov, regionId: emptyRegion },
  ]);
  assert.equal(posts(calls).length, 0);
}));

test("provider and no-provider states follow locality changes without retaining a provider choice", () => run(async (f) => {
  const { page, gov, region, emptyRegion, ids, calls } = f;
  await chooseGovernorate(page, gov);
  await chooseRegion(page, region);
  assert.equal(await page.locator('input[name="provider"]').count(), 3);
  await chooseProvider(page, ids.active);
  await chooseRegion(page, emptyRegion, { matched: false });
  assert.equal(await page.locator('input[name="provider"]').count(), 0);
  assert.equal(await page.locator(".no-provider-inline .guest-ltr").count(), 0);
  await chooseRegion(page, region);
  assert.equal(await page.locator('input[name="provider"]:checked').count(), 0);
  assert.equal(await page.locator(".no-provider-inline").count(), 0);
  assert.equal(posts(calls).length, 0);
}));

test("explicit matched confirmation submits the intended payload and creates one request/notification", () => run(async (f) => {
  const { page, tx, gov, region, ids, input, calls } = f;
  await chooseGovernorate(page, gov);
  await chooseRegion(page, region);
  await fillIdentity(page);
  // The UI must require provider selection before opening confirmation.
  await page.locator(".submit-button").click();
  await page.locator("#provider-error").waitFor();
  assert.equal(await page.locator("dialog[open]").count(), 0);
  await chooseProvider(page, ids.active);
  await page.locator(".submit-button").click();
  await page.locator("dialog[open]").waitFor();
  await page.locator(".dialog-actions button").first().click();
  assert.equal(posts(calls).length, 0, "Cancel must not write");
  assert.equal((await requestRows(tx, gov)).length, 0);
  await confirm(page);
  await page.locator(".result-provider").waitFor();
  assert.equal(await page.locator(".result-provider").innerText(), "verification only active");
  const submitted = posts(calls);
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].input, input);
  assert.equal(submitted[0].status, 201);
  assert.equal(submitted[0].result.matchingStatus, "matched");
  assert.equal(submitted[0].result.delivery, "not_implemented");
  const rows = await requestRows(tx, gov);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, submitted[0].result.requestId);
  const notices = await tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, rows[0].id));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].providerId, ids.active);
}));

test("a stale provider is rejected on confirmation and fresh choices require reselection", () => run(async (f) => {
  const { page, tx, gov, region, ids, calls } = f;
  await chooseGovernorate(page, gov);
  await chooseRegion(page, region);
  await chooseProvider(page, ids.active);
  await fillIdentity(page);
  await tx.update(s.providers).set({ status: "disabled" }).where(eq(s.providers.id, ids.active));
  await confirm(page);
  await page.locator(".form-message").waitFor();
  await page.waitForFunction((id) =>
    !!document.querySelector(".provider-list") && !document.querySelector(`input[value="${id}"]`), ids.active);
  assert.equal(posts(calls).at(-1).status, 409);
  assert.equal(await page.locator('input[name="provider"]:checked').count(), 0);
  assert.equal(await page.locator(".guest-result").count(), 0);
  assert.equal((await requestRows(tx, gov)).length, 0);
}));

test("a forged cross-governorate region fails lookup and cannot reach confirmation", () => run(async (f) => {
  const { page, tx, gov, otherRegion, calls } = f;
  await chooseGovernorate(page, gov);
  await page.locator("#region").evaluate((select, id) => {
    select.add(new Option("اختيار غير صالح للتحقق", id));
  }, otherRegion);
  await page.selectOption("#region", otherRegion);
  await page.locator(".inline-error").waitFor();
  await fillIdentity(page);
  assert.equal(await page.locator(".submit-button").isDisabled(), true);
  assert.equal(calls.filter((c) => c.path.endsWith("/providers")).at(-1).status, 422);
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.equal(posts(calls).length, 0);
  assert.equal((await requestRows(tx, gov)).length, 0);
}));

test("a locality deactivated after selection cannot be confirmed or persisted", () => run(async (f) => {
  const { page, tx, gov, region, ids, calls } = f;
  await chooseGovernorate(page, gov);
  await chooseRegion(page, region);
  await chooseProvider(page, ids.active);
  await fillIdentity(page);
  await tx.update(s.regions).set({ isActive: false }).where(eq(s.regions.id, region));
  await confirm(page);
  await page.locator("#region-error").waitFor();
  assert.equal(posts(calls).at(-1).status, 422);
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.equal(await page.locator(".guest-result").count(), 0);
  assert.equal((await requestRows(tx, gov)).length, 0);
}));

test("mobile no-match confirmation succeeds without a support number when contact_phone is absent", () => run(async (f) => {
  const { page, tx, gov, emptyRegion, calls } = f;
  assert.equal((await tx.select().from(s.systemConfig).where(eq(s.systemConfig.key, "contact_phone"))).length, 0);
  await chooseGovernorate(page, gov);
  await chooseRegion(page, emptyRegion, { matched: false });
  await fillIdentity(page);
  await confirm(page);
  await page.locator(".result-no-match").waitFor();
  assert.equal(await page.locator(".result-no-match").innerText(), "لا يوجد مزود مطابق في نطاقك.");
  assert.equal(await page.locator(".result-no-match .guest-ltr").count(), 0);
  assert.equal(await page.locator(".guest-result a[href^='tel:']").count(), 0);
  const call = posts(calls).at(-1);
  assert.equal(posts(calls).length, 1);
  assert.equal(call.input.governorateId, gov);
  assert.equal(call.input.regionId, emptyRegion);
  assert.equal(call.input.providerId, null);
  assert.equal(call.status, 201);
  assert.equal(call.result.contactPhone, null);
  assert.equal(call.result.matchingStatus, "no_match");
  const rows = await requestRows(tx, gov);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].matchingStatus, "no_match");
  assert.equal((await tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, rows[0].id))).length, 0);
}, { mobile: true }));

test("a delayed old-locality provider response cannot repopulate a changed governorate", () => run(async (f) => {
  const { page, gov, region, otherGov, calls, setBeforeResponse } = f;
  let release, observed;
  const held = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { observed = resolve; });
  setBeforeResponse(async (call) => {
    if (call.path.endsWith("/providers") && call.query.regionId === region) {
      observed();
      await held;
    }
  });
  try {
    await chooseGovernorate(page, gov);
    await page.selectOption("#region", region);
    await arrived;
    await chooseGovernorate(page, otherGov);
  } finally {
    release();
  }
  await page.waitForTimeout(100);
  assert.equal(await page.inputValue("#governorate"), otherGov);
  assert.equal(await page.inputValue("#region"), "");
  assert.equal(await page.locator(".providers-section").count(), 0);
  assert.equal(await page.locator('input[name="provider"]').count(), 0);
  assert.equal(posts(calls).length, 0);
}));