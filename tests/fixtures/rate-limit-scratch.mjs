import nextEnv from "@next/env";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { readDatabaseConfig } from "../../src/server/config/database.ts";
import * as business from "../../src/server/db/schema.ts";
import { securityRateLimits } from "../../src/server/db/security-rate-limits.ts";
import { seedReferenceData } from "../../src/server/db/seed/seed.ts";
import { protectPoolTransactions } from "../../src/server/db/transaction-release.ts";

nextEnv.loadEnvConfig(process.cwd());
/** Committed private schema, pool=2. Never reads/writes synthetic public rows. */
export async function withRateScratch(check) {
  const name = "rate_fixture_" + randomUUID().replaceAll("-", "");
  const pool = new Pool({ connectionString: readDatabaseConfig().connectionString, max: 2,
    application_name: name, connectionTimeoutMillis: 5000,
    options: `-c search_path=${name},public -c timezone=UTC -c statement_timeout=5000` });
  const db = protectPoolTransactions(drizzle(pool));
  const tables = [...Object.values(business).filter(t => is(t, PgTable)), securityRateLimits];
  const symbol = PgTable.Symbol.Schema, originals = tables.map(t => t[symbol]);
  let created = false;
  try {
    await db.execute(sql.raw(`CREATE SCHEMA "${name}"`)); created = true;
    for (const file of ["0000_database_foundation.sql", "0001_security_rate_limits.sql"]) {
      const text = await readFile(new URL("../../drizzle/" + file, import.meta.url), "utf8");
      for (const statement of text.replaceAll('"public"', `"${name}"`).split("--> statement-breakpoint").filter(x => x.trim()))
        await db.execute(sql.raw(statement));
    }
    tables.forEach(t => { t[symbol] = name; });
    await seedReferenceData(db);
    await check({ db, pool, name });
  } finally {
    tables.forEach((t, i) => { t[symbol] = originals[i]; });
    if (created) await db.execute(sql.raw(`DROP SCHEMA "${name}" CASCADE`));
    await pool.end();
  }
}