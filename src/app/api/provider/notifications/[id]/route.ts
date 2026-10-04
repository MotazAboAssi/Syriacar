import { providerHandlers } from "../../../../../modules/provider-management/http.ts";
export const runtime = "nodejs";
const handlers = providerHandlers();
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers.notification(request, (await context.params).id);
}