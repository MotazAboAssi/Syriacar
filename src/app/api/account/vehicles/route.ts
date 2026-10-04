import { accountHandlers } from "../../../../modules/account/http.ts";
export const runtime = "nodejs";
const handlers = accountHandlers();
export const GET = handlers.vehicles;
export const POST = handlers.addVehicle;