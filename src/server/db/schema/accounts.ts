import { sql } from "drizzle-orm";
import { boolean, check, index, json, pgTable, smallint, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { otpSendStatus, vehicleCategory, verificationStatus, yearCategory } from "./enums.ts";
import { brandGroups, brands, fuelTypes, governorates } from "./reference.ts";
import type { OtpSendAttempt } from "./types.ts";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  name: varchar("name"),
  phone: varchar("phone").unique("users_phone_unique"),
  passwordHash: varchar("password_hash").notNull(),
  homeGovernorateId: uuid("home_governorate_id").references(() => governorates.id),
  isActive: boolean("is_active").notNull().default(false),
  isDeleted: boolean("is_deleted").notNull().default(false),
  createdAt: timestamp("created_at").notNull(),
  lastActiveAt: timestamp("last_active_at").notNull(),
}, (t) => [
  index("users_home_governorate_idx").on(t.homeGovernorateId),
  check("users_anonymization_check", sql`
    (NOT ${t.isDeleted} AND ${t.name} IS NOT NULL AND ${t.phone} IS NOT NULL)
    OR (${t.isDeleted} AND ${t.name} IS NULL AND ${t.phone} IS NULL AND NOT ${t.isActive})
  `),
]);

export const otpVerificationChallenges = pgTable("otp_verification_challenges", {
  id: uuid("id").primaryKey(),
  phone: varchar("phone").notNull(),
  purpose: varchar("purpose").notNull(),
  codeHash: varchar("code_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  attemptCount: smallint("attempt_count").notNull().default(0),
  maxAttempts: smallint("max_attempts").notNull().default(5),
  createdAt: timestamp("created_at").notNull(),
  lastSentAt: timestamp("last_sent_at").notNull(),
  sendAttemptCount: smallint("send_attempt_count").notNull().default(0),
  sendStatus: otpSendStatus("send_status").notNull().default("pending"),
  deliveryStatus: varchar("delivery_status"),
  retryAt: timestamp("retry_at"),
  sendAttempts: json("send_attempts").$type<OtpSendAttempt[]>().notNull().default(sql`'[]'::json`),
}, (t) => [
  index("otp_phone_purpose_expiry_idx").on(t.phone, t.purpose, t.expiresAt),
  index("otp_send_outcome_expiry_idx").on(t.sendStatus, t.sendAttemptCount, t.expiresAt),
  index("otp_retry_at_idx").on(t.retryAt),
  check("otp_send_attempt_count_check", sql`${t.sendAttemptCount} BETWEEN 0 AND 2`),
  check("otp_send_attempts_length_check", sql`
    CASE WHEN json_typeof(${t.sendAttempts}) = 'array'
    THEN json_array_length(${t.sendAttempts}) <= 2 ELSE false END
  `),
]);

export const vehicles = pgTable("vehicles", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  brandGroupId: uuid("brand_group_id").notNull().references(() => brandGroups.id),
  brandId: uuid("brand_id").notNull().references(() => brands.id),
  year: smallint("year").notNull(),
  yearCategory: yearCategory("year_category").notNull(),
  fuelTypeId: uuid("fuel_type_id").notNull().references(() => fuelTypes.id),
  vehicleCategory: vehicleCategory("vehicle_category").notNull(),
  plateNumber: varchar("plate_number"),
  color: varchar("color"),
  notes: text("notes"),
  verificationStatus: verificationStatus("verification_status").notNull().default("pending_verification"),
  createdAt: timestamp("created_at").notNull(),
}, (t) => [
  index("vehicles_user_capabilities_idx").on(
    t.userId, t.fuelTypeId, t.yearCategory, t.vehicleCategory, t.verificationStatus,
  ),
  index("vehicles_brand_group_idx").on(t.brandGroupId),
  index("vehicles_brand_idx").on(t.brandId),
  index("vehicles_fuel_type_idx").on(t.fuelTypeId),
  check("vehicles_year_check", sql`${t.year} BETWEEN 1970 AND EXTRACT(YEAR FROM CURRENT_TIMESTAMP)`),
]);