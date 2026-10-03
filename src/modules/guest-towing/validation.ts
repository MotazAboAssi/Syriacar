import { isE164, isUuid } from "../guest-inspection/validation.ts";
import type { TowingApiError, TowingInput } from "./contracts.ts";

export class TowingError extends Error {
  readonly status: number;
  readonly fields?: TowingApiError["fields"];
  constructor(status: number, message: string, fields?: TowingApiError["fields"]) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export function parseRoute(origin: unknown, dest: unknown) {
  const fields: TowingApiError["fields"] = {};
  if (!isUuid(origin)) fields.originGovernorateId = "اختر محافظة الانطلاق.";
  if (!isUuid(dest)) fields.destGovernorateId = "اختر محافظة الوصول.";
  if (Object.keys(fields).length) throw new TowingError(422, "راجع محافظتي المسار.", fields);
  // Neither frozen SRS nor DBMS prohibits a route within one governorate.
  return { originGovernorateId: (origin as string).toLowerCase(), destGovernorateId: (dest as string).toLowerCase() };
}

export function objectBody(body: unknown, allowed: string[]) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new TowingError(422, "بيانات الطلب غير صالحة.");
  }
  return body as Record<string, unknown>;
}

export function parseTowing(body: unknown): TowingInput {
  const data = objectBody(body, ["originGovernorateId", "destGovernorateId", "providerId",
    "guestName", "guestPhone", "acceptedTerms", "requestProof"]);
  const route = parseRoute(data.originGovernorateId, data.destGovernorateId);
  const fields: TowingApiError["fields"] = {};
  const guestName = typeof data.guestName === "string" ? data.guestName.trim() : "";
  const guestPhone = typeof data.guestPhone === "string" ? data.guestPhone.trim() : "";
  if (!guestName || guestName.includes("\0")) fields.guestName = "أدخل اسماً صالحاً.";
  if (!isE164(guestPhone)) fields.guestPhone = "أدخل رقم الهاتف بصيغة دولية تبدأ بعلامة +.";
  if (!isUuid(data.providerId)) fields.providerId = "اختر مزوداً صالحاً.";
  if (data.acceptedTerms !== true) fields.acceptedTerms = "يلزم تأكيد الموافقة قبل تسجيل الطلب.";
  if (data.requestProof !== undefined && (typeof data.requestProof !== "string" || !data.requestProof)) {
    fields.requestProof = "تعذر التحقق من الطلب السابق.";
  }
  if (Object.keys(fields).length) throw new TowingError(422, "راجع بيانات الطلب.", fields);
  return { ...route, providerId: (data.providerId as string).toLowerCase(), guestName, guestPhone,
    acceptedTerms: true, ...(data.requestProof !== undefined ? { requestProof: data.requestProof as string } : {}) };
}