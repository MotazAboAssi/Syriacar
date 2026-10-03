import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { readDatabaseConfig } from "@/server/config/database";
import * as schema from "./schema";

function createDatabase() {
  const { connectionString } = readDatabaseConfig();
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
    application_name: "syriacar",
  });

  // Handle idle-client failures without logging credential-bearing error details.
  pool.on("error", () => {
    console.error("An idle PostgreSQL connection became unavailable.");
  });

  return { pool, db: drizzle(pool, { schema }) };
}

type DatabaseConnection = ReturnType<typeof createDatabase>;
const runtime = globalThis as typeof globalThis & {
  syriacarDatabase?: DatabaseConnection;
};

/** One lazy pool per process, also reused across development hot reloads. */
export function getDatabase() {
  runtime.syriacarDatabase ??= createDatabase();
  return runtime.syriacarDatabase.db;
}