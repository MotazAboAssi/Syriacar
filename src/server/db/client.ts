import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { readDatabaseConfig } from "../config/database.ts";
import * as schema from "./schema.ts";

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
    // The frozen schema uses TIMESTAMP values with UTC semantics.
    options: "-c timezone=UTC",
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

/** Drizzle pins this client for BEGIN..COMMIT even with transaction pooling.
 * Never obtain a different/global pool when the caller injected a database.
 */
export function registrationTransactionClient(transaction: unknown) {
  const client = (transaction as { session?: { client?: Partial<PoolClient> } })?.session?.client;
  if (!client || typeof client.end !== "function" || typeof client.on !== "function" ||
    typeof client.removeListener !== "function") {
    throw new Error("Unsupported registration transaction client");
  }
  return client as PoolClient;
}

/** pg's query_timeout rejects before the wire operation necessarily finishes.
 * Drizzle owns release(); discard a still-busy client BEFORE that release, not
 * after another waiter may have borrowed it. Never release the checkout twice.
 */
export function guardRegistrationRelease(client: PoolClient, uncertain: () => void) {
  // pg 8's deprecated public getters warn even for healthy releases. Read its
  // current internal state explicitly; fail closed if an upgrade changes it.
  const state = client as PoolClient & { _activeQuery?: unknown; _queryQueue?: unknown[] };
  if (typeof client.release !== "function") return () => {};
  if (!("_activeQuery" in state) || !Array.isArray(state._queryQueue)) {
    throw new Error("Unsupported registration client state");
  }
  const original = client.release;
  const guarded = (...args: Parameters<typeof original>) => {
    if (state._activeQuery || state._queryQueue?.length) uncertain();
    client.release = original;
    original.apply(client, args);
  };
  client.release = guarded;
  // Injected transactions/savepoints do not own the outer client's release.
  return () => { if (client.release === guarded) client.release = original; };
}

/** CLI verification uses the same lazy pool, then releases it on completion. */
export async function closeDatabase() {
  if (!runtime.syriacarDatabase) return;
  const connection = runtime.syriacarDatabase;
  delete runtime.syriacarDatabase;
  await connection.pool.end();
}