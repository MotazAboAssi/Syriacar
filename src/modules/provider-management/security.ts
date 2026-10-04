import "server-only";
import { createHmac } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { AccountError, messages, uuid } from "../account/validation.ts";
import { now, sessionDuration, type AccountRuntime } from "../account/security.ts";

export const providerCookieName = "syriacar_provider";
export const clearProviderCookie = `${providerCookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
function providerKey(runtime: AccountRuntime) {
  const secret = runtime.secret ?? process.env.SESSION_SECRET;
  if (!secret) throw new Error("Provider signing secret is not configured");
  return createHmac("sha256", secret).update("syriacar:provider:jwt").digest();
}
export async function providerSessionCookie(id: string, runtime: AccountRuntime = {}) {
  const issued = Math.floor(now(runtime).getTime() / 1000);
  const token = await new SignJWT({ id, role: "provider" }).setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issued).setExpirationTime(issued + sessionDuration).sign(providerKey(runtime));
  return `${providerCookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionDuration}`;
}
export async function providerSessionId(request: Request, runtime: AccountRuntime = {}) {
  try {
    const cookies = request.headers.get("cookie")?.split(";").map(part => part.trim())
      .filter(part => part.startsWith(providerCookieName + "=")) ?? [];
    if (cookies.length !== 1) throw new Error("Missing or duplicate cookie");
    const { payload } = await jwtVerify(cookies[0].slice(providerCookieName.length + 1), providerKey(runtime), {
      algorithms: ["HS256"], currentDate: now(runtime), requiredClaims: ["exp", "iat"],
    });
    if (payload.role !== "provider" || Object.keys(payload).some(key => !["id", "role", "iat", "exp"].includes(key))) {
      throw new Error("Invalid provider claims");
    }
    return uuid(payload.id);
  } catch { throw new AccountError(401, messages.expiredSession); }
}