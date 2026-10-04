import "server-only";
import { eq } from "drizzle-orm";
import { getDatabase } from "../../server/db/client.ts";
import { users } from "../../server/db/schema.ts";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import { InspectionError } from "../guest-inspection/validation.ts";
import { TowingError } from "../guest-towing/validation.ts";
import { AccountError, messages } from "../account/validation.ts";
import { authenticatedUser, type User } from "../account/service.ts";
import { clearCookie, sessionCookie, sessionUserId, now, type AccountRuntime } from "../account/security.ts";
import { inspectionProviders } from "./inspection.ts";
import { confirm, location } from "./service.ts";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
/** Same Build6 Origin/body rules; kept registered-specific to leave Guest unchanged. */
async function body(request: Request) {
  try {
    const origin = new URL(request.headers.get("origin") ?? "");
    const url = new URL(request.url);
    if (!["http:", "https:"].includes(origin.protocol) || origin.protocol !== url.protocol ||
      origin.host !== (request.headers.get("host") ?? url.host)) throw new Error();
  } catch { throw new AccountError(403, "بيانات الطلب غير صالحة."); }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AccountError(422, "بيانات الطلب غير صالحة.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError(422, "بيانات الطلب غير صالحة.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) { await reader.cancel(); throw new AccountError(413, "حجم الطلب أكبر من المسموح."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new AccountError(422, "بيانات الطلب غير صالحة."); }
}
export function registeredHandlers(connection: () => Connection = getDatabase, runtime: AccountRuntime = {}) {
  const handle = async (request: Request, action: (db: Connection, user: User, data: unknown) => Promise<unknown>,
    mutation = false, status = 200) => {
    try {
      const data = mutation ? await body(request) : undefined;
      const id = await sessionUserId(request, runtime);
      const result = await connection().transaction(async tx => {
        const user = await authenticatedUser(id, tx);
        const output = await action(tx, user, data);
        await tx.update(users).set({ lastActiveAt: now(runtime) }).where(eq(users.id, id));
        return output;
      });
      return Response.json(result, { status, headers: { ...headers, "Set-Cookie": await sessionCookie(id, runtime) } });
    } catch (error) {
      if (error instanceof AccountError) return Response.json(error.detail, { status: error.status,
        headers: { ...headers, ...(error.status === 401 ? { "Set-Cookie": clearCookie } : {}) } });
      if (error instanceof InspectionError || error instanceof TowingError) {
        return Response.json({ error: error.message, fields: error.fields }, { status: error.status, headers });
      }
      // No payload/error logging: neither identity nor GPS enters logs.
      return Response.json({ error: messages.server }, { status: 500, headers });
    }
  };
  return {
    providers: (request: Request) => handle(request, (db, user) => {
      const p = new URL(request.url).searchParams;
      if ([...p.keys()].some(k => !["vehicleId", "governorateId", "regionId"].includes(k))) {
        throw new AccountError(422, "بيانات الطلب غير صالحة.");
      }
      return inspectionProviders(db, user.id, p.get("vehicleId"), p.get("governorateId"), p.get("regionId"), now(runtime));
    }),
    inspection: (request: Request) => handle(request, (db, user, data) => confirm(db, user, data, "inspection", now(runtime)), true, 201),
    towing: (request: Request) => handle(request, (db, user, data) => confirm(db, user, data, "towing", now(runtime)), true, 201),
    location: (request: Request) => handle(request, (db, user, data) => location(db, user, data), true),
  };
}