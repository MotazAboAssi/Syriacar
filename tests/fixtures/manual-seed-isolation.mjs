import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { is, sql, getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { getDatabase } from "../../src/server/db/client.ts";
import * as s from "../../src/server/db/schema.ts";
import { seedReferenceData } from "../../src/server/db/seed/seed.ts";

process.env.NODE_ENV ??= "test";
const migration = await readFile(new URL("../../drizzle/0000_database_foundation.sql", import.meta.url), "utf8");

/** Clone the frozen schema in an always-rolled-back transaction, never public DDL/deletes. */
export async function withManualSeedIsolation(check) {
  const rollback = new Error("ROLLBACK_MANUAL_SEED_ISOLATION");
  try {
    await getDatabase().transaction(async tx => {
      const schema = `verify_manual_${randomUUID().replaceAll("-", "")}`;
      await tx.execute(sql.raw(`CREATE SCHEMA "${schema}"`));
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schema}", public`));
      for (const statement of migration.replaceAll('"public"', `"${schema}"`).split("--> statement-breakpoint").filter(x => x.trim())) {
        await tx.execute(sql.raw(statement));
      }
      await seedReferenceData(tx);
      await check(tx);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
}

/** Compare full content without logging real identities, credentials or row data. */
export async function fixtureTableSnapshot(connection = getDatabase()) {
  const snapshot = {};
  for (const table of Object.values(s).filter(t => is(t, PgTable))) {
    const rows = await connection.select().from(table);
    const serialized = rows.map(row => JSON.stringify(row)).sort();
    snapshot[getTableName(table)] = { count: rows.length,
      digest: createHash("sha256").update(JSON.stringify(serialized)).digest("hex") };
  }
  return snapshot;
}