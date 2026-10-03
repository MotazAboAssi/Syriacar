import { inspectionHandlers } from "../../../../modules/guest-inspection/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = inspectionHandlers().localities;