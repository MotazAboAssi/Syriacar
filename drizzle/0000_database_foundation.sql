CREATE TYPE "public"."edit_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."followup_status" AS ENUM('pending', 'service_completed', 'provider_no_response', 'issue');--> statement-breakpoint
CREATE TYPE "public"."matching_status" AS ENUM('matched', 'no_match');--> statement-breakpoint
CREATE TYPE "public"."ops_role" AS ENUM('operations', 'super_admin');--> statement-breakpoint
CREATE TYPE "public"."otp_send_status" AS ENUM('pending', 'api_accepted', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."provider_status" AS ENUM('pending', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."service_type" AS ENUM('inspection', 'towing');--> statement-breakpoint
CREATE TYPE "public"."user_type" AS ENUM('registered', 'guest');--> statement-breakpoint
CREATE TYPE "public"."vehicle_category" AS ENUM('car', 'truck');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending_verification', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."year_category" AS ENUM('classic', 'mid', 'modern');--> statement-breakpoint
CREATE TABLE "brand_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name_ar" varchar NOT NULL,
	"display_order" smallint NOT NULL,
	"is_active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brand_group_id" uuid NOT NULL,
	"name_ar" varchar NOT NULL,
	"display_order" smallint NOT NULL,
	"is_active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fuel_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar NOT NULL,
	"name_ar" varchar NOT NULL,
	"display_order" smallint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "fuel_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "governorates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name_ar" varchar NOT NULL,
	"is_active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"governorate_id" uuid NOT NULL,
	"name_ar" varchar NOT NULL,
	"is_active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tow_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar NOT NULL,
	"name_ar" varchar NOT NULL,
	"display_order" smallint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "tow_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ops_user_id" uuid NOT NULL,
	"action" varchar NOT NULL,
	"entity_type" varchar NOT NULL,
	"entity_id" varchar NOT NULL,
	"old_value" json,
	"new_value" json,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" varchar NOT NULL,
	"template_ar" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "message_templates_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "ops_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"username" varchar NOT NULL,
	"password_hash" varchar NOT NULL,
	"role" "ops_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "ops_users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "system_config" (
	"key" varchar PRIMARY KEY NOT NULL,
	"value" varchar NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_verification_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" varchar NOT NULL,
	"purpose" varchar NOT NULL,
	"code_hash" varchar NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 5 NOT NULL,
	"created_at" timestamp NOT NULL,
	"last_sent_at" timestamp NOT NULL,
	"send_attempt_count" smallint DEFAULT 0 NOT NULL,
	"send_status" "otp_send_status" DEFAULT 'pending' NOT NULL,
	"delivery_status" varchar,
	"retry_at" timestamp,
	"send_attempts" json DEFAULT '[]'::json NOT NULL,
	CONSTRAINT "otp_send_attempt_count_check" CHECK ("otp_verification_challenges"."send_attempt_count" BETWEEN 0 AND 2),
	CONSTRAINT "otp_send_attempts_length_check" CHECK (
    CASE WHEN json_typeof("otp_verification_challenges"."send_attempts") = 'array'
    THEN json_array_length("otp_verification_challenges"."send_attempts") <= 2 ELSE false END
  )
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar,
	"phone" varchar,
	"password_hash" varchar NOT NULL,
	"home_governorate_id" uuid,
	"is_active" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL,
	"last_active_at" timestamp NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_anonymization_check" CHECK (
    (NOT "users"."is_deleted" AND "users"."name" IS NOT NULL AND "users"."phone" IS NOT NULL)
    OR ("users"."is_deleted" AND "users"."name" IS NULL AND "users"."phone" IS NULL AND NOT "users"."is_active")
  )
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"brand_group_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"year_category" "year_category" NOT NULL,
	"fuel_type_id" uuid NOT NULL,
	"vehicle_category" "vehicle_category" NOT NULL,
	"plate_number" varchar,
	"color" varchar,
	"notes" text,
	"verification_status" "verification_status" DEFAULT 'pending_verification' NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "vehicles_year_check" CHECK ("vehicles"."year" BETWEEN 1970 AND EXTRACT(YEAR FROM CURRENT_TIMESTAMP))
);
--> statement-breakpoint
CREATE TABLE "provider_brand_groups" (
	"provider_id" uuid NOT NULL,
	"brand_group_id" uuid NOT NULL,
	CONSTRAINT "provider_brand_groups_provider_id_brand_group_id_pk" PRIMARY KEY("provider_id","brand_group_id")
);
--> statement-breakpoint
CREATE TABLE "provider_brands" (
	"provider_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	CONSTRAINT "provider_brands_provider_id_brand_id_pk" PRIMARY KEY("provider_id","brand_id")
);
--> statement-breakpoint
CREATE TABLE "provider_coverage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"governorate_id" uuid NOT NULL,
	CONSTRAINT "provider_coverage_provider_governorate_unique" UNIQUE("provider_id","governorate_id")
);
--> statement-breakpoint
CREATE TABLE "provider_edit_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"field_name" varchar NOT NULL,
	"requested_value" json NOT NULL,
	"status" "edit_request_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "provider_edit_requests_field_check" CHECK ("provider_edit_requests"."field_name" IN ('business_name', 'phone', 'coverage'))
);
--> statement-breakpoint
CREATE TABLE "provider_fuel_types" (
	"provider_id" uuid NOT NULL,
	"fuel_type_id" uuid NOT NULL,
	CONSTRAINT "provider_fuel_types_provider_id_fuel_type_id_pk" PRIMARY KEY("provider_id","fuel_type_id")
);
--> statement-breakpoint
CREATE TABLE "provider_push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"endpoint" varchar NOT NULL,
	"p256dh" varchar NOT NULL,
	"auth" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "provider_push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "provider_vehicle_categories" (
	"provider_id" uuid NOT NULL,
	"vehicle_category" "vehicle_category" NOT NULL,
	CONSTRAINT "provider_vehicle_categories_provider_id_vehicle_category_pk" PRIMARY KEY("provider_id","vehicle_category")
);
--> statement-breakpoint
CREATE TABLE "provider_year_categories" (
	"provider_id" uuid NOT NULL,
	"year_category" "year_category" NOT NULL,
	CONSTRAINT "provider_year_categories_provider_id_year_category_pk" PRIMARY KEY("provider_id","year_category")
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_name" varchar NOT NULL,
	"phone" varchar NOT NULL,
	"whatsapp_number" varchar(20) NOT NULL,
	"password_hash" varchar NOT NULL,
	"service_type" "service_type" NOT NULL,
	"status" "provider_status" DEFAULT 'pending' NOT NULL,
	"governorate_id" uuid NOT NULL,
	"region_id" uuid NOT NULL,
	"location_lat" numeric,
	"location_lng" numeric,
	"location_url" varchar,
	"work_days" json DEFAULT '{"sat":{"enabled":true,"start":"08:00","end":"20:00"},"sun":{"enabled":true,"start":"08:00","end":"20:00"},"mon":{"enabled":true,"start":"08:00","end":"20:00"},"tue":{"enabled":true,"start":"08:00","end":"20:00"},"wed":{"enabled":true,"start":"08:00","end":"20:00"},"thu":{"enabled":true,"start":"08:00","end":"20:00"},"fri":{"enabled":false,"start":null,"end":null}}'::json NOT NULL,
	"today_closed" boolean DEFAULT false NOT NULL,
	"today_closed_date" date,
	"specializations" json,
	"tow_type_id" uuid,
	"created_at" timestamp NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "providers_phone_unique" UNIQUE("phone"),
	CONSTRAINT "providers_whatsapp_unique" UNIQUE("whatsapp_number"),
	CONSTRAINT "providers_today_closed_check" CHECK (
    ("providers"."today_closed" AND "providers"."today_closed_date" IS NOT NULL)
    OR (NOT "providers"."today_closed" AND "providers"."today_closed_date" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service_request_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"service_type" "service_type" NOT NULL,
	"user_type" "user_type" NOT NULL,
	"user_id" uuid,
	"guest_name" varchar,
	"guest_phone" varchar,
	"vehicle_id" uuid,
	"origin_governorate_id" uuid,
	"dest_governorate_id" uuid,
	"followup_status" "followup_status" DEFAULT 'pending' NOT NULL,
	"followup_notes" text,
	"followup_by" uuid,
	"followup_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service_type" "service_type" NOT NULL,
	"user_type" "user_type" NOT NULL,
	"user_id" uuid,
	"guest_name" varchar,
	"guest_phone" varchar,
	"vehicle_id" uuid,
	"inspection_governorate_id" uuid,
	"inspection_region_id" uuid,
	"origin_governorate_id" uuid,
	"dest_governorate_id" uuid,
	"matching_status" "matching_status" NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "service_requests_locality_route_check" CHECK (
    ("service_requests"."service_type" = 'inspection'
      AND "service_requests"."inspection_governorate_id" IS NOT NULL AND "service_requests"."inspection_region_id" IS NOT NULL
      AND "service_requests"."origin_governorate_id" IS NULL AND "service_requests"."dest_governorate_id" IS NULL
      AND ("service_requests"."user_type" <> 'registered' OR "service_requests"."vehicle_id" IS NOT NULL))
    OR ("service_requests"."service_type" = 'towing'
      AND "service_requests"."inspection_governorate_id" IS NULL AND "service_requests"."inspection_region_id" IS NULL
      AND "service_requests"."origin_governorate_id" IS NOT NULL AND "service_requests"."dest_governorate_id" IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_brand_group_id_brand_groups_id_fk" FOREIGN KEY ("brand_group_id") REFERENCES "public"."brand_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regions" ADD CONSTRAINT "regions_governorate_id_governorates_id_fk" FOREIGN KEY ("governorate_id") REFERENCES "public"."governorates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_ops_user_id_ops_users_id_fk" FOREIGN KEY ("ops_user_id") REFERENCES "public"."ops_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_updated_by_ops_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."ops_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_config" ADD CONSTRAINT "system_config_updated_by_ops_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."ops_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_home_governorate_id_governorates_id_fk" FOREIGN KEY ("home_governorate_id") REFERENCES "public"."governorates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_brand_group_id_brand_groups_id_fk" FOREIGN KEY ("brand_group_id") REFERENCES "public"."brand_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_fuel_type_id_fuel_types_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_brand_groups" ADD CONSTRAINT "provider_brand_groups_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_brand_groups" ADD CONSTRAINT "provider_brand_groups_brand_group_id_brand_groups_id_fk" FOREIGN KEY ("brand_group_id") REFERENCES "public"."brand_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_brands" ADD CONSTRAINT "provider_brands_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_brands" ADD CONSTRAINT "provider_brands_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_coverage" ADD CONSTRAINT "provider_coverage_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_coverage" ADD CONSTRAINT "provider_coverage_governorate_id_governorates_id_fk" FOREIGN KEY ("governorate_id") REFERENCES "public"."governorates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_edit_requests" ADD CONSTRAINT "provider_edit_requests_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_edit_requests" ADD CONSTRAINT "provider_edit_requests_reviewed_by_ops_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."ops_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_fuel_types" ADD CONSTRAINT "provider_fuel_types_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_fuel_types" ADD CONSTRAINT "provider_fuel_types_fuel_type_id_fuel_types_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_push_subscriptions" ADD CONSTRAINT "provider_push_subscriptions_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_vehicle_categories" ADD CONSTRAINT "provider_vehicle_categories_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_year_categories" ADD CONSTRAINT "provider_year_categories_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_governorate_id_governorates_id_fk" FOREIGN KEY ("governorate_id") REFERENCES "public"."governorates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_tow_type_id_tow_types_id_fk" FOREIGN KEY ("tow_type_id") REFERENCES "public"."tow_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_created_by_ops_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."ops_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_origin_governorate_id_governorates_id_fk" FOREIGN KEY ("origin_governorate_id") REFERENCES "public"."governorates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_dest_governorate_id_governorates_id_fk" FOREIGN KEY ("dest_governorate_id") REFERENCES "public"."governorates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_followup_by_ops_users_id_fk" FOREIGN KEY ("followup_by") REFERENCES "public"."ops_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_inspection_governorate_id_governorates_id_fk" FOREIGN KEY ("inspection_governorate_id") REFERENCES "public"."governorates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_inspection_region_id_regions_id_fk" FOREIGN KEY ("inspection_region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_origin_governorate_id_governorates_id_fk" FOREIGN KEY ("origin_governorate_id") REFERENCES "public"."governorates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_dest_governorate_id_governorates_id_fk" FOREIGN KEY ("dest_governorate_id") REFERENCES "public"."governorates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brands_brand_group_idx" ON "brands" USING btree ("brand_group_id");--> statement-breakpoint
CREATE INDEX "regions_governorate_idx" ON "regions" USING btree ("governorate_id");--> statement-breakpoint
CREATE INDEX "audit_log_ops_created_idx" ON "audit_log" USING btree ("ops_user_id","created_at");--> statement-breakpoint
CREATE INDEX "message_templates_updated_by_idx" ON "message_templates" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX "system_config_updated_by_idx" ON "system_config" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX "otp_phone_purpose_expiry_idx" ON "otp_verification_challenges" USING btree ("phone","purpose","expires_at");--> statement-breakpoint
CREATE INDEX "otp_send_outcome_expiry_idx" ON "otp_verification_challenges" USING btree ("send_status","send_attempt_count","expires_at");--> statement-breakpoint
CREATE INDEX "otp_retry_at_idx" ON "otp_verification_challenges" USING btree ("retry_at");--> statement-breakpoint
CREATE INDEX "users_home_governorate_idx" ON "users" USING btree ("home_governorate_id");--> statement-breakpoint
CREATE INDEX "vehicles_user_capabilities_idx" ON "vehicles" USING btree ("user_id","fuel_type_id","year_category","vehicle_category","verification_status");--> statement-breakpoint
CREATE INDEX "vehicles_brand_group_idx" ON "vehicles" USING btree ("brand_group_id");--> statement-breakpoint
CREATE INDEX "vehicles_brand_idx" ON "vehicles" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "vehicles_fuel_type_idx" ON "vehicles" USING btree ("fuel_type_id");--> statement-breakpoint
CREATE INDEX "provider_brand_groups_brand_group_idx" ON "provider_brand_groups" USING btree ("brand_group_id");--> statement-breakpoint
CREATE INDEX "provider_brands_brand_idx" ON "provider_brands" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "provider_coverage_governorate_provider_idx" ON "provider_coverage" USING btree ("governorate_id","provider_id");--> statement-breakpoint
CREATE INDEX "provider_edit_requests_provider_status_created_idx" ON "provider_edit_requests" USING btree ("provider_id","status","created_at");--> statement-breakpoint
CREATE INDEX "provider_edit_requests_reviewed_by_idx" ON "provider_edit_requests" USING btree ("reviewed_by");--> statement-breakpoint
CREATE INDEX "provider_fuel_types_fuel_type_idx" ON "provider_fuel_types" USING btree ("fuel_type_id");--> statement-breakpoint
CREATE INDEX "provider_push_subscriptions_provider_active_idx" ON "provider_push_subscriptions" USING btree ("provider_id","is_active");--> statement-breakpoint
CREATE INDEX "providers_matching_idx" ON "providers" USING btree ("status","service_type","governorate_id","region_id");--> statement-breakpoint
CREATE INDEX "providers_governorate_idx" ON "providers" USING btree ("governorate_id");--> statement-breakpoint
CREATE INDEX "providers_region_idx" ON "providers" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "providers_tow_type_idx" ON "providers" USING btree ("tow_type_id");--> statement-breakpoint
CREATE INDEX "providers_created_by_idx" ON "providers" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "notifications_provider_created_idx" ON "notifications" USING btree ("provider_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_service_request_idx" ON "notifications" USING btree ("service_request_id");--> statement-breakpoint
CREATE INDEX "notifications_followup_created_idx" ON "notifications" USING btree ("followup_status","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_vehicle_idx" ON "notifications" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "notifications_origin_governorate_idx" ON "notifications" USING btree ("origin_governorate_id");--> statement-breakpoint
CREATE INDEX "notifications_dest_governorate_idx" ON "notifications" USING btree ("dest_governorate_id");--> statement-breakpoint
CREATE INDEX "notifications_followup_by_idx" ON "notifications" USING btree ("followup_by");--> statement-breakpoint
CREATE INDEX "service_requests_user_service_created_idx" ON "service_requests" USING btree ("user_id","service_type","created_at");--> statement-breakpoint
CREATE INDEX "service_requests_kpi_idx" ON "service_requests" USING btree ("user_type","matching_status","created_at");--> statement-breakpoint
CREATE INDEX "service_requests_inspection_locality_created_idx" ON "service_requests" USING btree ("inspection_governorate_id","inspection_region_id","created_at");--> statement-breakpoint
CREATE INDEX "service_requests_inspection_region_idx" ON "service_requests" USING btree ("inspection_region_id");--> statement-breakpoint
CREATE INDEX "service_requests_vehicle_idx" ON "service_requests" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "service_requests_origin_governorate_idx" ON "service_requests" USING btree ("origin_governorate_id");--> statement-breakpoint
CREATE INDEX "service_requests_dest_governorate_idx" ON "service_requests" USING btree ("dest_governorate_id");