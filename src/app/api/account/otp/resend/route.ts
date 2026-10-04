import { accountHandlers } from "../../../../../modules/account/http.ts";
export const runtime = "nodejs";
export const POST = accountHandlers().resend;