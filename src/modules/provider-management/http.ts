import "server-only";
import { getDatabase } from "../../server/db/client.ts";
import { readJsonBody, RequestBodyError, type BodyReadOptions } from "../../server/http/request-body.ts";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import { AccountError, credentials, messages, object, uuid } from "../account/validation.ts";
import { type AccountRuntime } from "../account/security.ts";
import { accountTransaction, databaseFailure, getAccountLimits, unavailable, type AccountLimits } from "../account/rate-limits.ts";
import { clearProviderCookie, providerSessionId } from "./security.ts";
import * as service from "./service.ts";

const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
function sameOrigin(request: Request) {
  // Same authority contract as account mutations: Host, never forwarded headers.
  let valid = false;
  try {
    const origin = new URL(request.headers.get("origin") ?? ""), url = new URL(request.url);
    valid = ["http:", "https:"].includes(origin.protocol) && origin.protocol === url.protocol &&
      origin.host === (request.headers.get("host") ?? url.host);
  } catch { /* Reject absent, opaque or malformed Origin. */ }
  if (!valid) throw new AccountError(403, "بيانات الطلب غير صالحة.");
}
export function providerHandlers(connection: () => Connection = getDatabase, runtime: AccountRuntime = {},
  limits: AccountLimits = getAccountLimits(), bodyOptions: BodyReadOptions = {}) {
  const response = async (action: () => Promise<{ data: unknown; cookie?: string }>) => {
    const headers = new Headers(responseHeaders);
    try {
      const result = await action();
      if (result.cookie) headers.append("Set-Cookie", result.cookie);
      return Response.json(result.data, { headers });
    } catch (error) {
      if (error instanceof RequestBodyError) error = new AccountError(error.status, error.message);
      if (databaseFailure(error)) error = unavailable();
      if (error instanceof AccountError) {
        if (error.status === 401 || (error.status === 403 && error.message === "حساب المزود غير متاح للدخول.")) {
          headers.append("Set-Cookie", clearProviderCookie);
        }
        if (error.retryAfter) headers.set("Retry-After", String(error.retryAfter));
        return Response.json(error.detail, { status: error.status, headers });
      }
      // Do not log raw errors, bodies, cookies, credentials or customer contacts.
      return Response.json({ error: messages.server }, { status: 500, headers });
    }
  };
  const protectedRead = (request: Request, action: (db: Connection, provider: service.Provider) => Promise<unknown>) =>
    response(async () => {
      const id = await providerSessionId(request, runtime);
      const data = await accountTransaction(connection(), async tx => action(tx, await service.activeProvider(tx, id)));
      return { data };
    });
  return {
    login: (request: Request) => response(async () => {
      sameOrigin(request);
      const input = credentials(await readJsonBody(request, bodyOptions)); // Full body + business validation before DB.
      return service.login({ phone: input.phone, password: input.password }, connection(), runtime, limits);
    }),
    logout: (request: Request) => response(async () => {
      sameOrigin(request);
      const id = await providerSessionId(request, runtime);
      if (request.body) object(await readJsonBody(request, bodyOptions), []);
      await accountTransaction(connection(), async tx => { await service.activeProvider(tx, id); });
      return { data: { ok: true }, cookie: clearProviderCookie };
    }),
    profile: (request: Request) => protectedRead(request, service.profile),
    references: (request: Request) => protectedRead(request, db => service.references(db)),
    notifications: (request: Request) => response(async () => {
      const id = await providerSessionId(request, runtime);
      const query = service.notificationQuery(new URL(request.url)); // Validate cursor before DB acquisition.
      const data = await accountTransaction(connection(), async tx => {
        await service.activeProvider(tx, id);
        return service.notifications(tx, id, query);
      });
      return { data };
    }),
    notification: (request: Request, rawId: string) => response(async () => {
      const providerId = await providerSessionId(request, runtime), id = uuid(rawId);
      const data = await accountTransaction(connection(), async tx => {
        await service.activeProvider(tx, providerId);
        return service.notification(tx, providerId, id);
      });
      return { data };
    }),
  };
}