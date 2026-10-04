import { isE164, isUuid } from "../guest-inspection/validation.ts";
import type { ApiError, VehicleInput } from "./contracts.ts";

export class AccountError extends Error {
  // Internal response metadata; never part of the JSON detail.
  cookies: string[] = [];
  status: number;
  detail: ApiError;
  constructor(status: number, error: string, extra: Omit<ApiError, "error"> = {}) {
    super(error);
    this.status = status;
    this.detail = { error, ...extra };
  }
}
export const messages = {
  invalidLogin: "رقم الهاتف أو كلمة المرور غير صحيحة.",
  inactive: "لم يكتمل تفعيل حسابك بعد.",
  locked: "محاولات كثيرة. حاول مجدداً بعد 15 دقيقة.",
  duplicate: "الرقم مسجَّل مسبقاً.",
  cooldown: "يرجى الانتظار دقيقتين قبل إعادة الإرسال.",
  expiredSession: "انتهت جلستك. الرجاء تسجيل الدخول مجدداً.",
  server: "حدث خطأ. حاول مجدداً.",
  otp: "رمز التحقق غير صحيح أو لم يعد صالحاً.",
};
export function object(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new AccountError(422, "بيانات الطلب غير صالحة.");
  }
  return input as Record<string, unknown>;
}
/** Reuse the frozen guest E.164 validator; no unapproved local-number conversion. */
export function phone(value: unknown): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!isE164(result) || !/^\+963\d+$/.test(result)) {
    throw new AccountError(422, "تحقق من رقم الهاتف.", { fields: { phone: "أدخل رقماً سورياً بصيغة +963 ثم الرقم." } });
  }
  return result;
}
export function credentials(input: unknown, registration = false) {
  const data = object(input, registration ? ["name", "phone", "password"] : ["phone", "password"]);
  const number = phone(data.phone);
  const password = typeof data.password === "string" ? data.password : "";
  if (!password || (registration && [...password].length < 8)) {
    throw new AccountError(422, "تحقق من كلمة المرور.", {
      fields: { password: registration ? "كلمة المرور 8 أحرف على الأقل." : "أدخل كلمة المرور." },
    });
  }
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (registration && (!name || name.includes("\0"))) {
    throw new AccountError(422, "تحقق من الاسم.", { fields: { name: "أدخل اسماً صالحاً." } });
  }
  return { phone: number, password, name };
}
export function uuid(value: unknown, field = "id"): string {
  if (!isUuid(value)) throw new AccountError(422, "بيانات غير صالحة.", { fields: { [field]: "اختر قيمة صالحة." } });
  return value.toLowerCase();
}
export function vehicleInput(input: unknown, currentYear: number): VehicleInput {
  const data = object(input, ["brandGroupId", "brandId", "year", "fuelTypeId", "vehicleCategory", "plateNumber", "color", "notes"]);
  const fields: Record<string, string> = {};
  for (const field of ["brandGroupId", "brandId", "fuelTypeId"]) {
    if (!isUuid(data[field])) fields[field] = "اختر قيمة متاحة.";
  }
  if (!Number.isInteger(data.year) || (data.year as number) < 1970 || (data.year as number) > currentYear) {
    fields.year = `أدخل سنة بين 1970 و${currentYear}.`;
  }
  if (data.vehicleCategory !== "car" && data.vehicleCategory !== "truck") fields.vehicleCategory = "اختر سيارة أو شاحنة.";
  for (const field of ["plateNumber", "color", "notes"]) {
    if (data[field] !== undefined && data[field] !== null &&
      (typeof data[field] !== "string" || (data[field] as string).includes("\0"))) fields[field] = "أدخل نصاً صالحاً.";
  }
  if (Object.keys(fields).length) throw new AccountError(422, "تحقق من بيانات المركبة.", { fields });
  const nullable = (key: string) => typeof data[key] === "string" ? (data[key] as string).trim() || null : null;
  return {
    brandGroupId: uuid(data.brandGroupId), brandId: uuid(data.brandId), year: data.year as number,
    fuelTypeId: uuid(data.fuelTypeId), vehicleCategory: data.vehicleCategory as "car" | "truck",
    plateNumber: nullable("plateNumber"), color: nullable("color"), notes: nullable("notes"),
  };
}