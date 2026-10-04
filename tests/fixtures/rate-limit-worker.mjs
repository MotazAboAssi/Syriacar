import nextEnv from "@next/env";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgTable } from "drizzle-orm/pg-core";
import { readDatabaseConfig } from "../../src/server/config/database.ts";
import { securityRateLimits } from "../../src/server/db/security-rate-limits.ts";
import { AccountLimits, accountTransaction } from "../../src/modules/account/rate-limits.ts";
nextEnv.loadEnvConfig(process.cwd());
const [schema, identity, scope, limit] = process.argv.slice(2);
if (!/^rate_fixture_[0-9a-f]{32}$/.test(schema)) throw new Error("Invalid scratch schema");
securityRateLimits[PgTable.Symbol.Schema] = schema;
const pool = new Pool({ connectionString: readDatabaseConfig().connectionString, max: 1,
  connectionTimeoutMillis: 5000, options: "-c timezone=UTC -c statement_timeout=5000" });
try {
  const limits = new AccountLimits();
  await accountTransaction(drizzle(pool), tx => limits.admit(tx,
    [{ scope, identity, limit: Number(limit), seconds: 3600 }], { secret: "scratch-only" }));
  console.log("admitted");
} catch (error) {
  console.log("status:" + (error.status ?? "failure"));
  process.exitCode = error.status === 429 ? 0 : 1;
} finally { await pool.end(); }