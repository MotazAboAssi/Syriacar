import assert from "node:assert/strict";
import test from "node:test";

const origin = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}`
  : "http://127.0.0.1:5000";

test("application shell is Arabic RTL", async () => {
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html[^>]*lang="ar"/);
  assert.match(html, /<html[^>]*dir="rtl"/);
});

test("health checks the real database without exposing configuration", async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await response.json(), {
    status: "ok", application: "ok", database: "connected",
  });
});

test("manifest preserves Arabic RTL and standalone direction", async () => {
  const response = await fetch(`${origin}/manifest.webmanifest`);
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.equal(manifest.lang, "ar");
  assert.equal(manifest.dir, "rtl");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
});