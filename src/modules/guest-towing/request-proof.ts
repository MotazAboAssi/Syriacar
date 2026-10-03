import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isUuid } from "../guest-inspection/validation.ts";
import { TowingError } from "./validation.ts";

function signature(requestId: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new TowingError(503, "تعذر التحقق من الطلب. حاول لاحقاً.");
  return createHmac("sha256", secret).update(`guest-towing-request:${requestId}`).digest("base64url");
}

// Request-bound bearer proof, not a login/session. No guest identity in the
// token, cookies, localStorage, new secrets, or persistence/schema changes.
export function signRequest(requestId: string) {
  return `${requestId}.${signature(requestId)}`;
}

export function verifyRequest(proof: unknown) {
  if (typeof proof !== "string") throw new TowingError(403, "تعذر التحقق من الطلب السابق.");
  const [id, mac, extra] = proof.split(".");
  if (!isUuid(id) || !mac || extra !== undefined) throw new TowingError(403, "تعذر التحقق من الطلب السابق.");
  const expected = Buffer.from(signature(id));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new TowingError(403, "تعذر التحقق من الطلب السابق.");
  }
  return id;
}