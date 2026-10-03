import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
import type { PgInsertValue, PgTable } from "drizzle-orm/pg-core";
import { getDatabase } from "../client.ts";
import * as s from "../schema.ts";
import { referenceSeed } from "./reference-data.ts";

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Manual initial-data setup, never a startup hook or an Operations write path. */
export async function seedReferenceData(connection: Database | Transaction = getDatabase()) {
  return connection.transaction(async (tx) => {
    async function insert<T extends PgTable>(table: T, rows: readonly PgInsertValue<T>[]) {
      const id = getTableColumns(table).id;
      assert.ok(id, "Reference tables require an existing UUID primary key");
      const inserted = await tx.insert(table).values([...rows])
        // Only an existing stable ID is preserved. Other uniqueness conflicts
        // fail and roll back, rather than silently skipping an approved entry.
        .onConflictDoNothing({ target: id }).returning({ id });
      return { inserted: inserted.length, preserved: rows.length - inserted.length };
    }

    // Parents first; all six entities commit together or none do.
    return {
      governorates: await insert(s.governorates, referenceSeed.governorates),
      regions: await insert(s.regions, referenceSeed.regions),
      brand_groups: await insert(s.brandGroups, referenceSeed.brand_groups),
      brands: await insert(s.brands, referenceSeed.brands),
      fuel_types: await insert(s.fuelTypes, referenceSeed.fuel_types),
      tow_types: await insert(s.towTypes, referenceSeed.tow_types),
    };
  });
}