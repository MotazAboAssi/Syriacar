import "server-only";
import { getDatabase } from "../../server/db/client.ts";
import { InspectionError } from "../guest-inspection/validation.ts";
import { listGovernorates, listTowingProviders, notifyTowing, prepareLocation, type TowingConnection, type TowingRuntime } from "./service.ts";
import { TowingError } from "./validation.ts";
import { guestFailureResponse } from "../guest-security/rate-limits.ts";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
async function respond(action: () => Promise<unknown>, status = 200) {
  try { return Response.json(await action(), { status, headers }); }
  catch (error) {
    const failure = guestFailureResponse(error, headers);
    if (failure) return failure;
    if (error instanceof TowingError || error instanceof InspectionError) {
      return Response.json({ error: error.message, ...(error.fields ? { fields: error.fields } : {}) }, { status: error.status, headers });
    }
    return Response.json({ error: "حدث خطأ. حاول مجدداً." }, { status: 500, headers });
  }
}

async function readBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || !request.body) {
    throw new TowingError(422, "بيانات الطلب غير صالحة.");
  }
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) { await reader.cancel(); throw new TowingError(413, "حجم الطلب أكبر من المسموح."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { throw new TowingError(422, "بيانات الطلب غير صالحة."); }
}

export function towingHandlers(connection: () => TowingConnection = getDatabase, runtime: TowingRuntime = {}) {
  return {
    governorates: (request: Request) => respond(() => listGovernorates(new URL(request.url).searchParams.get("governorateId"), connection())),
    providers: (request: Request) => respond(() => {
      const query = new URL(request.url).searchParams;
      return listTowingProviders(query.get("originGovernorateId"), query.get("destGovernorateId"), connection(), runtime);
    }),
    create: (request: Request) => respond(async () => notifyTowing(await readBody(request), connection(), runtime), 201),
    location: (request: Request) => respond(async () => prepareLocation(await readBody(request), connection())),
  };
}