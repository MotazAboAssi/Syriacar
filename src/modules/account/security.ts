import "server-only";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { jwtVerify, SignJWT } from "jose";
import { AccountError, messages, uuid } from "./validation.ts";
import type { RegistrationPreparation } from "./registration-preparation.ts";

export const sessionDuration = 30 * 24 * 60 * 60;
export const cookieName = "syriacar_user";
export interface AccountRuntime {
  now?: () => Date;
  secret?: string;
  callbackSecret?: string;
  code?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  sender?: (phone: string, code: string) => Promise<import("./whapi.ts").SendOutcome>;
  /** Server-only fixture seams; never read from request input. */
  registrationPreparation?: RegistrationPreparation;
  registrationHash?: (password: string) => Promise<string>;
}
export const now = (runtime: AccountRuntime) => runtime.now?.() ?? new Date();
function key(runtime: AccountRuntime, purpose: string) {
  const secret = runtime.secret ?? process.env.SESSION_SECRET;
  if (!secret) throw new Error("Account signing secret is not configured");
  return createHmac("sha256", secret).update(`syriacar:account:${purpose}`).digest();
}
export const registrationKey = (runtime: AccountRuntime) => key(runtime, "registration-flow");
export function rateLimitHash(scope: string, identity: string, runtime: AccountRuntime) {
  return createHmac("sha256", key(runtime, "rate-limits"))
    .update(JSON.stringify([scope, identity])).digest("hex");
}
export function newCode(runtime: AccountRuntime) {
  const value = runtime.code?.() ?? randomInt(0, 1_000_000).toString().padStart(6, "0");
  if (!/^\d{6}$/.test(value)) throw new Error("Invalid OTP generator");
  return value;
}
export function codeHash(code: string, challengeId: string, runtime: AccountRuntime) {
  return createHmac("sha256", key(runtime, "otp")).update(`${challengeId}:${code}`).digest("hex");
}
export function matchesCode(code: string, id: string, stored: string, runtime: AccountRuntime) {
  const expected = Buffer.from(codeHash(code, id, runtime), "hex");
  const actual = Buffer.from(stored, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const hashPassword = (password: string) => hash(password, {
  algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32,
});
let dummyHash: Promise<string> | undefined;
export async function checkPassword(password: string, passwordHash?: string) {
  dummyHash ??= hashPassword("not-an-account-credential");
  try { return await verify(passwordHash ?? await dummyHash, password); } catch { return false; }
}
export async function sessionCookie(userId: string, runtime: AccountRuntime) {
  const issued = Math.floor(now(runtime).getTime() / 1000);
  const token = await new SignJWT({ id: userId, role: "user" }).setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issued).setExpirationTime(issued + sessionDuration).sign(key(runtime, "jwt"));
  return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionDuration}`;
}
export const clearCookie = `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
export async function sessionUserId(request: Request, runtime: AccountRuntime) {
  try {
    const token = request.headers.get("cookie")?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
    if (!token) throw new Error("Missing cookie");
    const { payload } = await jwtVerify(token, key(runtime, "jwt"), {
      algorithms: ["HS256"], currentDate: now(runtime), requiredClaims: ["exp", "iat"],
    });
    if (payload.role !== "user" || Object.keys(payload).some((claim) => !["id", "role", "iat", "exp"].includes(claim))) {
      throw new Error("Invalid account claims");
    }
    return uuid(payload.id);
  } catch { throw new AccountError(401, messages.expiredSession); }
}
export function secretHeaderMatches(supplied: string | null, expected: string | undefined) {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}