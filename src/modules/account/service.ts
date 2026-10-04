import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import * as s from "../../server/db/schema.ts";
import type { Profile } from "./contracts.ts";
import { AccountError, credentials, messages, object, phone, uuid } from "./validation.ts";
import { checkPassword, matchesCode, now, type AccountRuntime } from "./security.ts";
import { createChallenge, latestChallenge, lockChallenges, otpState, phoneLock, requireSuccessfulSend, sendChallenge, resendCooldown } from "./otp.ts";
import { accountTransaction, getAccountLimits, type AccountLimits } from "./rate-limits.ts";
import { invalidRegistrationFlow, registrationCookie, registrationMatches, type RegistrationProof } from "./registration-flow.ts";
import { prepareRegistration } from "./registration-preparation.ts";
import { requireTestAccountEnvironment } from "../../server/db/seed/test-account-access.ts";

export type User = typeof s.users.$inferSelect;
export const profile = (user: User): Profile => ({
  name: user.name!, phone: user.phone!, homeGovernorateId: user.homeGovernorateId,
});
export async function register(input: unknown, db: Connection, runtime: AccountRuntime, limits: AccountLimits) {
  const data = credentials(input, true);
  requireTestAccountEnvironment(data.phone);
  const challenge = await prepareRegistration(db, runtime, async (tx, work) => {
    await phoneLock(tx, data.phone);
    work.checkpoint();
    const [old] = await tx.select().from(s.users).where(eq(s.users.phone, data.phone)).for("update");
    work.checkpoint();
    await lockChallenges(tx, data.phone);
    work.checkpoint();
    const previous = await latestChallenge(tx, data.phone);
    work.checkpoint();
    const duplicate = old?.isActive && !old.isDeleted;
    await limits.admit(tx, [limits.budget("registration", data.phone),
      ...(!duplicate ? [limits.budget("send", data.phone)] : [])], runtime);
    work.checkpoint();
    const passwordHash = await work.hash(data.password);
    if (duplicate) {
      await limits.cleanup(tx);
      return { error: new AccountError(409, messages.duplicate) };
    }
    const time = now(runtime);
    const [user] = old ? await tx.update(s.users).set({ name: data.name, passwordHash, isActive: false, isDeleted: false })
      .where(eq(s.users.id, old.id)).returning() : await tx.insert(s.users).values({
      id: randomUUID(), name: data.name, phone: data.phone, passwordHash, isActive: false, isDeleted: false,
      createdAt: time, lastActiveAt: time,
    }).returning();
    work.checkpoint();
    const { row, code } = await createChallenge(tx, data.phone, runtime, previous);
    work.checkpoint();
    const cookie = await registrationCookie(row.id, user, runtime);
    work.checkpoint();
    await limits.cleanup(tx);
    return { row, code, cookie };
  });
  if (challenge.error) throw challenge.error;
  return finishRegistrationSend(db, challenge.row, challenge.code, challenge.cookie, runtime, limits);
}
async function finishRegistrationSend(db: Connection, row: import("./otp.ts").Challenge, code: string,
  cookie: string, runtime: AccountRuntime, limits: AccountLimits) {
  try {
    return { state: requireSuccessfulSend(await sendChallenge(db, row.id, runtime, limits, code), runtime), cookie };
  } catch (error) {
    if (error instanceof AccountError && error.status === 503 && !error.detail.otp) {
      // Explicitly the creator's own attempt, never discover/adopt a newer one.
      error.detail.otp = otpState(row, now(runtime));
    }
    if (error instanceof AccountError && error.detail.otp) error.cookies = [cookie];
    throw error;
  }
}
async function boundRegistration(db: Connection, number: string, attempt: unknown, proof: RegistrationProof, runtime: AccountRuntime) {
  if (typeof attempt !== "string" || attempt !== proof.attemptId) throw invalidRegistrationFlow();
  await phoneLock(db, number);
  const [user] = await db.select().from(s.users).where(eq(s.users.phone, number)).for("update");
  await lockChallenges(db, number);
  const row = await latestChallenge(db, number);
  if (!user || user.isActive || user.isDeleted || !row || row.id !== attempt || row.phone !== number ||
    row.consumedAt || !registrationMatches(proof, user, runtime)) throw invalidRegistrationFlow();
  return { user, row };
}
export async function getOtpState(number: unknown, attempt: unknown, proof: RegistrationProof, db: Connection, runtime: AccountRuntime) {
  return accountTransaction(db, async tx => {
    const { row } = await boundRegistration(tx, phone(number), attempt, proof, runtime);
    return otpState(row, now(runtime));
  });
}
export async function resend(input: unknown, db: Connection, runtime: AccountRuntime, limits: AccountLimits, proof: RegistrationProof) {
  const data = object(input, ["phone", "attemptId"]), number = phone(data.phone);
  const challenge = await accountTransaction(db, async (tx) => {
    const { user, row: old } = await boundRegistration(tx, number, data.attemptId, proof, runtime);
    const time = now(runtime);
    if (!old || old.consumedAt) throw new AccountError(422, messages.otp);
    if (old.lastSentAt.getTime() + resendCooldown > time.getTime()) throw new AccountError(429, messages.cooldown);
    if (old.expiresAt > time) throw new AccountError(422, "لم تنته صلاحية رمز التحقق بعد.");
    await limits.admit(tx, [limits.budget("send", number)], runtime);
    const { row, code } = await createChallenge(tx, number, runtime, old);
    const cookie = await registrationCookie(row.id, user, runtime);
    await limits.cleanup(tx);
    return { row, code, cookie };
  });
  return finishRegistrationSend(db, challenge.row, challenge.code, challenge.cookie, runtime, limits);
}
export async function verifyOtp(input: unknown, db: Connection, runtime: AccountRuntime, proof: RegistrationProof,
  limits = getAccountLimits()): Promise<User> {
  const data = object(input, ["phone", "code", "attemptId"]);
  const number = phone(data.phone);
  // A malformed verification submission is still a wrong verification attempt.
  const code = typeof data.code === "string" && /^\d{6}$/.test(data.code) ? data.code : "";
  const result = await accountTransaction(db, async (tx) => {
    const { user, row } = await boundRegistration(tx, number, data.attemptId, proof, runtime);
    const time = now(runtime);
    if (!user || user.isDeleted || user.isActive || !row || row.consumedAt ||
      row.expiresAt <= time || row.attemptCount >= row.maxAttempts) return { user: null };
    await limits.admit(tx, [limits.budget("verify", number)], runtime);
    if (!code || !matchesCode(code, row.id, row.codeHash, runtime)) {
      const count = row.attemptCount + 1;
      await tx.update(s.otpVerificationChallenges).set({
        attemptCount: count, ...(count >= row.maxAttempts ? { expiresAt: time, retryAt: null } : {}),
      }).where(eq(s.otpVerificationChallenges.id, row.id));
      await limits.cleanup(tx);
      return { user: null };
    }
    await tx.update(s.otpVerificationChallenges).set({ consumedAt: time, retryAt: null })
      .where(eq(s.otpVerificationChallenges.id, row.id));
    const [activated] = await tx.update(s.users).set({ isActive: true, lastActiveAt: time })
      .where(eq(s.users.id, user.id)).returning();
    await limits.cleanup(tx);
    return { user: activated };
  });
  // Throw AFTER the wrong-attempt transaction commits; never roll back its counter.
  if (!result.user) throw new AccountError(422, messages.otp, { code: "otp_invalid" });
  return result.user;
}
export async function login(input: unknown, db: Connection, runtime: AccountRuntime, limits: AccountLimits): Promise<User> {
  const data = credentials(input);
  requireTestAccountEnvironment(data.phone);
  const result = await accountTransaction(db, async tx => {
  await phoneLock(tx, data.phone);
  const [user] = await tx.select().from(s.users).where(eq(s.users.phone, data.phone)).for("update");
  await lockChallenges(tx, data.phone);
  const row = await latestChallenge(tx, data.phone);
  const blocked = await limits.checkLogin(tx, data.phone, runtime);
  if (blocked) return { error: blocked };
  const correct = await checkPassword(data.password, user?.passwordHash);
  if (!correct || !user || user.isDeleted) {
    const error = await limits.failLogin(tx, data.phone, runtime) ?? new AccountError(401, messages.invalidLogin);
    await limits.cleanup(tx);
    return { error };
  }
  await limits.successfulLogin(tx, data.phone, runtime);
  if (!user.isActive) {
    const error = new AccountError(403, messages.inactive, {
      code: "inactive", ...(row && !row.consumedAt ? { otp: otpState(row, now(runtime)) } : {}),
    });
    if (row && !row.consumedAt) error.cookies = [await registrationCookie(row.id, user, runtime)];
    await limits.cleanup(tx);
    return { error };
  }
  const [updated] = await tx.update(s.users).set({ lastActiveAt: now(runtime) })
    .where(and(eq(s.users.id, user.id), eq(s.users.isDeleted, false), eq(s.users.isActive, true))).returning();
  if (!updated) throw new AccountError(401, messages.invalidLogin);
  await limits.cleanup(tx);
  return { user: updated };
  });
  if (result.error) throw result.error;
  return result.user;
}
export async function authenticatedUser(id: string, db: Connection): Promise<User> {
  requireTestAccountEnvironment(id);
  const [row] = await db.select().from(s.users)
    .where(and(eq(s.users.id, id), eq(s.users.isActive, true), eq(s.users.isDeleted, false))).for("update");
  if (!row) throw new AccountError(401, messages.expiredSession);
  requireTestAccountEnvironment(row.phone);
  return row;
}
export async function saveHome(input: unknown, user: User, db: Connection): Promise<Profile> {
  const value = object(input, ["homeGovernorateId"]).homeGovernorateId;
  const id = value === null ? null : uuid(value, "homeGovernorateId");
  if (id) {
    const [row] = await db.select().from(s.governorates)
      .where(and(eq(s.governorates.id, id), eq(s.governorates.isActive, true))).for("share");
    if (!row) throw new AccountError(422, "اختر محافظة متاحة.", { fields: { homeGovernorateId: "اختر محافظة متاحة." } });
  }
  const [row] = await db.update(s.users).set({ homeGovernorateId: id }).where(eq(s.users.id, user.id)).returning();
  return profile(row);
}
export async function deleteAccount(id: string, db: Connection, runtime: AccountRuntime, limits: AccountLimits) {
  return accountTransaction(db, async tx => {
    const [peek] = await tx.select({ phone: s.users.phone }).from(s.users).where(eq(s.users.id, id));
    if (!peek?.phone) throw new AccountError(401, messages.expiredSession);
    await phoneLock(tx, peek.phone);
    const user = await authenticatedUser(id, tx);
    if (user.phone !== peek.phone) throw new AccountError(401, messages.expiredSession);
    await lockChallenges(tx, peek.phone);
    await limits.admit(tx, [limits.budget("deletion", id)], runtime);
    const time = now(runtime);
    await tx.update(s.otpVerificationChallenges).set({ expiresAt: time, retryAt: null })
      .where(and(eq(s.otpVerificationChallenges.phone, user.phone!), eq(s.otpVerificationChallenges.purpose, "registration")));
    await tx.update(s.vehicles).set({ plateNumber: null, color: null, notes: null }).where(eq(s.vehicles.userId, user.id));
    await tx.update(s.users).set({ isDeleted: true, isActive: false, name: null, phone: null })
      .where(eq(s.users.id, user.id));
    await limits.cleanup(tx);
    return { ok: true as const };
  });
}