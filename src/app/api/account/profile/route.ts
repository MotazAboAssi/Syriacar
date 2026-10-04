import { accountHandlers } from "../../../../modules/account/http.ts";
export const runtime = "nodejs";
const handlers = accountHandlers();
export const GET = handlers.profile;
export const PATCH = handlers.saveProfile;
export const DELETE = handlers.deleteAccount;