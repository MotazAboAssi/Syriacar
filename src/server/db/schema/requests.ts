import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users, vehicles } from "./accounts.ts";
import { opsUsers } from "./administration.ts";
import { followupStatus, matchingStatus, serviceType, userType } from "./enums.ts";
import { providers } from "./providers.ts";
import { governorates, regions } from "./reference.ts";

export const serviceRequests = pgTable("service_requests", {
  id: uuid("id").primaryKey(),
  serviceType: serviceType("service_type").notNull(),
  userType: userType("user_type").notNull(),
  userId: uuid("user_id").references(() => users.id),
  guestName: varchar("guest_name"),
  guestPhone: varchar("guest_phone"),
  vehicleId: uuid("vehicle_id").references(() => vehicles.id),
  inspectionGovernorateId: uuid("inspection_governorate_id").references(() => governorates.id),
  inspectionRegionId: uuid("inspection_region_id").references(() => regions.id),
  originGovernorateId: uuid("origin_governorate_id").references(() => governorates.id),
  destGovernorateId: uuid("dest_governorate_id").references(() => governorates.id),
  // Must be supplied explicitly; never silently assume a match.
  matchingStatus: matchingStatus("matching_status").notNull(),
  createdAt: timestamp("created_at").notNull(),
}, (t) => [
  index("service_requests_user_service_created_idx").on(t.userId, t.serviceType, t.createdAt),
  index("service_requests_kpi_idx").on(t.userType, t.matchingStatus, t.createdAt),
  index("service_requests_inspection_locality_created_idx").on(
    t.inspectionGovernorateId, t.inspectionRegionId, t.createdAt,
  ),
  index("service_requests_inspection_region_idx").on(t.inspectionRegionId),
  index("service_requests_vehicle_idx").on(t.vehicleId),
  index("service_requests_origin_governorate_idx").on(t.originGovernorateId),
  index("service_requests_dest_governorate_idx").on(t.destGovernorateId),
  check("service_requests_locality_route_check", sql`
    (${t.serviceType} = 'inspection'
      AND ${t.inspectionGovernorateId} IS NOT NULL AND ${t.inspectionRegionId} IS NOT NULL
      AND ${t.originGovernorateId} IS NULL AND ${t.destGovernorateId} IS NULL
      AND (${t.userType} <> 'registered' OR ${t.vehicleId} IS NOT NULL))
    OR (${t.serviceType} = 'towing'
      AND ${t.inspectionGovernorateId} IS NULL AND ${t.inspectionRegionId} IS NULL
      AND ${t.originGovernorateId} IS NOT NULL AND ${t.destGovernorateId} IS NOT NULL)
  `),
]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  serviceRequestId: uuid("service_request_id").notNull().references(() => serviceRequests.id),
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  serviceType: serviceType("service_type").notNull(),
  userType: userType("user_type").notNull(),
  userId: uuid("user_id").references(() => users.id),
  guestName: varchar("guest_name"),
  guestPhone: varchar("guest_phone"),
  vehicleId: uuid("vehicle_id").references(() => vehicles.id),
  originGovernorateId: uuid("origin_governorate_id").references(() => governorates.id),
  destGovernorateId: uuid("dest_governorate_id").references(() => governorates.id),
  followupStatus: followupStatus("followup_status").notNull().default("pending"),
  followupNotes: text("followup_notes"),
  followupBy: uuid("followup_by").references(() => opsUsers.id),
  followupAt: timestamp("followup_at"),
  createdAt: timestamp("created_at").notNull(),
}, (t) => [
  index("notifications_provider_created_idx").on(t.providerId, t.createdAt),
  index("notifications_service_request_idx").on(t.serviceRequestId),
  index("notifications_followup_created_idx").on(t.followupStatus, t.createdAt),
  index("notifications_user_idx").on(t.userId),
  index("notifications_vehicle_idx").on(t.vehicleId),
  index("notifications_origin_governorate_idx").on(t.originGovernorateId),
  index("notifications_dest_governorate_idx").on(t.destGovernorateId),
  index("notifications_followup_by_idx").on(t.followupBy),
]);