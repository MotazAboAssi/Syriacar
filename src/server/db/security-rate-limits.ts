import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// Infrastructure only: intentionally absent from the frozen business barrel.
export const securityRateLimits = pgTable("security_rate_limits", {
  scope: text("scope").notNull(),
  keyHash: text("key_hash").notNull(),
  count: integer("count").notNull().default(0),
  windowExpiresAt: timestamp("window_expires_at", { withTimezone: true }).notNull(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  retireAt: timestamp("retire_at", { withTimezone: true }).notNull(),
}, t => [
  primaryKey({ columns: [t.scope, t.keyHash] }),
  check("security_rate_limits_key_hash_check", sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`),
  check("security_rate_limits_count_check", sql`${t.count} >= 0`),
  check("security_rate_limits_retire_check", sql`${t.retireAt} >= ${t.windowExpiresAt} AND (${t.blockedUntil} IS NULL OR ${t.retireAt} >= ${t.blockedUntil})`),
  index("security_rate_limits_retire_at_index").on(t.retireAt),
]);