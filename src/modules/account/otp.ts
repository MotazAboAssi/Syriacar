import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import * as s from "../../server/db/schema.ts";
import type { OtpSendAttempt } from "../../server/db/schema/types.ts";
import type { OtpState } from "./contracts.ts";
import { codeHash, newCode, now, type AccountRuntime } from "./security.ts";
import { AccountError, messages } from "./validation.ts";
import { sendWhapi, unknownOutcome, type SendOutcome } from "./whapi.ts";
import type { AccountLimits } from "./rate-limits.ts";

export type Challenge = typeof s.otpVerificationChallenges.$inferSelect;
export const otpLifetime = 10 * 60 * 1000;
export const resendCooldown = 2 * 60 * 1000;
export async function phoneLock(db: Connection, phone: string) {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${phone}, 0))`);
}
export async function latestChallenge(db: Connection, phone: string, lock = false) {
  const query = db.select().from(s.otpVerificationChallenges)
    .where(and(eq(s.otpVerificationChallenges.phone, phone), eq(s.otpVerificationChallenges.purpose, "registration")))
    .orderBy(desc(s.otpVerificationChallenges.createdAt), desc(s.otpVerificationChallenges.id)).limit(1);
  const rows = await (lock ? query.for("update") : query);
  return rows[0];
}
export function otpState(row: Challenge, time: Date): OtpState {
  const resendAt = new Date(row.lastSentAt.getTime() + resendCooldown);
  return {
    phone: row.phone, expiresAt: row.expiresAt.toISOString(), resendAt: resendAt.toISOString(),
    canResend: row.consumedAt === null && row.expiresAt <= time && resendAt <= time,
    sendStatus: row.sendStatus, deliveryStatus: row.deliveryStatus,
  };
}
export async function createChallenge(db: Connection, phone: string, runtime: AccountRuntime, limits: AccountLimits) {
  const time = now(runtime);
  limits.send(phone, time.getTime());
  // Lazy invalidation never impersonates successful verification/consumption.
  await db.update(s.otpVerificationChallenges).set({ expiresAt: time, retryAt: null })
    .where(and(eq(s.otpVerificationChallenges.phone, phone),
      eq(s.otpVerificationChallenges.purpose, "registration"), sql`${s.otpVerificationChallenges.consumedAt} IS NULL`));
  const id = randomUUID();
  const [row] = await db.insert(s.otpVerificationChallenges).values({
    id, phone, purpose: "registration", codeHash: codeHash(newCode(runtime), id, runtime),
    expiresAt: new Date(time.getTime() + otpLifetime), consumedAt: null,
    attemptCount: 0, maxAttempts: 5, createdAt: time, lastSentAt: time,
    sendAttemptCount: 0, sendStatus: "pending", sendAttempts: [],
  }).returning();
  return row;
}
async function readChallenge(db: Connection, id: string) {
  const [row] = await db.select().from(s.otpVerificationChallenges).where(eq(s.otpVerificationChallenges.id, id));
  return row;
}
/** Both sends stay in the requesting flow. Async timer never blocks Node's event loop. */
export async function sendChallenge(db: Connection, id: string, runtime: AccountRuntime, limits: AccountLimits): Promise<Challenge> {
  for (;;) {
    const current = await readChallenge(db, id);
    if (!current) throw new AccountError(500, messages.server);
    if (current.consumedAt || current.expiresAt <= now(runtime) || current.sendAttemptCount >= 2) return current;
    if (current.sendAttemptCount === 1) {
      if (!current.retryAt) return current;
      const delay = current.retryAt.getTime() - now(runtime).getTime();
      if (delay > 0) await (runtime.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(delay);
    }
    const code = newCode(runtime);
    const claimed = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(s.otpVerificationChallenges)
        .where(eq(s.otpVerificationChallenges.id, id)).for("update");
      const time = now(runtime);
      if (!row || row.consumedAt || row.expiresAt <= time || row.sendAttemptCount >= 2 ||
        (row.sendAttemptCount === 1 && (!row.retryAt || row.retryAt > time))) return null;
      const number = (row.sendAttemptCount + 1) as 1 | 2;
      let rateLimited = false;
      if (number === 2) {
        try { limits.send(row.phone, time.getTime()); } catch (error) {
          if (!(error instanceof AccountError) || error.status !== 429) throw error;
          rateLimited = true; // terminal attempted retry; no network call can exceed the hourly send ceiling.
        }
      }
      const attempt: OtpSendAttempt = {
        attempt_no: number, attempted_at: time.toISOString(), api_outcome: "pending",
        http_status: null, provider_sent: null, provider_message_id: null,
        provider_status: null, status_at: null, error_code: null, error_reason: null,
      };
      const [updated] = await tx.update(s.otpVerificationChallenges).set({
        codeHash: codeHash(code, id, runtime), expiresAt: new Date(time.getTime() + otpLifetime),
        lastSentAt: time, sendAttemptCount: number, sendStatus: "pending", deliveryStatus: null,
        retryAt: null, sendAttempts: [...row.sendAttempts, attempt],
      }).where(eq(s.otpVerificationChallenges.id, id)).returning();
      return { row: updated, number, rateLimited };
    });
    if (!claimed) return (await readChallenge(db, id))!;
    let result: SendOutcome;
    if (claimed.rateLimited) {
      result = { api_outcome: "failed", http_status: null, provider_sent: null, provider_message_id: null,
        provider_status: null, status_at: null, error_code: "rate_limited", error_reason: null };
    } else {
      try { result = await (runtime.sender ?? sendWhapi)(claimed.row.phone, code); }
      catch { result = unknownOutcome(); }
    }
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(s.otpVerificationChallenges)
        .where(eq(s.otpVerificationChallenges.id, id)).for("update");
      if (!row || row.sendAttemptCount !== claimed.number ||
        row.sendAttempts[claimed.number - 1]?.api_outcome !== "pending") return;
      const attempts = [...row.sendAttempts];
      attempts[claimed.number - 1] = { ...attempts[claimed.number - 1], ...result };
      const failed = result.api_outcome === "failed" || result.api_outcome === "unknown";
      const time = now(runtime);
      await tx.update(s.otpVerificationChallenges).set({
        sendAttempts: attempts, sendStatus: result.api_outcome,
        retryAt: failed && claimed.number === 1 && !row.consumedAt && row.expiresAt > time
          ? new Date(time.getTime() + 5000) : null,
      }).where(eq(s.otpVerificationChallenges.id, id));
    });
  }
}
export function requireSuccessfulSend(row: Challenge, runtime: AccountRuntime) {
  if (row.sendStatus === "failed" || row.sendStatus === "unknown" || row.deliveryStatus === "failed") {
    throw new AccountError(500, messages.server, { otp: otpState(row, now(runtime)) });
  }
  return otpState(row, now(runtime));
}