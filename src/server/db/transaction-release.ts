import "server-only";
import { sql, type SQL, type ExtractTablesWithRelations, type RelationalSchemaConfig } from "drizzle-orm";
import { NodePgDatabase, NodePgSession, NodePgTransaction, type NodePgSessionOptions } from "drizzle-orm/node-postgres";
import type { PgDialect, PgTransactionConfig } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";

/**
 * Local repair for Drizzle 0.45.3's pool transaction boundary: upstream awaits
 * BEGIN outside its release finally, and releases without a discard flag when
 * ROLLBACK fails. Keep its session/config/transaction/savepoint implementation.
 * Only this database instance is patched; no global prototype/driver changes.
 */
export function protectPoolTransactions<T extends Record<string, unknown>>(
  db: NodePgDatabase<T> & { $client: Pool },
) {
  const session = db._.session;
  if (!(session instanceof NodePgSession) || !(db.$client instanceof Pool)) {
    throw new Error("Unsupported pooled Drizzle transaction boundary");
  }
  // These are the installed adapter's runtime fields, hidden by its TS types.
  // Fail before checkout if a future dependency changes this session shape.
  const internals = session as unknown as {
    dialect: PgDialect;
    schema: RelationalSchemaConfig<ExtractTablesWithRelations<T>> | undefined;
    options: NodePgSessionOptions;
  };
  if (!internals.dialect || typeof internals.dialect.sqlToQuery !== "function" ||
    !("schema" in internals) || !internals.options) {
    throw new Error("Unsupported Drizzle session state");
  }
  session.transaction = async (action, config) => {
    const client = await db.$client.connect();
    let begun = false;
    let rollbackFailed = false;
    let connectionFailed = false;
    const onError = () => { connectionFailed = true; };
    client.on("error", onError);
    try {
      const pinned = new NodePgSession(client, internals.dialect, internals.schema, internals.options);
      const tx = new NodePgTransaction(internals.dialect, pinned, internals.schema);
      // Drizzle's runtime uses this method, but omits it from published TS types.
      const configurable = tx as typeof tx & { getTransactionConfigSQL(config: PgTransactionConfig): SQL };
      if (typeof configurable.getTransactionConfigSQL !== "function") {
        throw new Error("Unsupported Drizzle transaction configuration");
      }
      await tx.execute(sql`begin${config ? sql` ${configurable.getTransactionConfigSQL(config)}` : undefined}`);
      begun = true;
      try {
        const result = await action(tx);
        await tx.execute(sql`commit`);
        return result;
      } catch (error) {
        try {
          await tx.execute(sql`rollback`);
        } catch (rollbackError) {
          rollbackFailed = true;
          throw rollbackError; // Preserve Drizzle's rollback-error propagation.
        }
        throw error;
      }
    } finally {
      // A driver read timeout may reject while SQL is still on the wire.
      // Never let the next waiter borrow that client, even if a caller swallowed
      // the query error. Unknown pg state fails closed, without new timeouts.
      const state = client as PoolClient & { _activeQuery?: unknown; _queryQueue?: unknown[] };
      const busy = !("_activeQuery" in state) || !Array.isArray(state._queryQueue) ||
        !!state._activeQuery || !!state._queryQueue?.length;
      try {
        // pg release(true) removes/ends the checkout instead of idling it.
        // This also cooperates with Fix 2's temporary release guard.
        client.release(!begun || rollbackFailed || connectionFailed || busy);
      } finally {
        client.removeListener("error", onError);
      }
    }
  };
  return db;
}