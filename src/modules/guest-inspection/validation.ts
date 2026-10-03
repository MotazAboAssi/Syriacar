import type { GuestInspectionInput, InspectionApiError } from "./contracts.ts";

export class InspectionError extends Error {
  readonly status: number;
  readonly fields?: InspectionApiError["fields"];

  constructor(status: number, message: string, fields?: InspectionApiError["fields"]) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const isE164 = (value: string) => /^\+[1-9]\d{1,14}$/.test(value);

export function parseLocality(governorateId: unknown, regionId: unknown) {
  const fields: InspectionApiError["fields"] = {};
  if (!isUuid(governorateId)) fields.governorateId = "اختر المحافظة.";
  if (!isUuid(regionId)) fields.regionId = "اختر المنطقة.";
  if (Object.keys(fields).length) throw new InspectionError(422, "تحقق من بيانات المحلية.", fields);
  return { governorateId: (governorateId as string).toLowerCase(), regionId: (regionId as string).toLowerCase() };
}

export function parseGuestInspection(input: unknown): GuestInspectionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InspectionError(422, "بيانات الطلب غير صالحة.");
  }
  const data = input as Record<string, unknown>;
  const allowed = ["governorateId", "regionId", "providerId", "guestName", "guestPhone", "acceptedTerms"];
  if (Object.keys(data).some((key) => !allowed.includes(key))) {
    throw new InspectionError(422, "بيانات الطلب غير صالحة.");
  }
  const locality = parseLocality(data.governorateId, data.regionId);
  const fields: InspectionApiError["fields"] = {};
  const guestName = typeof data.guestName === "string" ? data.guestName.trim() : "";
  const guestPhone = typeof data.guestPhone === "string" ? data.guestPhone.trim() : "";
  if (!guestName || guestName.includes("\0")) fields.guestName = "أدخل اسماً صالحاً.";
  if (!isE164(guestPhone)) fields.guestPhone = "أدخل رقم الهاتف بصيغة دولية، مثل +963 ثم الرقم.";
  if (data.providerId !== null && !isUuid(data.providerId)) fields.providerId = "اختر مزوداً صالحاً.";
  if (data.acceptedTerms !== true) fields.acceptedTerms = "يلزم تأكيد الموافقة قبل تسجيل الطلب.";
  if (Object.keys(fields).length) throw new InspectionError(422, "تحقق من بيانات الطلب.", fields);
  return { ...locality, providerId: typeof data.providerId === "string" ? data.providerId.toLowerCase() : null,
    guestName, guestPhone, acceptedTerms: true };
}