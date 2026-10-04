import "server-only";
import { sql } from "drizzle-orm";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import { securityRateLimits as table } from "../../server/db/security-rate-limits.ts";
import { rateLimitHash, type AccountRuntime } from "./security.ts";
import { AccountError } from "./validation.ts";

export const accountLimits = {
  registrationsPerPhone: 3, sendsPerPhone: 5, verificationsPerPhone: 30, deletionsPerAccount: 5,
  windowMs: 3600000, failedLogins: 5, lockMs: 900000,
};
export const scopes = {
  registration: "account.registration.phone", send: "account.otp.send.phone",
  verify: "account.otp.verify.phone", deletion: "account.deletion.account",
  login: "account.login.failures.phone",
} as const;
export interface Budget { scope: string; identity: string; limit: number; seconds: number }
interface Bucket { scope: string; hash: string; limit: number; seconds: number }
const hour = 3600;
export function quotaError(seconds: number) {
  const error = new AccountError(429, "محاولات كثيرة. حاول مجدداً لاحقاً.");
  error.retryAfter = Math.max(1, Number(seconds));
  return error;
}
export function unavailable() { return new AccountError(503, "الخدمة غير متاحة مؤقتاً. حاول مجدداً لاحقاً."); }
// Only database/connection faults are translated. Policy and programming errors
// retain their semantics; Drizzle's wrapper exposes the driver fault as cause.
export function databaseFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || error instanceof AccountError) return false;
  const e = error as { code?: string; message?: string; cause?: unknown };
  if (error instanceof Error && error.name === "DatabaseConfigurationError") return true;
  return !!(e.code && (/^[0-9A-Z]{5}$/.test(e.code) ||
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(e.code))) ||
    /^(Connection terminated|Connection terminated unexpectedly|timeout exceeded when trying to connect|Query read timeout|Cannot use a pool after calling end)/.test(e.message ?? "") ||
    databaseFailure(e.cause);
}
export async function databaseOperation<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (databaseFailure(error)) throw unavailable();
    throw error;
  }
}
export const accountTransaction = <T>(db: Connection, action: (tx: Connection) => Promise<T>) =>
  databaseOperation(() => db.transaction(action));

/** Stateless, caller-transaction-injected. Never acquires a pool or savepoint. */
export class AccountLimits {
  budget(kind: "registration" | "send" | "verify" | "deletion", identity: string): Budget {
    const limit = { registration: accountLimits.registrationsPerPhone, send: accountLimits.sendsPerPhone,
      verify: accountLimits.verificationsPerPhone, deletion: accountLimits.deletionsPerAccount }[kind];
    return { scope: scopes[kind], identity, limit, seconds: hour };
  }
  private key(budget: Budget, runtime: AccountRuntime): Bucket {
    return { scope: budget.scope, hash: rateLimitHash(budget.scope, budget.identity, runtime),
      limit: budget.limit, seconds: budget.seconds };
  }
  private predicate(b: Bucket) { return sql`scope = ${b.scope} AND key_hash = ${b.hash}`; }
  private async lock(tx: Connection, b: Bucket) {
    await tx.execute(sql`INSERT INTO ${table}
      (scope, key_hash, count, window_expires_at, blocked_until, retire_at)
      VALUES (${b.scope}, ${b.hash}, 0, NOW() + ${b.seconds} * INTERVAL '1 second', NULL,
        NOW() + (${b.seconds} + 3600) * INTERVAL '1 second')
      ON CONFLICT (scope, key_hash) DO NOTHING`);
    await tx.execute(sql`SELECT scope FROM ${table} WHERE ${this.predicate(b)} FOR UPDATE`);
  }
  private async rejection(tx: Connection, b: Bucket) {
    const result = await tx.execute<{ seconds: number }>(sql`SELECT
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
        CASE WHEN blocked_until > NOW() THEN blocked_until ELSE window_expires_at END - NOW()))))::int AS seconds
      FROM ${table} WHERE ${this.predicate(b)}`);
    return quotaError(result.rows[0].seconds);
  }
  async admit(tx: Connection, budgets: Budget[], runtime: AccountRuntime = {}) {
    const keys = budgets.map(b => this.key(b, runtime)).sort((a, b) =>
      a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
    if (new Set(keys.map(b => b.scope + ":" + b.hash)).size !== keys.length) throw new Error("Duplicate quota key");
    for (const b of keys) await this.lock(tx, b);
    for (const b of keys) {
      const result = await tx.execute(sql`UPDATE ${table} SET
        count = CASE WHEN window_expires_at <= NOW() THEN 1 ELSE count + 1 END,
        window_expires_at = CASE WHEN window_expires_at <= NOW()
          THEN NOW() + ${b.seconds} * INTERVAL '1 second' ELSE window_expires_at END,
        blocked_until = NULL,
        retire_at = (CASE WHEN window_expires_at <= NOW()
          THEN NOW() + ${b.seconds} * INTERVAL '1 second' ELSE window_expires_at END) + INTERVAL '1 hour'
        WHERE ${this.predicate(b)} AND (blocked_until IS NULL OR blocked_until <= NOW())
          AND (window_expires_at <= NOW() OR count < ${b.limit}) RETURNING count`);
      if (!result.rowCount) throw await this.rejection(tx, b);
    }
  }
  async checkLogin(tx: Connection, phone: string, runtime: AccountRuntime) {
    const b = this.key({ scope: scopes.login, identity: phone, limit: 5, seconds: 900 }, runtime);
    await this.lock(tx, b);
    const result = await tx.execute(sql`SELECT scope FROM ${table}
      WHERE ${this.predicate(b)} AND blocked_until > NOW()`);
    return result.rowCount ? this.rejection(tx, b) : null;
  }
  async failLogin(tx: Connection, phone: string, runtime: AccountRuntime) {
    const b = this.key({ scope: scopes.login, identity: phone, limit: 5, seconds: 900 }, runtime);
    const result = await tx.execute<{ blocked: boolean }>(sql`UPDATE ${table} SET
      count = CASE WHEN window_expires_at <= NOW() THEN 1 ELSE count + 1 END,
      window_expires_at = CASE WHEN window_expires_at <= NOW()
        THEN NOW() + INTERVAL '15 minutes' ELSE window_expires_at END,
      blocked_until = CASE WHEN (CASE WHEN window_expires_at <= NOW() THEN 1 ELSE count + 1 END) >= 5
        THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
      retire_at = GREATEST(
        CASE WHEN window_expires_at <= NOW() THEN NOW() + INTERVAL '15 minutes' ELSE window_expires_at END,
        CASE WHEN (CASE WHEN window_expires_at <= NOW() THEN 1 ELSE count + 1 END) >= 5
          THEN NOW() + INTERVAL '15 minutes'
          ELSE CASE WHEN window_expires_at <= NOW() THEN NOW() + INTERVAL '15 minutes' ELSE window_expires_at END END
        ) + INTERVAL '1 hour'
      WHERE ${this.predicate(b)} AND (blocked_until IS NULL OR blocked_until <= NOW())
      RETURNING blocked_until > NOW() AS blocked`);
    return !result.rowCount || result.rows[0].blocked ? this.rejection(tx, b) : null;
  }
  async successfulLogin(tx: Connection, phone: string, runtime: AccountRuntime) {
    const b = this.key({ scope: scopes.login, identity: phone, limit: 5, seconds: 900 }, runtime);
    await tx.execute(sql`UPDATE ${table} SET count = 0, blocked_until = NULL,
      window_expires_at = NOW() + INTERVAL '15 minutes', retire_at = NOW() + INTERVAL '75 minutes'
      WHERE ${this.predicate(b)} AND (blocked_until IS NULL OR blocked_until <= NOW())`);
  }
  async cleanup(tx: Connection) {
    // Terminal, nonblocking exception to sorted admission locks: no locks follow.
    await tx.execute(sql`WITH expired AS (
      SELECT scope, key_hash FROM ${table}
      WHERE retire_at <= NOW() AND window_expires_at <= NOW()
        AND (blocked_until IS NULL OR blocked_until <= NOW())
      ORDER BY retire_at LIMIT 50 FOR UPDATE SKIP LOCKED
    ) DELETE FROM ${table} target USING expired
      WHERE target.scope = expired.scope AND target.key_hash = expired.key_hash
        AND target.retire_at <= NOW() AND target.window_expires_at <= NOW()
        AND (target.blocked_until IS NULL OR target.blocked_until <= NOW())`);
  }
}
export function getAccountLimits() { return new AccountLimits(); }