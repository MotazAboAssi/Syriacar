import "server-only";
import { getDatabase } from "../../server/db/client.ts";
import { InspectionError } from "../guest-inspection/validation.ts";
import { listGovernorates, listTowingProviders, notifyTowing, prepareLocation, type TowingConnection, type TowingRuntime } from "./service.ts";
import { TowingError } from "./validation.ts";
import { guestFailureResponse } from "../guest-security/rate-limits.ts";
import { readJsonBody, RequestBodyError, type BodyReadOptions } from "../../server/http/request-body.ts";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
async function respond(action: () => Promise<unknown>, status = 200) {
  try { return Response.json(await action(), { status, headers }); }
  catch (error) {
    if (error instanceof RequestBodyError) error = new TowingError(error.status, error.message);
    const failure = guestFailureResponse(error, headers);
    if (failure) return failure;
    if (error instanceof TowingError || error instanceof InspectionError) {
      return Response.json({ error: error.message, ...(error.fields ? { fields: error.fields } : {}) }, { status: error.status, headers });
    }
    return Response.json({ error: "حدث خطأ. حاول مجدداً." }, { status: 500, headers });
  }
}

export function towingHandlers(connection: () => TowingConnection = getDatabase, runtime: TowingRuntime = {},
  bodyOptions: BodyReadOptions = {}) {
  return {
    governorates: (request: Request) => respond(() => listGovernorates(new URL(request.url).searchParams.get("governorateId"), connection())),
    providers: (request: Request) => respond(() => {
      const query = new URL(request.url).searchParams;
      return listTowingProviders(query.get("originGovernorateId"), query.get("destGovernorateId"), connection(), runtime);
    }),
    create: (request: Request) => respond(async () => notifyTowing(await readJsonBody(request, bodyOptions), connection(), runtime), 201),
    location: (request: Request) => respond(async () => prepareLocation(await readJsonBody(request, bodyOptions), connection())),
  };
}