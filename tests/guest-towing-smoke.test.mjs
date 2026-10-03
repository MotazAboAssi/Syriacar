import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const origin = process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000";
const api = `${origin}/api/guest-towing`;

test("live towing page and home entry are reachable in the Arabic RTL app", async () => {
  const page = await fetch(`${origin}/towing/guest`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /dir="rtl"/);
  assert.ok(html.includes("محافظة الانطلاق"));
  assert.ok(html.includes("محافظة الوصول"));
  assert.match(await (await fetch(origin)).text(), /href="\/towing\/guest"/);
});

test("live Next towing routes return reference/results JSON and safely reject invalid requests", async () => {
  const localities = await fetch(`${api}/governorates`);
  assert.equal(localities.status, 200);
  assert.equal(localities.headers.get("cache-control"), "no-store");
  const { governorates } = await localities.json();
  assert.equal(governorates.length, 14);
  const query = new URLSearchParams({ originGovernorateId: governorates[0].id, destGovernorateId: governorates[1].id });
  const result = await fetch(`${api}/providers?${query}`);
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.ok(Array.isArray(data.sectionA) && Array.isArray(data.sectionB));
  assert.equal((await fetch(`${api}/providers?originGovernorateId=invalid&destGovernorateId=invalid`)).status, 422);
  const rejected = await fetch(`${api}/requests`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ originGovernorateId: governorates[0].id, destGovernorateId: governorates[1].id,
      providerId: randomUUID(), guestName: "", guestPhone: "+963900000001", acceptedTerms: true }),
  });
  assert.equal(rejected.status, 422, "Invalid identity must be rejected before ANY writes");
  const location = await fetch(`${api}/location`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(location.status, 422);
});