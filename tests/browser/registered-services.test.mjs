import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import * as s from "../../src/server/db/schema.ts";
import { closeDatabase } from "../../src/server/db/client.ts";
import { launchBrowser } from "./inspection-harness.mjs";
import { registeredBrowserFixture as fixture, selectInspection, selectTowing, confirmProvider, appOrigin } from "./registered-harness.mjs";
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); await closeDatabase(); });
const run = (name, check, options) => test(name, () => fixture(browser, check, options));
const mutations = f => f.calls.filter(c => c.method === "POST");

run("registered vehicle-empty links to U07 and makes no request", async f => {
  await f.page.getByRole("heading", { name: "أضف مركبتك أولًا لاستخدام خدمة الفحص." }).waitFor();
  assert.equal(await f.page.getByRole("link", { name: "إضافة مركبة", exact: true }).getAttribute("href"), "/account/vehicles/new");
  assert.equal(await f.page.locator("#inspection-governorate").count(), 0);
  assert.equal(mutations(f).length, 0);
}, { prepare: f => f.tx.delete(s.vehicles).where(eq(s.vehicles.userId, f.a)) });

run("rejected vehicle cannot be selected, edit remains U07 and pending is never shown", async f => {
  await f.page.locator(".rs-vehicle-option").waitFor();
  assert.equal(await f.page.locator(".rs-vehicle-option").isDisabled(), true);
  assert.match(await f.page.getByRole("link", { name: "تعديل المركبة" }).getAttribute("href"), /\/edit$/);
  assert.equal(await f.page.getByRole("button", { name: "عرض مزودي الفحص" }).isDisabled(), true);
  assert.doesNotMatch(await f.page.locator("main").innerText(), /pending_verification|قيد التوثيق/);
  assert.equal(mutations(f).length, 0);
}, { prepare: f => f.tx.update(s.vehicles).set({ verificationStatus: "rejected" }).where(eq(s.vehicles.id, f.va)) });

run("inspection mixed map/list has suitable and unsuitable markers; no-coordinate suitable is list-only", async f => {
  await selectInspection(f);
  await f.page.locator(".leaflet-marker-icon").first().waitFor();
  await f.page.waitForFunction(() => document.querySelectorAll(".leaflet-marker-icon").length === 2);
  assert.equal(await f.page.locator(".rs-marker-unsuitable").count(), 1);
  const list = f.page.locator(".rs-provider-list");
  await list.getByText("verification only capable", { exact: true }).waitFor();
  assert.equal(await f.page.locator('.leaflet-marker-icon[title*="capable"]').count(), 0);
  await confirmProvider(f, "verification only capable", { inspection: true });
  const call = mutations(f)[0]; assert.equal(call.status, 201);
  const link = new URL(await f.page.getByRole("link", { name: "فتح واتساب وإرسال الرسالة" }).getAttribute("href"));
  assert.equal(link.pathname, "/" + f.capable.whatsappNumber.slice(1));
  assert.doesNotMatch(link.searchParams.get("text"), /رقمي/);
}, { prepare: async f => {
  await f.tx.update(s.providers).set({ locationLat: "33.5", locationLng: "36.2" }).where(eq(s.providers.id, f.active.id));
  await copyCapabilities(f, f.active.id);
  const [other] = await f.tx.select().from(s.providers).where(eq(s.providers.businessName, "verification only oldClosure"));
  await f.tx.update(s.providers).set({ locationLat: "33.51", locationLng: "36.21" }).where(eq(s.providers.id, other.id));
} });

async function copyCapabilities(f, id) {
  await f.tx.insert(s.providerBrandGroups).values({ providerId: id, brandGroupId: f.group.id });
  await f.tx.insert(s.providerBrands).values({ providerId: id, brandId: f.brand.id });
  await f.tx.insert(s.providerFuelTypes).values({ providerId: id, fuelTypeId: f.fuel.id });
  await f.tx.insert(s.providerYearCategories).values({ providerId: id, yearCategory: "classic" });
  await f.tx.insert(s.providerVehicleCategories).values({ providerId: id, vehicleCategory: "truck" });
}

run("invalid-coordinate suitable remains list-only and can be confirmed", async f => {
  await selectInspection(f); await confirmProvider(f, "verification only capable", { inspection: true });
  assert.equal(mutations(f)[0].status, 201);
  const lookup = f.calls.find(c => c.path === "/api/inspection/providers").data;
  assert.equal(lookup.providers.find(p => p.id === f.capable.id).suitable, true);
  assert.equal(lookup.providers.find(p => p.id === f.capable.id).coordinates, null);
}, { prepare: f => f.tx.update(s.providers).set({ locationLat: "95", locationLng: "36" }).where(eq(s.providers.id, f.capable.id)) });

for (const tiles of ["failure", "timeout"]) run(`map ${tiles} gives text list without changing locality/matching`, async f => {
  await selectInspection(f);
  await f.page.getByText(/تعذر تحميل الخريطة أو استغرق/).waitFor();
  assert.equal(await f.page.locator(".rs-map").count(), 0);
  await confirmProvider(f, "verification only capable", { inspection: true });
  const call = mutations(f)[0]; assert.equal(call.status, 201);
  assert.equal(call.input.governorateId, f.gov); assert.equal(call.input.regionId, f.region);
}, { tiles, prepare: f => f.tx.update(s.providers).set({ locationLat: "33.5", locationLng: "36.2" }).where(eq(s.providers.id, f.capable.id)) });

run("no-match confirmation is explicit, cancel/refresh do not write and creates no notification", async f => {
  await selectInspection(f, f.emptyRegion);
  await f.page.getByRole("button", { name: "تأكيد عدم وجود مزود مطابق", exact: true }).click();
  await f.page.getByRole("dialog").getByRole("button", { name: "إلغاء", exact: true }).click();
  assert.equal(mutations(f).length, 0);
  await f.page.getByRole("button", { name: "تأكيد عدم وجود مزود مطابق", exact: true }).click();
  const d = f.page.getByRole("dialog");
  await d.getByRole("checkbox").check(); await d.getByRole("button", { name: "تأكيد النتيجة", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  assert.equal(mutations(f).length, 1);
  assert.equal(mutations(f)[0].data.notificationId, null);
  assert.equal(await f.page.getByRole("link", { name: "فتح واتساب وإرسال الرسالة" }).count(), 0);
  await f.page.reload(); await f.page.locator(".rs-vehicle-option").waitFor();
  assert.equal(mutations(f).length, 1);
});

run("no suitable provider hides unsuitable notification choices", async f => {
  await selectInspection(f);
  await f.page.getByRole("button", { name: "تأكيد عدم وجود مزود مطابق", exact: true }).waitFor();
  assert.equal(await f.page.locator(".rs-provider").count(), 0);
  assert.equal(await f.page.locator(".rs-map").count(), 0);
}, { prepare: f => f.tx.delete(s.providerBrands).where(eq(s.providerBrands.providerId, f.capable.id)) });

run("inspection busy double-click prevention; additional suitable provider reuses parent", async f => {
  await selectInspection(f);
  await f.page.locator(".rs-provider").filter({ hasText: "verification only capable" }).click();
  const d = f.page.getByRole("dialog");
  await d.getByRole("button", { name: "أبلغ المزود", exact: true }).click(); await d.getByRole("checkbox").check();
  let release; const wait = new Promise(r => release = r);
  f.setBeforeResponse(call => call.method === "POST" ? wait : undefined);
  await d.getByRole("button", { name: "تأكيد وإبلاغ المزود", exact: true }).click();
  await d.getByRole("button", { name: "جارٍ التأكيد…" }).waitFor();
  assert.equal(await d.getByRole("button", { name: "جارٍ التأكيد…" }).isDisabled(), true);
  release(); f.setBeforeResponse(null); await d.waitFor({ state: "hidden" });
  await confirmProvider(f, "verification only active", { inspection: true });
  assert.equal(mutations(f).length, 2);
  assert.equal(mutations(f)[1].input.requestId, mutations(f)[0].data.requestId);
}, { prepare: f => copyCapabilities(f, f.active.id) });

run("stale inspection response cannot restore results and governorate change resets region", async f => {
  let release; const gate = new Promise(r => release = r);
  f.setBeforeResponse(c => c.path === "/api/inspection/providers" ? gate : undefined);
  await selectInspection(f);
  await f.page.selectOption("#inspection-governorate", f.otherGov);
  release(); f.setBeforeResponse(null);
  await f.page.waitForFunction(() => document.querySelector("#inspection-region").value === "");
  await f.page.waitForFunction(id => [...document.querySelector("#inspection-region").options].some(o => o.value === id), f.otherRegion);
  assert.equal(await f.page.locator(".rs-provider").count(), 0);
  assert.equal(await f.page.locator(".rs-map").count(), 0);
});

for (const width of [320, 1280]) run(`inspection ${width}px RTL sheet keyboard focus, targets and no horizontal overflow`, async f => {
  await selectInspection(f);
  await f.page.locator(".rs-provider").filter({ hasText: "capable" }).click();
  const d = f.page.getByRole("dialog"); await d.waitFor();
  const box = await d.boundingBox();
  if (width === 320) assert.ok(box.y > 0 && box.width <= 320);
  else assert.ok(box.width <= 500 && box.height > 800);
  await f.page.keyboard.press("Shift+Tab");
  assert.equal(await d.getByRole("button", { name: "أبلغ المزود", exact: true }).evaluate(e => e === document.activeElement), true);
  await f.page.keyboard.press("Tab");
  assert.equal(await d.getByRole("button", { name: "إغلاق" }).evaluate(e => e === document.activeElement), true);
  const dimensions = await f.page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth, dir: document.querySelector("main").dir,
    sizes: [...document.querySelectorAll("main button,main select")].filter(e => e.getBoundingClientRect().width)
      .map(e => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })),
  }));
  assert.equal(dimensions.overflow, false); assert.equal(dimensions.dir, "rtl");
  assert.ok(dimensions.sizes.every(r => r.w >= 44 && r.h >= 44));
  await f.page.keyboard.press("Escape"); await d.waitFor({ state: "hidden" });
}, { width });

run("inspection GPS denial retains manual locality; GPS coordinates absent from every API", async f => {
  await f.page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (_ok, fail) => fail({ code: 1 });
  });
  await f.page.reload(); await f.page.locator(".rs-vehicle-option").waitFor();
  await f.page.getByRole("button", { name: "استخدام موقعي للعرض فقط" }).click();
  await f.page.getByText("لم نتمكن من الوصول إلى موقعك. يمكنك المتابعة باختيار المحلية.").waitFor();
  await selectInspection(f); await confirmProvider(f, "verification only capable", { inspection: true });
  assert.ok(f.calls.every(c => !/latitude|longitude|\"lat\"|\"lng\"/.test(JSON.stringify(c.input))));
});

run("inspection GPS success remains display-only and cannot bypass mandatory locality", async f => {
  await f.context.grantPermissions(["geolocation"]);
  await f.context.setGeolocation({ latitude: 33.5138, longitude: 36.2765 });
  await f.page.locator(".rs-vehicle-option").waitFor();
  await f.page.getByRole("button", { name: "استخدام موقعي للعرض فقط" }).click();
  await f.page.getByText("يعرض موقعك على الخريطة فقط؛ لا يُرسل ولا يُحفظ، واختيار المحافظة والمنطقة يبقى إلزاميًا.").waitFor();
  assert.equal(await f.page.getByRole("button", { name: "عرض مزودي الفحص", exact: true }).isDisabled(), true);
  await selectInspection(f);
  await confirmProvider(f, "verification only capable", { inspection: true });
  assert.equal(mutations(f)[0].input.governorateId, f.gov);
  assert.equal(mutations(f)[0].input.regionId, f.region);
  for (const call of f.calls) {
    assert.doesNotMatch(JSON.stringify(call.input), /33\.5138|36\.2765|latitude|longitude/);
    assert.doesNotMatch(JSON.stringify(call.query), /33\.5138|36\.2765|latitude|longitude/);
  }
});

run("map marker keyboard selection and zoom controls have at least44px targets", async f => {
  await selectInspection(f);
  const marker = f.page.locator('.leaflet-marker-icon[title*="capable"]');
  await marker.waitFor(); await marker.focus(); await f.page.keyboard.press("Enter");
  await f.page.getByRole("dialog").waitFor();
  await f.page.keyboard.press("Escape");
  for (const control of await f.page.locator(".leaflet-bar a,.leaflet-marker-icon").all()) {
    const box = await control.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
  }
}, { prepare: f => f.tx.update(s.providers).set({ locationLat: "33.5", locationLng: "36.2" }).where(eq(s.providers.id, f.capable.id)) });

run("registered routes without a session redirect to login instead of showing protected services", async f => {
  await f.context.clearCookies();
  await f.page.reload(); await f.page.waitForURL("**/login");
  assert.equal(await f.page.locator(".rs-vehicle-option").count(), 0);
  await f.page.goto(appOrigin + "/towing"); await f.page.waitForURL("**/login");
  assert.equal(await f.page.locator("#tow-origin").count(), 0);
  assert.equal(mutations(f).length, 0);
});

run("expiry during registered confirmation redirects to login with Build6 message", async f => {
  await selectInspection(f);
  await f.page.locator(".rs-provider").filter({ hasText: "capable" }).click();
  const d = f.page.getByRole("dialog");
  await d.getByRole("button", { name: "أبلغ المزود", exact: true }).click(); await d.getByRole("checkbox").check();
  await f.tx.update(s.users).set({ isActive: false }).where(eq(s.users.id, f.a));
  await d.getByRole("button", { name: "تأكيد وإبلاغ المزود", exact: true }).click();
  await f.page.waitForURL("**/login");
  await f.page.getByText("انتهت جلستك. الرجاء تسجيل الدخول مجدداً.", { exact: true }).waitFor();
  assert.equal(mutations(f)[0].status, 401);
});

for (const home of ["active", "absent", "inactive"]) run(`towing home ${home} prefill/edit without modifying profile`, async f => {
  await f.page.locator("#tow-origin").waitFor();
  assert.equal(await f.page.locator("#tow-origin").inputValue(), home === "active" ? f.gov : "");
  await f.page.selectOption("#tow-origin", f.otherGov);
  await selectTowing(f, f.otherGov);
  await confirmProvider(f, "verification towing destOnlyB");
  assert.equal(mutations(f)[0].status, 201); assert.equal(mutations(f)[0].data.matchingStatus, "matched");
  assert.equal(Object.hasOwn(mutations(f)[0].input, "vehicleId"), false);
  const [u] = await f.tx.select().from(s.users).where(eq(s.users.id, f.a));
  assert.equal(u.homeGovernorateId, home === "absent" ? null : f.gov);
}, { path: "/towing", prepare: async f => {
  if (home === "absent") await f.tx.update(s.users).set({ homeGovernorateId: null }).where(eq(s.users.id, f.a));
  if (home === "inactive") await f.tx.update(s.governorates).set({ isActive: false }).where(eq(s.governorates.id, f.gov));
} });

run("towing B→A→B browser continuation retains one parent, warnings, A order, list-only", async f => {
  await selectTowing(f);
  assert.equal(await f.page.locator(".rs-tow-section").first().locator(".rs-tow-card h3").first().innerText(), "verification towing originA");
  await confirmProvider(f, "verification towing originOnlyB");
  await confirmProvider(f, "verification towing originA");
  await confirmProvider(f, "verification towing emptyB");
  const calls = mutations(f); assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.data.matchingStatus), ["no_match", "matched", "matched"]);
  assert.ok(calls.every(c => c.data.requestId === calls[0].data.requestId));
  assert.equal(await f.page.locator(".rs-map").count(), 0);
  assert.ok(await f.page.getByText("التواصل يعتمد على استجابة المزود، والإشعار ليس حجزًا ولا ضمانًا.", { exact: true }).count() > 0);
}, { path: "/towing" });

run("towing Section A empty retains B and configurable no-cover contact", async f => {
  await f.page.locator("#tow-origin").waitFor();
  await selectTowing(f, f.extraDest);
  await f.page.getByRole("heading", { name: "لا يوجد مزود يغطي هذا المسار" }).waitFor();
  assert.ok(await f.page.locator(".rs-tow-section").last().locator(".rs-tow-card").count() > 0);
  await confirmProvider(f, "verification towing emptyB");
  assert.equal(mutations(f)[0].data.matchingStatus, "no_match");
}, { path: "/towing" });

run("towing GPS generates client-only location URL without API/persistence/route change", async f => {
  await f.context.grantPermissions(["geolocation"]); await f.context.setGeolocation({ latitude: 33.5138, longitude: 36.2765 });
  await selectTowing(f); await confirmProvider(f, "verification towing originA");
  await f.page.getByRole("button", { name: "أرسل موقعي", exact: true }).click();
  await f.page.getByRole("button", { name: "استخدام GPS ومشاركة الموقع", exact: true }).click();
  const link = f.page.getByRole("link", { name: "فتح واتساب لإرسال الموقع" }); await link.waitFor();
  const text = new URL(await link.getAttribute("href")).searchParams.get("text");
  assert.equal(text, "Syriacar — مالك تحقق أ — سطحة — موقعي: https://maps.google.com/?q=33.5138,36.2765");
  assert.equal(f.calls.filter(c => c.path === "/api/towing/location").length, 0);
  const [parent] = await f.tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, mutations(f)[0].data.requestId));
  assert.equal(parent.originGovernorateId, f.gov); assert.equal(parent.destGovernorateId, f.otherGov);
}, { path: "/towing" });

run("towing GPS denial and manual locality fallback use owned notice without route changes", async f => {
  await f.page.addInitScript(() => { navigator.geolocation.getCurrentPosition = (_ok, fail) => fail({ code: 1 }); });
  await f.page.reload(); await selectTowing(f); await confirmProvider(f, "verification towing originA");
  await f.page.getByRole("button", { name: "أرسل موقعي", exact: true }).click();
  await f.page.getByRole("button", { name: "استخدام GPS ومشاركة الموقع" }).click();
  await f.page.locator("#tow-location-governorate").waitFor();
  await f.page.selectOption("#tow-location-governorate", f.otherGov);
  await f.page.waitForFunction(id => [...document.querySelector("#tow-location-region").options].some(o => o.value === id), f.otherRegion);
  await f.page.selectOption("#tow-location-region", f.otherRegion);
  await f.page.getByRole("button", { name: "تجهيز رسالة الموقع" }).click();
  await f.page.getByRole("link", { name: "فتح واتساب لإرسال الموقع" }).waitFor();
  const call = mutations(f).at(-1);
  assert.equal(call.path, "/api/towing/location"); assert.equal(call.status, 200);
  assert.equal(call.input.notificationId, mutations(f)[0].data.notificationId);
  assert.equal(await f.page.locator("#tow-origin").inputValue(), f.gov);
  assert.equal(await f.page.locator("#tow-destination").inputValue(), f.otherGov);
  assert.ok(f.calls.every(c => !/latitude|longitude|\"lat\"|\"lng\"/.test(JSON.stringify(c.input))));
}, { path: "/towing", width: 320 });

run("stale towing response cannot restore old route; cancellation makes no service write", async f => {
  let release; const gate = new Promise(r => release = r);
  f.setBeforeResponse(c => c.path === "/api/guest-towing/providers" ? gate : undefined);
  await f.page.locator("#tow-origin").waitFor();
  await f.page.selectOption("#tow-destination", f.otherGov);
  await f.page.getByRole("button", { name: "عرض مزودي السطحات" }).click();
  await f.page.selectOption("#tow-destination", f.gov);
  release(); f.setBeforeResponse(null);
  await f.page.getByRole("button", { name: "عرض مزودي السطحات" }).click();
  await f.page.getByRole("heading", { name: "باقي المزودين", exact: true }).waitFor();
  await f.page.locator(".rs-tow-card").filter({ hasText: "verification towing originA" }).getByRole("button").click();
  const d = f.page.getByRole("dialog");
  await d.getByRole("button", { name: "أبلغ المزود", exact: true }).click();
  await d.getByRole("button", { name: "إلغاء", exact: true }).click();
  assert.equal(mutations(f).length, 0);
}, { path: "/towing" });

run("towing320px warnings, side/bottom sheet and location layout fit without overflow", async f => {
  await selectTowing(f);
  await f.page.locator(".rs-tow-card").filter({ hasText: "verification towing originA" }).getByRole("button").click();
  const d = f.page.getByRole("dialog"); await d.waitFor();
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const box = await d.boundingBox(); assert.ok(box.width <= 320 && box.y > 0);
  await f.page.keyboard.press("Escape");
  await confirmProvider(f, "verification towing originA");
  await f.page.getByRole("button", { name: "أرسل موقعي", exact: true }).click();
  await f.page.getByRole("button", { name: "اختيار الموقع يدويًا", exact: true }).click();
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const button of await d.locator("button,select").all()) {
    const b = await button.boundingBox(); assert.ok(b.width >= 44 && b.height >= 44);
  }
}, { path: "/towing", width: 320 });