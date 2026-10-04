import "server-only";
import { getDatabase } from "../../server/db/client.ts";
import { createGuestInspection, listLocalities, listProviders, type InspectionConnection, type InspectionRuntime } from "./service.ts";
import { InspectionError } from "./validation.ts";
import { guestFailureResponse } from "../guest-security/rate-limits.ts";
import { readJsonBody, RequestBodyError, type BodyReadOptions } from "../../server/http/request-body.ts";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

async function safeResponse(action: () => Promise<unknown>, status = 200) {
  try {
    return Response.json(await action(), { status, headers });
  } catch (error) {
    if (error instanceof RequestBodyError) error = new InspectionError(error.status, error.message);
    const failure = guestFailureResponse(error, headers);
    if (failure) return failure;
    if (error instanceof InspectionError) {
      return Response.json({ error: error.message, ...(error.fields ? { fields: error.fields } : {}) },
        { status: error.status, headers });
    }
    // Never print submitted guest data, hashes, database credentials or raw errors.
    return Response.json({ error: "حدث خطأ. حاول مجدداً." }, { status: 500, headers });
  }
}

/** Injectable DB/clock are server-only seams for rollback-isolated real-PG tests. */
export function inspectionHandlers(connection: () => InspectionConnection = getDatabase, runtime: InspectionRuntime = {},
  bodyOptions: BodyReadOptions = {}) {
  return {
    localities: (request: Request) => safeResponse(() =>
      listLocalities(new URL(request.url).searchParams.get("governorateId"), connection())),
    providers: (request: Request) => safeResponse(() => {
      const query = new URL(request.url).searchParams;
      return listProviders(query.get("governorateId"), query.get("regionId"), connection(), runtime);
    }),
    create: (request: Request) => safeResponse(async () =>
      createGuestInspection(await readJsonBody(request, bodyOptions), connection(), runtime), 201),
  };
}