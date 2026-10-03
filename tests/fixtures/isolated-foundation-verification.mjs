import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { getDatabase, closeDatabase } from "../../src/server/db/client.ts";
import { verifyCatalog } from "../../src/server/db/catalog.ts";
import { verifyBehavior } from "../../src/server/db/verify.ts";
import { seedReferenceData } from "../../src/server/db/seed/seed.ts";
import { verifyInitialReferenceData } from "../../src/server/db/seed/verify.ts";
import { referenceSeed } from "../../src/server/db/seed/reference-data.ts";
import { inspectionSnapshot } from "./guest-inspection.mjs";

// Exact existing assertions on a transactional copy of the frozen migration.
// No public data is deleted, no migrations are applied to the application, and
// PostgreSQL rolls back even the temporary schema/types/tables on every exit.
const db = getDatabase();
const originalRuntime = globalThis.syriacarDatabase;
const rollback = new Error("ROLLBACK_ISOLATED_FOUNDATION");
const schemaName = `verify_towing_${randomUUID().replaceAll("-", "")}`;
const migration = await readFile(new URL("../../drizzle/0000_database_foundation.sql", import.meta.url), "utf8");
let before, fingerprint, catalog, behavior, references;
const requestFingerprint = async () => (await db.execute(sql`
  SELECT md5(row_to_json(r)::text) AS fingerprint FROM public.service_requests r ORDER BY id
`)).rows;

try {
  before = await inspectionSnapshot();
  const referenceNames = ["governorates", "regions", "brand_groups", "brands", "fuel_types", "tow_types"];
  before.references.forEach((rows, index) => {
    assert.deepEqual(rows, [...referenceSeed[referenceNames[index]]].sort((a, b) => a.id.localeCompare(b.id)),
      `Real ${referenceNames[index]} must exactly match the approved initial reference inventory`);
  });
  fingerprint = await requestFingerprint(); // Never log identity or its digest.
  catalog = await verifyCatalog(); // Strict actual inventory, BEFORE cloning.
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}", public`));
      const isolatedSql = migration.replaceAll('"public"', `"${schemaName}"`);
      for (const statement of isolatedSql.split("--> statement-breakpoint").filter((s) => s.trim())) {
        await tx.execute(sql.raw(statement));
      }
      // Private CLI process only. Pin existing no-argument verification helpers
      // to this transaction; never mutate the web process or add a public bypass.
      globalThis.syriacarDatabase = { ...originalRuntime, db: tx };
      try {
        behavior = await verifyBehavior();
        await seedReferenceData(tx);
        references = await verifyInitialReferenceData();
      } finally {
        globalThis.syriacarDatabase = originalRuntime;
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  assert.deepEqual(await inspectionSnapshot(), before, "Real table counts/references/config must be preserved");
  assert.deepEqual(await requestFingerprint(), fingerprint, "Real request content must remain unchanged");
  assert.deepEqual(await verifyCatalog(), catalog, "No temporary schema, table, type or migration may persist");
  console.log(JSON.stringify({
    status: "passed", scope: "public catalog + rollback-only frozen-migration behavior/seed verification",
    catalog, behavior, initialReferences: references,
    realApplicationDataPreserved: true, realInitialReferenceValuesVerified: true, temporarySchemaRolledBack: true,
    existingRequestsPreserved: fingerprint.length, permanentFixturesAdded: 0,
  }, null, 2));
} catch (error) {
  console.error("Isolated foundation verification failed:", error instanceof assert.AssertionError
    ? error.message : "Database operation failed; sensitive details withheld.");
  process.exitCode = 1;
} finally {
  globalThis.syriacarDatabase = originalRuntime;
  await closeDatabase();
}