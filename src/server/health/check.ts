import "server-only";
import { sql } from "drizzle-orm";
import { DatabaseConfigurationError } from "@/server/config/database";
import { getDatabase } from "@/server/db/client";

export async function checkHealth() {
  try {
    // Read-only connectivity probe; never creates schema or application records.
    await getDatabase().execute(sql`SELECT 1 AS connection_check`);
    return { status: "ok", application: "ok", database: "connected" } as const;
  } catch (error: unknown) {
    return {
      status: "degraded",
      application: "ok",
      database: error instanceof DatabaseConfigurationError
        ? "unconfigured"
        : "unavailable",
    } as const;
  }
}