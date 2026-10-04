import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { now, registrationKey, type AccountRuntime } from "./security.ts";
import { AccountError, uuid } from "./validation.ts";

export const registrationCookieName = "__Host-syriacar_registration";
export const registrationDuration = 30 * 60;
const cookieAttributes = "Path=/; HttpOnly; Secure; SameSite=Lax";
export const clearRegistrationCookie = `${registrationCookieName}=; ${cookieAttributes}; Max-Age=0`;
export interface RegistrationProof { attemptId: string; fingerprint: string }
type RegistrationUser = { id: string; phone: string | null; name: string | null; passwordHash: string };

export function invalidRegistrationFlow() {
  return new AccountError(422, "جلسة التحقق تغيّرت أو انتهت. ابدأ التسجيل مجددًا.", { code: "otp_flow_invalid" });
}
function fingerprint(user: RegistrationUser, runtime: AccountRuntime) {
  return createHmac("sha256", registrationKey(runtime))
    .update("credentials:" + JSON.stringify([user.id, user.phone, user.name, user.passwordHash])).digest("hex");
}
export function registrationMatches(proof: RegistrationProof, user: RegistrationUser, runtime: AccountRuntime) {
  const supplied = Buffer.from(proof.fingerprint, "hex");
  const expected = Buffer.from(fingerprint(user, runtime), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export async function registrationCookie(attemptId: string, user: RegistrationUser, runtime: AccountRuntime) {
  const issued = Math.floor(now(runtime).getTime() / 1000);
  const token = await new SignJWT({ attemptId, fingerprint: fingerprint(user, runtime), purpose: "registration" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt(issued)
    .setExpirationTime(issued + registrationDuration).sign(registrationKey(runtime));
  return `${registrationCookieName}=${token}; ${cookieAttributes}; Max-Age=${registrationDuration}`;
}
export async function readRegistrationProof(request: Request, runtime: AccountRuntime): Promise<RegistrationProof> {
  try {
    const matches = request.headers.get("cookie")?.split(";").map(part => part.trim())
      .filter(part => part.startsWith(registrationCookieName + "=")) ?? [];
    if (matches.length !== 1) throw new Error("Missing or duplicate proof");
    const { payload } = await jwtVerify(matches[0].slice(registrationCookieName.length + 1), registrationKey(runtime), {
      algorithms: ["HS256"], currentDate: now(runtime), requiredClaims: ["iat", "exp"],
    });
    if (payload.purpose !== "registration" ||
      Object.keys(payload).some(claim => !["attemptId", "fingerprint", "purpose", "iat", "exp"].includes(claim)) ||
      typeof payload.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(payload.fingerprint) ||
      typeof payload.iat !== "number" || typeof payload.exp !== "number" ||
      payload.iat > Math.floor(now(runtime).getTime() / 1000) || payload.exp - payload.iat !== registrationDuration) {
      throw new Error("Invalid registration claims");
    }
    return { attemptId: uuid(payload.attemptId), fingerprint: payload.fingerprint };
  } catch { throw invalidRegistrationFlow(); }
}