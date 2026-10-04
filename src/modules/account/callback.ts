import "server-only";
import { eq, sql } from "drizzle-orm";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import * as s from "../../server/db/schema.ts";
import { now, type AccountRuntime } from "./security.ts";
import { AccountError } from "./validation.ts";
import { providerStatus } from "./whapi.ts";
import { sendChallenge } from "./otp.ts";
import type { AccountLimits } from "./rate-limits.ts";

const ranks: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, played: 4 };
function statusTime(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(value);
  const date = Number.isFinite(number) ? new Date(number * 1000) : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}
/** Parse only Whapi's documented statuses envelope. Never persist the callback body. */
export async function statusCallback(input: unknown, db: Connection, runtime: AccountRuntime, limits: AccountLimits) {
  if (!input || typeof input !== "object" || !Array.isArray((input as Record<string, unknown>).statuses)) {
    throw new AccountError(422, "بيانات الطلب غير صالحة.");
  }
  const statuses = (input as { statuses: unknown[] }).statuses;
  const retries = new Set<string>();
  for (const raw of statuses) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    const status = providerStatus(event.status);
    const time = statusTime(event.timestamp);
    if (typeof event.id !== "string" || event.id.length > 256 || !status || !time) continue;
    const retry = await db.transaction(async (tx) => {
      const rows = await tx.select().from(s.otpVerificationChallenges)
        .where(sql`EXISTS (SELECT 1 FROM json_array_elements(${s.otpVerificationChallenges.sendAttempts}) attempt
          WHERE attempt->>'provider_message_id' = ${event.id})`).for("update");
      for (const row of rows) {
        const index = row.sendAttempts.findIndex((attempt) => attempt.provider_message_id === event.id);
        if (index < 0) continue;
        const old = row.sendAttempts[index];
        if ((old.status_at && new Date(old.status_at) > time) || new Date(old.attempted_at) > time) continue;
        const previous = old.provider_status;
        // Confirmed delivery cannot be erased by late pending/sent/failure/deletion.
        if (previous && (ranks[previous] ?? -1) >= 2 && (ranks[status] ?? -1) < ranks[previous]) continue;
        if (previous && ranks[previous] !== undefined && ranks[status] !== undefined &&
          ranks[status] < ranks[previous]) continue;
        if (previous === status && old.status_at === time.toISOString()) continue;
        const attempts = [...row.sendAttempts];
        attempts[index] = { ...old, provider_status: status, status_at: time.toISOString() };
        const current = index === row.sendAttemptCount - 1;
        const delivered = status === "delivered" || status === "read";
        const active = !row.consumedAt && row.expiresAt > now(runtime);
        const retryAt = current && active && status === "failed" && row.sendAttemptCount < 2
          ? row.retryAt ?? new Date(now(runtime).getTime() + 5000)
          : current && delivered ? null : row.retryAt;
        await tx.update(s.otpVerificationChallenges).set({
          sendAttempts: attempts,
          ...(current ? {
            deliveryStatus: status, retryAt,
            // A matched delivery receipt resolves an earlier unknown/rejected HTTP
            // result; preserve the original per-attempt API metadata for history.
            ...(delivered ? { sendStatus: "api_accepted" as const } : {}),
          } : {}),
        }).where(eq(s.otpVerificationChallenges.id, row.id));
        if (current && retryAt && active) return row.id;
      }
      return null;
    });
    if (retry) retries.add(retry);
  }
  for (const id of retries) await sendChallenge(db, id, runtime, limits);
  return { ok: true as const };
}