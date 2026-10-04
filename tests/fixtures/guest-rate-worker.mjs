import nextEnv from "@next/env";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { readDatabaseConfig } from "../../src/server/config/database.ts";
import * as s from "../../src/server/db/schema.ts";
import { securityRateLimits } from "../../src/server/db/security-rate-limits.ts";
import { inspectionHandlers } from "../../src/modules/guest-inspection/http.ts";
import { towingHandlers } from "../../src/modules/guest-towing/http.ts";
import { runtime, request, result } from "./guest-rate-scratch.mjs";

nextEnv.loadEnvConfig(process.cwd());
const [schema, kind, json] = process.argv.slice(2);
if (!/^rate_fixture_[0-9a-f]{32}$/.test(schema) || !["inspection", "towing"].includes(kind)) {
  throw new Error("Invalid scratch arguments");
}
for (const t of [...Object.values(s).filter(t => is(t, PgTable)), securityRateLimits]) t[PgTable.Symbol.Schema] = schema;
const pool = new Pool({ connectionString: readDatabaseConfig().connectionString, max: 1,
  connectionTimeoutMillis: 5000, options: "-c timezone=UTC -c statement_timeout=5000" });
try {
  const db = drizzle(pool);
  const api = (kind === "inspection" ? inspectionHandlers : towingHandlers)(() => db, runtime);
  const r = await result(api.create(request(kind, JSON.parse(json))));
  console.log(JSON.stringify({ status: r.status, keys: Object.keys(r.data), retryAfter: r.headers.get("retry-after") }));
} finally { await pool.end(); }