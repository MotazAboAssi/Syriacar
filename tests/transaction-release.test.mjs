import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { sql } from "drizzle-orm";
import { withRateScratch } from "./fixtures/rate-limit-scratch.mjs";
import { registrationTransactionClient } from "../src/server/db/client.ts";

const run = (name, check) => test(name, { timeout: 60000 }, () => withRateScratch(check));
const text = query => typeof query === "string" ? query : query.text;

// Faults affect only the next checkout from this isolated scratch pool.
// Real pg/Drizzle still execute the SQL and own checkout/release.
function observe(pool, rewrite = query => query) {
  const queries = [], releases = [], clients = [];
  const onRelease = (discard, client) => releases.push({ discard, client });
  pool.on("release", onRelease);
  pool.once("acquire", client => {
    clients.push(client);
    const original = client.query;
    client.query = function (query, ...args) {
      queries.push(text(query));
      return original.call(this, rewrite(query, client, original), ...args);
    };
  });
  return { queries, releases, clients, stop: () => pool.removeListener("release", onRelease) };
}

run("failed BEGIN discards exactly once, never rolls back/calls action, and pool recovers", async f => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = observe(f.pool, query => /^begin\b/i.test(text(query))
      ? { ...query, text: "BEGIN ISOLATION LEVEL invalid_fixture_level" } : query);
    let calls = 0;
    try {
      await assert.rejects(f.db.transaction(async () => { calls++; }), error => error.cause?.code === "42601");
      assert.equal(calls, 0);
      assert.deepEqual(seen.queries, ["begin"]);
      assert.equal(seen.releases.length, 1);
      assert.equal(seen.releases[0].discard, true);
      assert.equal(f.pool.totalCount, 0);
      assert.equal(f.pool.idleCount, 0);
    } finally { seen.stop(); }
    assert.equal(await f.db.transaction(async tx => (await tx.execute(sql`SELECT 42 AS value`)).rows[0].value), 42);
    assert.equal(f.pool.idleCount, f.pool.totalCount);
  }
});

run("failed BEGIN with still-pending wire work destroys rather than reuses checkout", async f => {
  const held = await f.pool.connect();
  await held.query("BEGIN");
  await held.query("SELECT pg_advisory_xact_lock(88440301)");
  const seen = observe(f.pool);
  // Override the observer once it has the checkout; no real timer/config change.
  let wire, rejected;
  f.pool.once("acquire", client => {
    const original = client.query;
    client.query = function (query, ...args) {
      if (!/^begin\b/i.test(text(query))) return original.call(this, query, ...args);
      seen.queries.push(text(query));
      wire = original.call(this, { ...query, text: "SELECT pg_advisory_xact_lock(88440301)" }, ...args);
      rejected = wire.catch(error => error);
      return Promise.reject(new Error("Query read timeout")); // Deterministic driver failure.
    };
  });
  try {
    await assert.rejects(f.db.transaction(async () => assert.fail("BEGIN failed")), /Failed query/);
    assert.equal(seen.queries.filter(q => /^rollback\b/i.test(q)).length, 0);
    assert.equal(seen.releases.length, 1);
    assert.equal(seen.releases[0].discard, true);
    assert.equal(f.pool.totalCount, 1); // Only held control connection remains.
    assert.ok(await rejected instanceof Error);
  } finally {
    seen.stop();
    await held.query("ROLLBACK");
    held.release();
  }
  assert.equal(await f.db.transaction(async () => "recovered"), "recovered");
});

run("failed ROLLBACK discards client even while pg remains queryable", async f => {
  const seen = observe(f.pool, query => /^rollback$/i.test(text(query))
    ? { ...query, text: "ROLLBACK invalid_fixture_token" } : query);
  try {
    await assert.rejects(f.db.transaction(async tx => {
      await tx.execute(sql`SELECT 1`);
      throw new Error("callback failure");
    }), error => error.cause?.code === "42601");
    assert.equal(seen.queries.filter(q => /^rollback$/i.test(q)).length, 1);
    assert.equal(seen.releases.length, 1);
    assert.equal(seen.releases[0].discard, true);
    assert.equal(f.pool.totalCount, 0);
  } finally { seen.stop(); }
  assert.equal(await f.db.transaction(async () => "recovered"), "recovered");
});

run("real checked-out backend failure is handled and discarded after transaction began", async f => {
  const control = await f.pool.connect();
  const seen = observe(f.pool);
  try {
    await assert.rejects(f.db.transaction(async tx => {
      const client = registrationTransactionClient(tx);
      const errored = once(client, "error");
      await control.query("SELECT pg_terminate_backend($1)", [client.processID]);
      await errored;
      throw new Error("connection lost");
    }));
    assert.equal(seen.releases.length, 1);
    assert.equal(seen.releases[0].discard, true);
    assert.equal(f.pool.totalCount, 1);
  } finally { seen.stop(); control.release(); }
  assert.equal(await f.db.transaction(async () => "recovered"), "recovered");
});

run("normal COMMIT preserves config, callback value, same pinned session, and savepoints", async f => {
  const seen = observe(f.pool), value = { committed: true };
  try {
    const result = await f.db.transaction(async tx => {
      assert.equal(registrationTransactionClient(tx), seen.clients[0]);
      assert.equal((await tx.execute(sql`SHOW transaction_isolation`)).rows[0].transaction_isolation, "serializable");
      assert.equal((await tx.execute(sql`SHOW transaction_read_only`)).rows[0].transaction_read_only, "on");
      assert.equal((await tx.execute(sql`SHOW transaction_deferrable`)).rows[0].transaction_deferrable, "on");
      await tx.transaction(async nested => {
        assert.equal(registrationTransactionClient(nested), registrationTransactionClient(tx));
        assert.equal((await nested.execute(sql`SELECT 7 AS value`)).rows[0].value, 7);
      });
      await assert.rejects(tx.transaction(async () => { throw new Error("savepoint only"); }), /savepoint only/);
      return value;
    }, { isolationLevel: "serializable", accessMode: "read only", deferrable: true });
    assert.equal(result, value);
    assert.ok(seen.queries.includes("savepoint sp1"));
    assert.ok(seen.queries.includes("release savepoint sp1"));
    assert.ok(seen.queries.includes("rollback to savepoint sp1"));
    assert.equal(seen.queries.at(-1), "commit");
    assert.equal(seen.releases.length, 1);
    assert.equal(seen.releases[0].discard, false);
    assert.equal(f.pool.idleCount, f.pool.totalCount);
  } finally { seen.stop(); }
});

run("ordinary callback error rolls back and reuses healthy connection exactly once", async f => {
  const seen = observe(f.pool), failure = new Error("ordinary callback failure");
  try {
    await assert.rejects(f.db.transaction(async () => { throw failure; }), error => error === failure);
    assert.deepEqual(seen.queries, ["begin", "rollback"]);
    assert.equal(seen.releases.length, 1);
    assert.equal(seen.releases[0].discard, false);
    assert.equal(f.pool.idleCount, f.pool.totalCount);
    const reused = await f.db.transaction(async tx => registrationTransactionClient(tx));
    assert.equal(reused, seen.clients[0]);
  } finally { seen.stop(); }
});