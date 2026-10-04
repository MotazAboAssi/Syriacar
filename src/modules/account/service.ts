import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import * as s from "../../server/db/schema.ts";
import type { Profile } from "./contracts.ts";
import { AccountError, credentials, messages, object, phone, uuid } from "./validation.ts";
import { checkPassword, hashPassword, matchesCode, now, type AccountRuntime } from "./security.ts";
import { createChallenge, latestChallenge, otpState, phoneLock, requireSuccessfulSend, sendChallenge, resendCooldown } from "./otp.ts";
import type { AccountLimits } from "./rate-limits.ts";
import { invalidRegistrationFlow, registrationCookie, registrationMatches, type RegistrationProof } from "./registration-flow.ts";

export type User = typeof s.users.$inferSelect;
export const profile = (user: User): Profile => ({
  name: user.name!, phone: user.phone!, homeGovernorateId: user.homeGovernorateId,
});
export async function register(input: unknown, ip: string, db: Connection, runtime: AccountRuntime, limits: AccountLimits) {
  const data = credentials(input, true);
  limits.registration(data.phone, ip, now(runtime).getTime());
  const passwordHash = await hashPassword(data.password);
  const challenge = await db.transaction(async (tx) => {
    await phoneLock(tx, data.phone);
    const [old] = await tx.select().from(s.users).where(eq(s.users.phone, data.phone)).for("update");
    if (old?.isActive && !old.isDeleted) throw new AccountError(409, messages.duplicate);
    const time = now(runtime);
    const [user] = old ? await tx.update(s.users).set({ name: data.name, passwordHash, isActive: false, isDeleted: false })
      .where(eq(s.users.id, old.id)).returning() : await tx.insert(s.users).values({
      id: randomUUID(), name: data.name, phone: data.phone, passwordHash, isActive: false, isDeleted: false,
      createdAt: time, lastActiveAt: time,
    }).returning();
    const row = await createChallenge(tx, data.phone, runtime, limits);
    return { row, cookie: await registrationCookie(row.id, user, runtime) };
  });
  return finishRegistrationSend(db, challenge.row.id, challenge.cookie, runtime, limits);
}
async function finishRegistrationSend(db: Connection, id: string, cookie: string, runtime: AccountRuntime, limits: AccountLimits) {
  try {
    return { state: requireSuccessfulSend(await sendChallenge(db, id, runtime, limits), runtime), cookie };
  } catch (error) {
    if (error instanceof AccountError && error.detail.otp) error.cookies = [cookie];
    throw error;
  }
}
async function boundRegistration(db: Connection, number: string, attempt: unknown, proof: RegistrationProof, runtime: AccountRuntime) {
  if (typeof attempt !== "string" || attempt !== proof.attemptId) throw invalidRegistrationFlow();
  await phoneLock(db, number);
  const [user] = await db.select().from(s.users).where(eq(s.users.phone, number)).for("update");
  const row = await latestChallenge(db, number, true);
  if (!user || user.isActive || user.isDeleted || !row || row.id !== attempt || row.phone !== number ||
    row.consumedAt || !registrationMatches(proof, user, runtime)) throw invalidRegistrationFlow();
  return { user, row };
}
export async function getOtpState(number: unknown, attempt: unknown, proof: RegistrationProof, db: Connection, runtime: AccountRuntime) {
  return db.transaction(async tx => {
    const { row } = await boundRegistration(tx, phone(number), attempt, proof, runtime);
    return otpState(row, now(runtime));
  });
}
export async function resend(input: unknown, db: Connection, runtime: AccountRuntime, limits: AccountLimits, proof: RegistrationProof) {
  const data = object(input, ["phone", "attemptId"]), number = phone(data.phone);
  const challenge = await db.transaction(async (tx) => {
    const { user, row: old } = await boundRegistration(tx, number, data.attemptId, proof, runtime);
    const time = now(runtime);
    if (!old || old.consumedAt) throw new AccountError(422, messages.otp);
    if (old.lastSentAt.getTime() + resendCooldown > time.getTime()) throw new AccountError(429, messages.cooldown);
    if (old.expiresAt > time) throw new AccountError(422, "لم تنته صلاحية رمز التحقق بعد.");
    const row = await createChallenge(tx, number, runtime, limits);
    return { row, cookie: await registrationCookie(row.id, user, runtime) };
  });
  return finishRegistrationSend(db, challenge.row.id, challenge.cookie, runtime, limits);
}
export async function verifyOtp(input: unknown, db: Connection, runtime: AccountRuntime, proof: RegistrationProof): Promise<User> {
  const data = object(input, ["phone", "code", "attemptId"]);
  const number = phone(data.phone);
  // A malformed verification submission is still a wrong verification attempt.
  const code = typeof data.code === "string" && /^\d{6}$/.test(data.code) ? data.code : "";
  const result = await db.transaction(async (tx) => {
    const { user, row } = await boundRegistration(tx, number, data.attemptId, proof, runtime);
    const time = now(runtime);
    if (!user || user.isDeleted || user.isActive || !row || row.consumedAt ||
      row.expiresAt <= time || row.attemptCount >= row.maxAttempts) return { user: null };
    if (!code || !matchesCode(code, row.id, row.codeHash, runtime)) {
      const count = row.attemptCount + 1;
      await tx.update(s.otpVerificationChallenges).set({
        attemptCount: count, ...(count >= row.maxAttempts ? { expiresAt: time, retryAt: null } : {}),
      }).where(eq(s.otpVerificationChallenges.id, row.id));
      return { user: null };
    }
    await tx.update(s.otpVerificationChallenges).set({ consumedAt: time, retryAt: null })
      .where(eq(s.otpVerificationChallenges.id, row.id));
    const [activated] = await tx.update(s.users).set({ isActive: true, lastActiveAt: time })
      .where(eq(s.users.id, user.id)).returning();
    return { user: activated };
  });
  // Throw AFTER the wrong-attempt transaction commits; never roll back its counter.
  if (!result.user) throw new AccountError(422, messages.otp, { code: "otp_invalid" });
  return result.user;
}
export async function login(input: unknown, ip: string, db: Connection, runtime: AccountRuntime, limits: AccountLimits): Promise<User> {
  const data = credentials(input);
  const key = limits.loginKey(data.phone, ip);
  limits.checkLogin(key, now(runtime).getTime());
  const result = await db.transaction(async tx => {
  await phoneLock(tx, data.phone);
  const [user] = await tx.select().from(s.users).where(eq(s.users.phone, data.phone)).for("update");
  const correct = await checkPassword(data.password, user?.passwordHash);
  if (!correct || !user || user.isDeleted) {
    limits.failLogin(key, now(runtime).getTime());
    throw new AccountError(401, messages.invalidLogin);
  }
  limits.successfulLogin(key);
  if (!user.isActive) {
    const row = await latestChallenge(tx, data.phone, true);
    const error = new AccountError(403, messages.inactive, {
      code: "inactive", ...(row && !row.consumedAt ? { otp: otpState(row, now(runtime)) } : {}),
    });
    if (row && !row.consumedAt) error.cookies = [await registrationCookie(row.id, user, runtime)];
    return { error };
  }
  const [updated] = await tx.update(s.users).set({ lastActiveAt: now(runtime) })
    .where(and(eq(s.users.id, user.id), eq(s.users.isDeleted, false), eq(s.users.isActive, true))).returning();
  if (!updated) throw new AccountError(401, messages.invalidLogin);
  return { user: updated };
  });
  if (result.error) throw result.error;
  return result.user;
}
export async function authenticatedUser(id: string, db: Connection): Promise<User> {
  const [row] = await db.select().from(s.users)
    .where(and(eq(s.users.id, id), eq(s.users.isActive, true), eq(s.users.isDeleted, false))).for("update");
  if (!row) throw new AccountError(401, messages.expiredSession);
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
export async function deleteAccount(user: User, db: Connection, runtime: AccountRuntime) {
  const time = now(runtime);
  await db.update(s.otpVerificationChallenges).set({ expiresAt: time, retryAt: null })
    .where(and(eq(s.otpVerificationChallenges.phone, user.phone!), eq(s.otpVerificationChallenges.purpose, "registration")));
  await db.update(s.vehicles).set({ plateNumber: null, color: null, notes: null }).where(eq(s.vehicles.userId, user.id));
  await db.update(s.users).set({ isDeleted: true, isActive: false, name: null, phone: null })
    .where(eq(s.users.id, user.id));
  return { ok: true as const };
}