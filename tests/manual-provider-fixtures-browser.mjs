import assert from "node:assert/strict";
import { launchBrowser } from "./browser/inspection-harness.mjs";
import { appOrigin } from "./browser/account-harness.mjs";
import { manualScenarios, manualLocality, manualTestPassword } from "../src/server/db/seed/manual-scenario-data.ts";
import { providerFixtures, providerFixtureRoutes } from "../src/server/db/seed/provider-fixture-data.ts";
import { derivedYear } from "../src/modules/account/vehicles.ts";

// Explicit live verification AFTER seeding; no automatic data setup/removal.
// Real Next API transport; only login writes allowed. No external messaging.
const browser = await launchBrowser();
const fixture = key => providerFixtures.find(f => f.key === key);
async function check(label, phone, fn) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", e => errors.push(e.message));
  await context.route("**/api/**", async route => {
    const r = route.request(), path = new URL(r.url()).pathname;
    if (r.method() !== "GET" && !(r.method() === "POST" && path === "/api/account/login")) {
      errors.push("Unexpected mutation prevented: " + path);
      return route.abort();
    }
    return route.continue();
  });
  try {
    if (phone) {
      await page.goto(appOrigin + "/login");
      await page.fill("#login-phone", phone); await page.fill("#login-password", manualTestPassword);
      await page.locator('form button[type="submit"]').click(); await page.waitForURL("**/account");
    }
    await fn(page);
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("Passed live provider fixture UI/API: " + label);
  } finally { await context.close(); }
}
async function inspectionResults(page, scenario) {
  const expectedId = manualScenarios.find(s => s.key === scenario).vehicle.id;
  const vehicleResponse = await page.request.get(appOrigin + "/api/account/vehicles");
  assert.equal(vehicleResponse.status(), 200);
  const vehicles = await vehicleResponse.json(), index = vehicles.findIndex(v => v.id === expectedId);
  assert.ok(index >= 0, "Original fixture vehicle must still exist; don't select another manually added vehicle");
  const current = vehicles[index], capabilities = { ...current, yearCategory: derivedYear(current.year) };
  await page.goto(appOrigin + "/inspection");
  const option = page.locator(".rs-vehicle-option").nth(index);
  await option.waitFor();
  assert.equal(await option.isDisabled(), current.rejected);
  if (current.rejected) return; // Preserve manual acceptance edits, don't reset them.
  await option.click();
  await page.selectOption("#inspection-governorate", manualLocality.governorateId);
  await page.waitForFunction(id => [...document.querySelector("#inspection-region").options].some(x => x.value === id), manualLocality.regionId);
  await page.selectOption("#inspection-region", manualLocality.regionId);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/inspection/providers");
  await page.getByRole("button", { name: "عرض مزودي الفحص", exact: true }).click();
  const result = await response; assert.equal(result.status(), 200);
  const data = await result.json();
  assert.ok(data.providers.length >= 3);
  let suitable = 0;
  for (const f of providerFixtures.filter(f => f.capabilities)) {
    const actual = data.providers.find(p => p.id === f.provider.id);
    const matches = Object.entries(f.capabilities).every(([key, value]) => capabilities[key] === value);
    assert.equal(actual.suitable, matches);
    if (matches) suitable++;
  }
  if (!suitable) {
    await page.getByRole("button", { name: "تأكيد عدم وجود مزود مطابق", exact: true }).waitFor();
  } else {
    const onMap = data.providers.find(p => p.id === fixture("inspection-map").provider.id);
    const list = data.providers.find(p => p.id === fixture("inspection-list").provider.id);
    const incompatible = data.providers.find(p => p.id === fixture("inspection-incompatible").provider.id);
    assert.ok(onMap.coordinates);
    assert.equal(list.suitable, true); assert.equal(list.coordinates, null);
    assert.equal(incompatible.suitable, false);
    await page.getByRole("button", { name: new RegExp(list.businessName) }).waitFor();
    // Require the real Leaflet marker; null-coordinate fixture must have none.
    await page.locator(".leaflet-marker-icon").filter({ hasText: "م" }).first().waitFor();
    assert.equal(await page.locator(".leaflet-marker-icon").evaluateAll((markers, name) =>
      markers.filter(m => m.getAttribute("aria-label")?.includes(name)).length, list.businessName), 0);
  }
}
async function towingResults(page, guest = false) {
  await page.goto(appOrigin + (guest ? "/towing/guest" : "/towing"));
  const query = await page.request.get(appOrigin + "/api/guest-towing/providers?" + new URLSearchParams({
    originGovernorateId: providerFixtureRoutes.originGovernorateId,
    destGovernorateId: providerFixtureRoutes.destGovernorateId,
  }));
  const data = await query.json();
  assert.equal(query.status(), 200);
  for (const key of ["towing-a-map", "towing-a-second"]) assert.ok(data.sectionA.some(p => p.id === fixture(key).provider.id));
  assert.ok(data.sectionB.some(p => p.id === fixture("towing-b-map").provider.id));
  if (!guest) {
    await page.waitForFunction(id => document.querySelector("#tow-origin")?.value === id, providerFixtureRoutes.originGovernorateId);
    await page.selectOption("#tow-destination", providerFixtureRoutes.destGovernorateId);
    await page.getByRole("button", { name: "عرض مزودي السطحات", exact: true }).click();
    for (const f of providerFixtures.filter(f => f.provider.serviceType === "towing")) {
      await page.getByRole("heading", { name: f.provider.businessName, exact: true }).waitFor();
    }
  } else {
    // Guest page renders normally; service/query checks don't register requests.
    await page.getByRole("heading", { name: /سطحة/ }).first().waitFor();
  }
  const bOnly = await page.request.get(appOrigin + "/api/guest-towing/providers?" + new URLSearchParams({
    originGovernorateId: providerFixtureRoutes.originGovernorateId,
    destGovernorateId: providerFixtureRoutes.bOnlyDestinationId,
  }));
  const b = await bOnly.json(); assert.equal(bOnly.status(), 200);
  assert.ok(b.sectionB.length >= 3); assert.equal(b.sectionA.filter(p =>
    providerFixtures.some(f => f.provider.id === p.id)).length, 0);
}
try {
  for (const key of ["verified", "pending", "no-match"]) {
    await check("registered inspection " + key, manualScenarios.find(s => s.key === key).phone,
      page => inspectionResults(page, key));
  }
  await check("registered towing A/B and B-only", manualScenarios.find(s => s.key === "towing-home").phone,
    page => towingResults(page));
  await check("guest inspection locality-only", null, async page => {
    await page.goto(appOrigin + "/inspection/guest");
    const response = await page.request.get(appOrigin + "/api/guest-inspection/providers?" + new URLSearchParams(manualLocality));
    assert.equal(response.status(), 200);
    const data = await response.json();
    for (const f of providerFixtures.filter(f => f.provider.serviceType === "inspection")) assert.ok(data.providers.some(p => p.id === f.provider.id));
    await page.getByRole("heading", { name: /فحص/ }).first().waitFor();
  });
  await check("guest towing A/B and B-only", null, page => towingResults(page, true));
} finally { await browser.close(); }