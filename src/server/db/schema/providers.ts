import { sql } from "drizzle-orm";
import { boolean, check, date, index, json, numeric, pgTable, primaryKey, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { opsUsers } from "./administration.ts";
import { editRequestStatus, providerStatus, serviceType, vehicleCategory, yearCategory } from "./enums.ts";
import { brandGroups, brands, fuelTypes, governorates, regions, towTypes } from "./reference.ts";
import { defaultWorkDays, type WorkDays } from "./types.ts";

export const providers = pgTable("providers", {
  id: uuid("id").primaryKey(),
  businessName: varchar("business_name").notNull(),
  phone: varchar("phone").notNull().unique("providers_phone_unique"),
  whatsappNumber: varchar("whatsapp_number", { length: 20 }).notNull().unique("providers_whatsapp_unique"),
  passwordHash: varchar("password_hash").notNull(),
  serviceType: serviceType("service_type").notNull(),
  status: providerStatus("status").notNull().default("pending"),
  governorateId: uuid("governorate_id").notNull().references(() => governorates.id),
  regionId: uuid("region_id").notNull().references(() => regions.id),
  locationLat: numeric("location_lat"),
  locationLng: numeric("location_lng"),
  locationUrl: varchar("location_url"),
  workDays: json("work_days").$type<WorkDays>().notNull().default(defaultWorkDays),
  todayClosed: boolean("today_closed").notNull().default(false),
  todayClosedDate: date("today_closed_date"),
  specializations: json("specializations"),
  towTypeId: uuid("tow_type_id").references(() => towTypes.id),
  createdAt: timestamp("created_at").notNull(),
  createdBy: uuid("created_by").notNull().references(() => opsUsers.id),
}, (t) => [
  index("providers_matching_idx").on(t.status, t.serviceType, t.governorateId, t.regionId),
  index("providers_governorate_idx").on(t.governorateId),
  index("providers_region_idx").on(t.regionId),
  index("providers_tow_type_idx").on(t.towTypeId),
  index("providers_created_by_idx").on(t.createdBy),
  check("providers_today_closed_check", sql`
    (${t.todayClosed} AND ${t.todayClosedDate} IS NOT NULL)
    OR (NOT ${t.todayClosed} AND ${t.todayClosedDate} IS NULL)
  `),
]);

export const providerCoverage = pgTable("provider_coverage", {
  id: uuid("id").primaryKey(),
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  governorateId: uuid("governorate_id").notNull().references(() => governorates.id),
}, (t) => [
  unique("provider_coverage_provider_governorate_unique").on(t.providerId, t.governorateId),
  index("provider_coverage_governorate_provider_idx").on(t.governorateId, t.providerId),
]);

export const providerBrands = pgTable("provider_brands", {
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  brandId: uuid("brand_id").notNull().references(() => brands.id),
}, (t) => [
  primaryKey({ columns: [t.providerId, t.brandId] }),
  index("provider_brands_brand_idx").on(t.brandId),
]);

export const providerBrandGroups = pgTable("provider_brand_groups", {
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  brandGroupId: uuid("brand_group_id").notNull().references(() => brandGroups.id),
}, (t) => [
  primaryKey({ columns: [t.providerId, t.brandGroupId] }),
  index("provider_brand_groups_brand_group_idx").on(t.brandGroupId),
]);

export const providerYearCategories = pgTable("provider_year_categories", {
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  yearCategory: yearCategory("year_category").notNull(),
}, (t) => [primaryKey({ columns: [t.providerId, t.yearCategory] })]);

export const providerFuelTypes = pgTable("provider_fuel_types", {
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  fuelTypeId: uuid("fuel_type_id").notNull().references(() => fuelTypes.id),
}, (t) => [
  primaryKey({ columns: [t.providerId, t.fuelTypeId] }),
  index("provider_fuel_types_fuel_type_idx").on(t.fuelTypeId),
]);

export const providerVehicleCategories = pgTable("provider_vehicle_categories", {
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  vehicleCategory: vehicleCategory("vehicle_category").notNull(),
}, (t) => [primaryKey({ columns: [t.providerId, t.vehicleCategory] })]);

export const providerPushSubscriptions = pgTable("provider_push_subscriptions", {
  id: uuid("id").primaryKey(),
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  endpoint: varchar("endpoint").notNull().unique("provider_push_subscriptions_endpoint_unique"),
  p256dh: varchar("p256dh").notNull(),
  auth: varchar("auth").notNull(),
  createdAt: timestamp("created_at").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull(),
  expiresAt: timestamp("expires_at"),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [index("provider_push_subscriptions_provider_active_idx").on(t.providerId, t.isActive)]);

export const providerEditRequests = pgTable("provider_edit_requests", {
  id: uuid("id").primaryKey(),
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  fieldName: varchar("field_name").notNull(),
  requestedValue: json("requested_value").notNull(),
  status: editRequestStatus("status").notNull().default("pending"),
  reviewedBy: uuid("reviewed_by").references(() => opsUsers.id),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull(),
}, (t) => [
  index("provider_edit_requests_provider_status_created_idx").on(t.providerId, t.status, t.createdAt),
  index("provider_edit_requests_reviewed_by_idx").on(t.reviewedBy),
  check("provider_edit_requests_field_check", sql`${t.fieldName} IN ('business_name', 'phone', 'coverage')`),
]);