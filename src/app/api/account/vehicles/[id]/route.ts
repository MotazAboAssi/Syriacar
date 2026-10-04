import { accountHandlers } from "../../../../../modules/account/http.ts";
export const runtime = "nodejs";
const handlers = accountHandlers();
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return handlers.vehicle(request, (await context.params).id);
}
export async function PATCH(request: Request, context: Context) {
  return handlers.editVehicle(request, (await context.params).id);
}