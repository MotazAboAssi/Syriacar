import "server-only";
import { eq } from "drizzle-orm";
import { getDatabase } from "../../server/db/client.ts";
import { users } from "../../server/db/schema.ts";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import { AccountError, messages } from "./validation.ts";
import { clearCookie, now, secretHeaderMatches, sessionCookie, sessionUserId, type AccountRuntime } from "./security.ts";
import { AccountLimits, databaseFailure, getAccountLimits, unavailable } from "./rate-limits.ts";
import * as account from "./service.ts";
import { listVehicles, references, writeVehicle } from "./vehicles.ts";
import { statusCallback } from "./callback.ts";
import { readRegistrationProof, clearRegistrationCookie } from "./registration-flow.ts";
import { readJsonBody, RequestBodyError, type BodyReadOptions } from "../../server/http/request-body.ts";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Next's absolute Request URL can contain its internal listen hostname behind
  // the preview proxy. Host is the actual HTTP authority; browsers cannot forge it.
  let valid = false;
  try {
    const supplied = new URL(origin ?? "");
    const host = request.headers.get("host") ?? new URL(request.url).host;
    valid = ["https:", "http:"].includes(supplied.protocol) &&
      supplied.protocol === new URL(request.url).protocol && supplied.host === host;
  } catch { /* Reject absent/malformed/opaque Origin. */ }
  if (!valid) throw new AccountError(403, "بيانات الطلب غير صالحة.");
}
export function accountHandlers(connection: () => Connection = getDatabase, runtime: AccountRuntime = {},
  limits: AccountLimits = getAccountLimits(), bodyOptions: BodyReadOptions = {}) {
  const body = (request: Request) => readJsonBody(request, bodyOptions);
  const responseHeaders = (cookies: string[] = []) => {
    const result = new Headers(headers);
    for (const cookie of cookies) result.append("Set-Cookie", cookie);
    return result;
  };
  const response = async (action: () => Promise<{ data: unknown; cookie?: string; cookies?: string[] }>, status = 200) => {
    try {
      const result = await action();
      return Response.json(result.data, { status, headers: responseHeaders([
        ...(result.cookie ? [result.cookie] : []), ...(result.cookies ?? []),
      ]) });
    } catch (error) {
      if (error instanceof RequestBodyError) error = new AccountError(error.status, error.message);
      if (databaseFailure(error)) error = unavailable();
      if (error instanceof AccountError) {
        const errorHeaders = responseHeaders([
          ...(error.status === 401 ? [clearCookie] : []), ...error.cookies,
        ]);
        if (error.retryAfter) errorHeaders.set("Retry-After", String(error.retryAfter));
        return Response.json(error.detail, {
          status: error.status, headers: errorHeaders,
        });
      }
      // Never log submitted passwords, codes, JWTs, Whapi tokens/payloads or raw errors.
      return Response.json({ error: messages.server }, { status: 500, headers });
    }
  };
  const authResponse = async (user: account.User) => ({
    data: account.profile(user), cookie: await sessionCookie(user.id, runtime),
  });
  const protectedResponse = (request: Request,
    action: (db: Connection, user: account.User, data: unknown) => Promise<unknown>,
    mutation = false, remove = false, status = 200) =>
    response(async () => {
      if (mutation) sameOrigin(request);
      const id = await sessionUserId(request, runtime);
      const input = mutation ? await body(request) : undefined;
      const data = await connection().transaction(async (tx) => {
        const user = await account.authenticatedUser(id, tx);
        const result = await action(tx, user, input);
        if (!remove) await tx.update(users).set({ lastActiveAt: now(runtime) }).where(eq(users.id, id));
        return result;
      });
      return { data, cookie: remove ? clearCookie : await sessionCookie(id, runtime) };
    }, status);
  return {
    register: (request: Request) => response(async () => {
      sameOrigin(request);
      const result = await account.register(await body(request), connection(), runtime, limits);
      return { data: result.state, cookie: result.cookie };
    }, 201),
    otpState: (request: Request) => response(async () => {
      const query = new URL(request.url).searchParams;
      return { data: await account.getOtpState(query.get("phone"), query.get("attemptId"),
        await readRegistrationProof(request, runtime), connection(), runtime) };
    }),
    verify: (request: Request) => response(async () => {
      sameOrigin(request);
      const input = await body(request);
      const proof = await readRegistrationProof(request, runtime);
      return { ...await authResponse(await account.verifyOtp(input, connection(), runtime,
        proof, limits)), cookies: [clearRegistrationCookie] };
    }),
    resend: (request: Request) => response(async () => {
      sameOrigin(request);
      const input = await body(request);
      const proof = await readRegistrationProof(request, runtime);
      const result = await account.resend(input, connection(), runtime, limits,
        proof);
      return { data: result.state, cookie: result.cookie };
    }),
    login: (request: Request) => response(async () => {
      sameOrigin(request);
      return authResponse(await account.login(await body(request), connection(), runtime, limits));
    }),
    logout: (request: Request) => response(async () => {
      sameOrigin(request);
      // Keep bodyless logout supported, but bound/validate a supplied body.
      if (request.body) await body(request);
      return { data: { ok: true }, cookie: clearCookie };
    }),
    profile: (request: Request) => protectedResponse(request, async (_db, user) => account.profile(user)),
    saveProfile: (request: Request) => protectedResponse(request,
      (db, user, data) => account.saveHome(data, user, db), true),
    deleteAccount: (request: Request) => response(async () => {
      sameOrigin(request);
      const id = await sessionUserId(request, runtime);
      // DELETE has no business payload; a supplied body must finish before DB.
      if (request.body) await body(request);
      return { data: await account.deleteAccount(id, connection(), runtime, limits), cookie: clearCookie };
    }),
    references: (request: Request) => protectedResponse(request, (db) => references(db)),
    vehicles: (request: Request) => protectedResponse(request, (db, user) => listVehicles(db, user.id)),
    vehicle: (request: Request, id: string) => protectedResponse(request,
      async (db, user) => (await listVehicles(db, user.id, id))[0]),
    addVehicle: (request: Request) => protectedResponse(request,
      (db, user, data) => writeVehicle(db, user.id, data, runtime), true, false, 201),
    editVehicle: (request: Request, id: string) => protectedResponse(request,
      (db, user, data) => writeVehicle(db, user.id, data, runtime, id), true),
    callback: (request: Request) => response(async () => {
      // URL must be HTTPS; do not trust a client-supplied forwarded-proto override.
      if (new URL(request.url).protocol !== "https:" ||
        !secretHeaderMatches(request.headers.get("x-whapi-secret"), runtime.callbackSecret ?? process.env.WHAPI_CALLBACK_SECRET)) {
        throw new AccountError(401, "غير مصرح.");
      }
      return { data: await statusCallback(await body(request), connection(), runtime, limits) };
    }),
  };
}