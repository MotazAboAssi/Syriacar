import "server-only";
import {
  AccountLimits, accountTransaction, databaseFailure, unavailable, type Budget,
} from "../account/rate-limits.ts";
import { AccountError } from "../account/validation.ts";
import type { InspectionConnection } from "../guest-inspection/service.ts";

export const guestScopes = {
  parentPhone: "guest.parent.phone",
  notificationPhone: "guest.notification.phone",
  parentGlobal: "guest.parent.global",
} as const;
export const globalIdentity = "all-guest-parents";
export const guestLimits = { parentsPerPhone: 10, notificationsPerPhone: 40, parentsGlobal: 20 };
/** Server-only fixture seam. Production uses the existing shared signing secret. */
export interface GuestQuotaRuntime { quotaSecret?: string }
export const guestTransaction = accountTransaction;

/** Policy adapter only: SQL, hashing, time, sorted locks and cleanup stay shared. */
export class GuestLimits {
  private readonly engine = new AccountLimits();

  budgets(phone: string, newParent: boolean, notification: boolean): Budget[] {
    const result: Budget[] = [];
    if (newParent) {
      result.push(
        { scope: guestScopes.parentGlobal, identity: globalIdentity, limit: guestLimits.parentsGlobal, seconds: 3600 },
        { scope: guestScopes.parentPhone, identity: phone, limit: guestLimits.parentsPerPhone, seconds: 3600 },
      );
    }
    if (notification) result.push({
      scope: guestScopes.notificationPhone, identity: phone, limit: guestLimits.notificationsPerPhone, seconds: 3600,
    });
    return result;
  }

  admit(tx: InspectionConnection, phone: string, newParent: boolean, notification: boolean, runtime: GuestQuotaRuntime = {}) {
    return this.engine.admit(tx, this.budgets(phone, newParent, notification), { secret: runtime.quotaSecret });
  }

  cleanup(tx: InspectionConnection) { return this.engine.cleanup(tx); }
}

/** Expose only generic quota/availability errors, never account payload/cookies. */
export function guestFailureResponse(error: unknown, headers: Record<string, string>): Response | null {
  const failure = error instanceof AccountError && (error.status === 429 || error.status === 503)
    ? error : databaseFailure(error) ? unavailable() : null;
  if (!failure) return null;
  return Response.json({ error: failure.message }, {
    status: failure.status,
    headers: {
      ...headers,
      ...(failure.retryAfter ? { "Retry-After": String(Math.ceil(failure.retryAfter)) } : {}),
    },
  });
}