import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as schema from "../src/server/db/schema.ts";
import { defaultWorkDays } from "../src/server/db/schema/types.ts";

// Independently transcribed from the frozen DBMS v2.2 entity/column inventory.
const contract = {
  users: "id name phone password_hash home_governorate_id is_active is_deleted created_at last_active_at",
  otp_verification_challenges: "id phone purpose code_hash expires_at consumed_at attempt_count max_attempts created_at last_sent_at send_attempt_count send_status delivery_status retry_at send_attempts",
  vehicles: "id user_id brand_group_id brand_id year year_category fuel_type_id vehicle_category plate_number color notes verification_status created_at",
  providers: "id business_name phone whatsapp_number password_hash service_type status governorate_id region_id location_lat location_lng location_url work_days today_closed today_closed_date specializations tow_type_id created_at created_by",
  provider_coverage: "id provider_id governorate_id",
  provider_brands: "provider_id brand_id",
  provider_brand_groups: "provider_id brand_group_id",
  provider_year_categories: "provider_id year_category",
  provider_fuel_types: "provider_id fuel_type_id",
  provider_vehicle_categories: "provider_id vehicle_category",
  provider_push_subscriptions: "id provider_id endpoint p256dh auth created_at last_seen_at expires_at is_active",
  service_requests: "id service_type user_type user_id guest_name guest_phone vehicle_id inspection_governorate_id inspection_region_id origin_governorate_id dest_governorate_id matching_status created_at",
  notifications: "id service_request_id provider_id service_type user_type user_id guest_name guest_phone vehicle_id origin_governorate_id dest_governorate_id followup_status followup_notes followup_by followup_at created_at",
  fuel_types: "id code name_ar display_order is_active",
  tow_types: "id code name_ar display_order is_active",
  brand_groups: "id name_ar display_order is_active",
  brands: "id brand_group_id name_ar display_order is_active",
  governorates: "id name_ar is_active",
  regions: "id governorate_id name_ar is_active",
  ops_users: "id name username password_hash role is_active created_at",
  audit_log: "id ops_user_id action entity_type entity_id old_value new_value created_at",
  provider_edit_requests: "id provider_id field_name requested_value status reviewed_by reviewed_at created_at",
  message_templates: "id key template_ar updated_by updated_at",
  system_config: "key value updated_by updated_at",
};
const tables = Object.values(schema).filter((v) => is(v, PgTable)).map(getTableConfig);
const config = (name) => tables.find((t) => t.name === name);
const column = (table, name) => config(table).columns.find((c) => c.name === name);

test("DBMS v2.2 has exactly the approved 24 entities and 165 columns", () => {
  assert.deepEqual(tables.map((t) => t.name).sort(), Object.keys(contract).sort());
  for (const [name, columns] of Object.entries(contract)) {
    assert.deepEqual(config(name).columns.map((c) => c.name), columns.split(" "), name);
  }
  assert.equal(tables.reduce((n, t) => n + t.columns.length, 0), 165);
});

test("only explicitly specified defaults exist; matching status is mandatory", () => {
  const defaults = {
    users: ["is_active", "is_deleted"],
    otp_verification_challenges: ["attempt_count", "max_attempts", "send_attempt_count", "send_status", "send_attempts"],
    vehicles: ["verification_status"],
    providers: ["status", "work_days", "today_closed"],
    provider_push_subscriptions: ["is_active"],
    notifications: ["followup_status"],
    fuel_types: ["is_active"],
    tow_types: ["is_active"],
    ops_users: ["is_active"],
    provider_edit_requests: ["status"],
  };
  for (const t of tables) {
    assert.deepEqual(t.columns.filter((c) => c.hasDefault).map((c) => c.name), defaults[t.name] ?? [], t.name);
  }
  assert.equal(column("users", "is_active").default, false);
  assert.equal(column("service_requests", "matching_status").default, undefined);
  assert.equal(column("service_requests", "matching_status").notNull, true);
});

test("nullable fields exactly match the frozen DBMS conditional/anonymization rules", () => {
  const nullable = {
    users: ["name", "phone", "home_governorate_id"],
    otp_verification_challenges: ["consumed_at", "delivery_status", "retry_at"],
    vehicles: ["plate_number", "color", "notes"],
    providers: ["location_lat", "location_lng", "location_url", "today_closed_date", "specializations", "tow_type_id"],
    provider_push_subscriptions: ["expires_at"],
    service_requests: ["user_id", "guest_name", "guest_phone", "vehicle_id", "inspection_governorate_id", "inspection_region_id", "origin_governorate_id", "dest_governorate_id"],
    notifications: ["user_id", "guest_name", "guest_phone", "vehicle_id", "origin_governorate_id", "dest_governorate_id", "followup_notes", "followup_by", "followup_at"],
    audit_log: ["old_value", "new_value"],
    provider_edit_requests: ["reviewed_by", "reviewed_at"],
  };
  for (const t of tables) {
    assert.deepEqual(t.columns.filter((c) => !c.notNull).map((c) => c.name), nullable[t.name] ?? [], t.name);
  }
});

test("approved PostgreSQL types are retained without invented sizes or timezone types", () => {
  assert.equal(column("providers", "whatsapp_number").getSQLType(), "varchar(20)");
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.columnType === "PgVarchar" && !(t.name === "providers" && c.name === "whatsapp_number")) {
        assert.equal(c.getSQLType(), "varchar");
      }
      if (c.columnType === "PgTimestamp") assert.equal(c.getSQLType(), "timestamp");
      if (c.columnType === "PgJson") assert.equal(c.getSQLType(), "json");
      if (c.columnType === "PgNumeric") assert.equal(c.getSQLType(), "numeric");
    }
  }
  assert.equal(column("audit_log", "entity_id").getSQLType(), "varchar");
  assert.equal(column("system_config", "key").primary, true);
});

test("five capability junctions retain composite PKs and all 40 FKs are non-cascading", () => {
  for (const name of ["provider_brands", "provider_brand_groups", "provider_year_categories", "provider_fuel_types", "provider_vehicle_categories"]) {
    assert.equal(config(name).primaryKeys.length, 1);
    assert.deepEqual(config(name).primaryKeys[0].columns.map((c) => c.name), contract[name].split(" "));
  }
  assert.equal(tables.reduce((n, t) => n + t.foreignKeys.length, 0), 40);
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      assert.equal(fk.onDelete, "no action");
      assert.equal(fk.onUpdate, "no action");
    }
  }
});

test("OTP is phone-based and hash-only, with separate bounded-send metadata", () => {
  const otp = config("otp_verification_challenges");
  assert.equal(otp.foreignKeys.length, 0);
  assert.equal(column(otp.name, "attempt_count").default, 0);
  assert.equal(column(otp.name, "max_attempts").default, 5);
  assert.equal(column(otp.name, "send_attempt_count").default, 0);
  assert.deepEqual(column(otp.name, "send_status").enumValues, ["pending", "api_accepted", "failed", "unknown"]);
  assert.deepEqual(otp.checks.map((c) => c.name).sort(), [
    "otp_send_attempt_count_check", "otp_send_attempts_length_check",
  ]);
  const indexes = otp.indexes.map((i) => i.config);
  const dialect = new PgDialect();
  for (const i of indexes) {
    assert.equal(i.unique, false);
    if (i.where) assert.doesNotMatch(dialect.sqlToQuery(i.where).sql, /now\s*\(/i);
  }
  assert.ok(indexes.some((i) => i.columns.map((c) => c.name).join() === "retry_at"));
});

test("work_days remains the single schedule source with the specified Friday closure default", () => {
  assert.deepEqual(column("providers", "work_days").default, defaultWorkDays);
  assert.deepEqual(Object.keys(defaultWorkDays), ["sat", "sun", "mon", "tue", "wed", "thu", "fri"]);
  assert.deepEqual(defaultWorkDays.fri, { enabled: false, start: null, end: null });
  for (const day of Object.keys(defaultWorkDays).filter((d) => d !== "fri")) {
    assert.deepEqual(defaultWorkDays[day], { enabled: true, start: "08:00", end: "20:00" });
  }
});

test("request-locality CHECK and non-unique notification parent FK preserve one-to-many history", () => {
  assert.ok(config("service_requests").checks.some((c) => c.name === "service_requests_locality_route_check"));
  const notification = config("notifications");
  const parent = notification.foreignKeys.find((k) => k.reference().columns[0].name === "service_request_id");
  assert.equal(getTableConfig(parent.reference().foreignTable).name, "service_requests");
  assert.equal(column("notifications", "service_request_id").isUnique, false);
  assert.equal(notification.uniqueConstraints.length, 0);
  assert.equal(column("notifications", "matching_status"), undefined);
});

test("forbidden fields/entities and invented bootstrap data are absent from the schema", () => {
  const names = tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]);
  for (const forbidden of ["sessions", "payments", "bookings", "appointments", "reviews", "ratings", "chat", "gps_history", "ops_alerts", "work_start", "work_end", "handled_at", "handled_by", "otp", "code", "message_body"]) {
    // Reference catalog `code` is legitimate; OTP plaintext `code` is not.
    if (forbidden === "code") assert.equal(column("otp_verification_challenges", "code"), undefined);
    else assert.ok(!names.includes(forbidden), forbidden);
  }
  const migration = readFileSync(new URL("../drizzle/0000_database_foundation.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /\bINSERT\s+INTO\b/i, "Bootstrap is deferred; migration is DDL only");
  assert.doesNotMatch(migration, /\bON\s+DELETE\s+(CASCADE|SET NULL)\b/i);
});