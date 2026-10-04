import { accountHandlers } from "../../../../modules/account/http.ts";
export const runtime = "nodejs";
export const GET = accountHandlers().otpState;
export const POST = accountHandlers().verify;