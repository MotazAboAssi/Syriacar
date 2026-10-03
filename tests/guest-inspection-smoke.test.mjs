import assert from "node:assert/strict";
import test from "node:test";

const origin = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://127.0.0.1:5000";
const base = `${origin}/api/guest-inspection`;

test("guest inspection page is reachable in the Arabic RTL app", async () => {
  const response = await fetch(`${origin}/inspection/guest`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html[^>]*lang="ar"/);
  assert.match(html, /<html[^>]*dir="rtl"/);
  assert.match(html, /id="governorate"/);
  assert.match(html, /id="confirmation-title"/);
});

test("live locality/provider APIs read development reference data and expose safe uncached results", async () => {
  const response = await fetch(`${base}/localities`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const data = await response.json();
  assert.ok(data.governorates.length > 0);
  assert.deepEqual(data.regions, []);
  const governorateId = data.governorates[0].id;
  const regionsResponse = await fetch(`${base}/localities?governorateId=${governorateId}`);
  assert.equal(regionsResponse.status, 200);
  const { regions } = await regionsResponse.json();
  assert.ok(regions.length > 0);
  const providersResponse = await fetch(`${base}/providers?governorateId=${governorateId}&regionId=${regions[0].id}`);
  assert.equal(providersResponse.status, 200);
  assert.match(providersResponse.headers.get("cache-control"), /no-store/);
  const result = await providersResponse.json();
  assert.ok(Array.isArray(result.providers));
  for (const provider of result.providers) {
    assert.ok(!("passwordHash" in provider));
    assert.ok(!("createdBy" in provider));
  }
});

test("live API rejects invalid locality and identity without creating a request", async () => {
  const response = await fetch(`${base}/providers?governorateId=invalid&regionId=invalid`);
  assert.equal(response.status, 422);
  const failed = await fetch(`${base}/requests`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ governorateId: "bad", regionId: "bad", providerId: null,
      guestName: "", guestPhone: "bad", acceptedTerms: false }),
  });
  assert.equal(failed.status, 422);
  const error = await failed.json();
  assert.ok(error.error);
  assert.ok(error.fields);
  assert.ok(!JSON.stringify(error).includes("DATABASE_URL"));
});