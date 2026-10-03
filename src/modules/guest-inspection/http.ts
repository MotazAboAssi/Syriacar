import "server-only";
import { getDatabase } from "../../server/db/client.ts";
import { createGuestInspection, listLocalities, listProviders, type InspectionConnection, type InspectionRuntime } from "./service.ts";
import { InspectionError } from "./validation.ts";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

async function safeResponse(action: () => Promise<unknown>, status = 200) {
  try {
    return Response.json(await action(), { status, headers });
  } catch (error) {
    if (error instanceof InspectionError) {
      return Response.json({ error: error.message, ...(error.fields ? { fields: error.fields } : {}) },
        { status: error.status, headers });
    }
    // Never print submitted guest data, hashes, database credentials or raw errors.
    return Response.json({ error: "حدث خطأ. حاول مجدداً." }, { status: 500, headers });
  }
}

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new InspectionError(422, "بيانات الطلب غير صالحة.");
  }
  // Transport safety bound, not a new product constraint on guest-name length.
  const reader = request.body?.getReader();
  if (!reader) throw new InspectionError(422, "بيانات الطلب غير صالحة.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new InspectionError(413, "حجم الطلب أكبر من المسموح.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InspectionError(422, "بيانات الطلب غير صالحة.");
  }
}

/** Injectable DB/clock are server-only seams for rollback-isolated real-PG tests. */
export function inspectionHandlers(connection: () => InspectionConnection = getDatabase, runtime: InspectionRuntime = {}) {
  return {
    localities: (request: Request) => safeResponse(() =>
      listLocalities(new URL(request.url).searchParams.get("governorateId"), connection())),
    providers: (request: Request) => safeResponse(() => {
      const query = new URL(request.url).searchParams;
      return listProviders(query.get("governorateId"), query.get("regionId"), connection(), runtime);
    }),
    create: (request: Request) => safeResponse(async () =>
      createGuestInspection(await readBody(request), connection(), runtime), 201),
  };
}