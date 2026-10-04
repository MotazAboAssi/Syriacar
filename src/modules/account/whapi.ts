import "server-only";
import type { OtpSendAttempt } from "../../server/db/schema/types.ts";

export type SendOutcome = Omit<OtpSendAttempt, "attempt_no" | "attempted_at">;
export const whapiEndpoint = "https://gate.whapi.cloud/messages/text";
const statuses = new Set(["failed", "pending", "sent", "delivered", "read", "played", "deleted"]);
export function providerStatus(value: unknown): string | null {
  return typeof value === "string" && statuses.has(value) ? value : null;
}
export const unknownOutcome = (): SendOutcome => ({
  api_outcome: "unknown", http_status: null, provider_sent: null, provider_message_id: null,
  provider_status: null, status_at: null, error_code: "unconfirmed", error_reason: null,
});
/** Raw error text is deliberately never copied: it can contain the outbound body. */
export async function sendWhapi(phone: string, code: string,
  options: { token?: string; fetch?: typeof fetch } = {}): Promise<SendOutcome> {
  const token = options.token ?? process.env.WHAPI_TOKEN;
  if (!token) return { ...unknownOutcome(), api_outcome: "failed", error_code: "not_configured" };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(whapiEndpoint, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ to: phone.replace(/^\+/, ""), body: "رمز التحقق الخاص بك: " + code }),
      signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store",
    });
  } catch { return unknownOutcome(); }
  const outcome: SendOutcome = { ...unknownOutcome(), http_status: response.status };
  let data: Record<string, unknown>;
  try { data = await response.json(); } catch {
    return response.ok ? outcome : { ...outcome, api_outcome: "failed", error_code: "http_rejected" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return response.ok ? outcome : { ...outcome, api_outcome: "failed", error_code: "http_rejected" };
  }
  const message = data.message && typeof data.message === "object" ? data.message as Record<string, unknown> : {};
  const id = typeof message.id === "string" && message.id.length <= 256 ? message.id : null;
  const status = providerStatus(message.status);
  outcome.provider_sent = typeof data.sent === "boolean" ? data.sent : null;
  outcome.provider_message_id = id;
  outcome.provider_status = status;
  if (!response.ok || data.sent === false || status === "failed") {
    return { ...outcome, api_outcome: "failed", error_code: response.ok ? "provider_rejected" : "http_rejected" };
  }
  if (data.sent === true && id) return { ...outcome, api_outcome: "api_accepted", error_code: null };
  return outcome;
}