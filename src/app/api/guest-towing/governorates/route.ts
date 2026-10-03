import { towingHandlers } from "@/modules/guest-towing/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = towingHandlers().governorates;