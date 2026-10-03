import { pgEnum } from "drizzle-orm/pg-core";

export const yearCategory = pgEnum("year_category", ["classic", "mid", "modern"]);
export const vehicleCategory = pgEnum("vehicle_category", ["car", "truck"]);
export const verificationStatus = pgEnum("verification_status", [
  "pending_verification", "verified", "rejected",
]);
export const serviceType = pgEnum("service_type", ["inspection", "towing"]);
export const providerStatus = pgEnum("provider_status", ["pending", "active", "disabled"]);
export const userType = pgEnum("user_type", ["registered", "guest"]);
export const matchingStatus = pgEnum("matching_status", ["matched", "no_match"]);
export const followupStatus = pgEnum("followup_status", [
  "pending", "service_completed", "provider_no_response", "issue",
]);
export const opsRole = pgEnum("ops_role", ["operations", "super_admin"]);
export const editRequestStatus = pgEnum("edit_request_status", ["pending", "approved", "rejected"]);
export const otpSendStatus = pgEnum("otp_send_status", [
  "pending", "api_accepted", "failed", "unknown",
]);