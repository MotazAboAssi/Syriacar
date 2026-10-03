import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { applicationRowCounts, tableConfigs, verifyCatalog } from "./catalog.ts";
import { closeDatabase, getDatabase } from "./client.ts";
import * as s from "./schema.ts";
import { defaultWorkDays } from "./schema/types.ts";

nextEnv.loadEnvConfig(process.cwd());

async function verifyBehavior() {
  const db = getDatabase();
  const before = await applicationRowCounts();
  assert.ok(before.every((t) => t.row_count === 0),
    "Build 2 behavioral verification requires an empty application database; it will not touch existing business data");
  const rollback = new Error("ROLLBACK_VERIFICATION");
  let assertions = 0;

  try {
    await db.transaction(async (tx) => {
      const now = new Date();
      const ids = Object.fromEntries(tableConfigs.map((t) => [t.name, randomUUID()]));
      const phone = () => `+9639${randomInt(10_000_000, 100_000_000)}`;
      const hash = "verification_only_hash_not_a_credential";
      const gov = ids.governorates, region = ids.regions, group = ids.brand_groups;
      const brand = ids.brands, fuel = ids.fuel_types, tow = ids.tow_types;
      const ops = ids.ops_users, user = ids.users, vehicle = ids.vehicles, provider = ids.providers;
      const request = ids.service_requests;
      const fixtures: [PgTable, Record<string, unknown>][] = [
        [s.governorates, { id: gov, nameAr: "verification only", isActive: true }],
        [s.regions, { id: region, governorateId: gov, nameAr: "verification only", isActive: true }],
        [s.brandGroups, { id: group, nameAr: "verification only", displayOrder: 1, isActive: true }],
        [s.brands, { id: brand, brandGroupId: group, nameAr: "verification only", displayOrder: 1, isActive: true }],
        [s.fuelTypes, { id: fuel, code: `verify_${fuel}`, nameAr: "verification only", displayOrder: 1 }],
        [s.towTypes, { id: tow, code: `verify_${tow}`, nameAr: "verification only", displayOrder: 1 }],
        [s.opsUsers, { id: ops, name: "verification only", username: `verify_${ops}`, passwordHash: hash, role: "super_admin", createdAt: now }],
        [s.users, { id: user, name: "verification only", phone: phone(), passwordHash: hash, homeGovernorateId: gov, createdAt: now, lastActiveAt: now }],
        [s.vehicles, { id: vehicle, userId: user, brandGroupId: group, brandId: brand, year: now.getUTCFullYear(), yearCategory: "modern", fuelTypeId: fuel, vehicleCategory: "car", createdAt: now }],
        [s.providers, { id: provider, businessName: "verification only", phone: phone(), whatsappNumber: phone(), passwordHash: hash, serviceType: "inspection", governorateId: gov, regionId: region, towTypeId: tow, createdAt: now, createdBy: ops }],
        [s.providerCoverage, { id: ids.provider_coverage, providerId: provider, governorateId: gov }],
        [s.providerBrands, { providerId: provider, brandId: brand }],
        [s.providerBrandGroups, { providerId: provider, brandGroupId: group }],
        [s.providerYearCategories, { providerId: provider, yearCategory: "modern" }],
        [s.providerFuelTypes, { providerId: provider, fuelTypeId: fuel }],
        [s.providerVehicleCategories, { providerId: provider, vehicleCategory: "car" }],
        [s.providerPushSubscriptions, { id: ids.provider_push_subscriptions, providerId: provider, endpoint: `https://example.invalid/${randomUUID()}`, p256dh: "verification only", auth: "verification only", createdAt: now, lastSeenAt: now }],
        [s.providerEditRequests, { id: ids.provider_edit_requests, providerId: provider, fieldName: "coverage", requestedValue: { governorate_ids: [gov] }, createdAt: now }],
        [s.otpVerificationChallenges, { id: ids.otp_verification_challenges, phone: phone(), purpose: "registration", codeHash: hash, expiresAt: new Date(now.getTime() + 600_000), createdAt: now, lastSentAt: now }],
        [s.serviceRequests, { id: request, serviceType: "inspection", userType: "registered", userId: user, vehicleId: vehicle, inspectionGovernorateId: gov, inspectionRegionId: region, matchingStatus: "no_match", createdAt: now }],
        [s.notifications, { id: ids.notifications, serviceRequestId: request, providerId: provider, serviceType: "inspection", userType: "registered", userId: user, vehicleId: vehicle, createdAt: now }],
        [s.messageTemplates, { id: ids.message_templates, key: `verify_${randomUUID()}`, templateAr: "verification only", updatedBy: ops, updatedAt: now }],
        [s.systemConfig, { key: `verify_${randomUUID()}`, value: phone(), updatedBy: ops, updatedAt: now }],
        [s.auditLog, { id: ids.audit_log, opsUserId: ops, action: "verification only", entityType: "system_config", entityId: "contact_phone", createdAt: now }],
      ];
      const samples = new Map<PgTable, Record<string, unknown>>();
      for (const [table, value] of fixtures) {
        const [row] = await tx.insert(table).values(value).returning();
        samples.set(table, row);
      }

      type ConstraintError = { code?: string; constraint?: string; cause?: ConstraintError };
      async function rejected(label: string, code: string, callback: (nested: typeof tx) => Promise<unknown>, constraint?: string) {
        await assert.rejects(
          tx.transaction(callback),
          (error: ConstraintError) => {
            let cause = error;
            while (cause.cause) cause = cause.cause;
            assert.equal(cause.code, code, label);
            if (constraint) assert.equal(cause.constraint, constraint, label);
            return true;
          },
          label,
        );
        assertions++;
      }

      // Exercise all FK and NOT NULL constraints, scoped to uncommitted fixtures.
      for (const config of tableConfigs) {
        const sample = samples.get(config.table)!;
        const keys = getTableColumns(config.table);
        const property = (name: string) => Object.entries(keys).find(([, column]) => column.name === name)![0];
        const pkColumns = config.primaryKeys[0]?.columns ?? config.columns.filter((c) => c.primary);
        const predicate = sql.join(pkColumns.map((c) => sql`${c} = ${sample[property(c.name)]}`), sql` AND `);
        for (const fk of config.foreignKeys) {
          const column = fk.reference().columns[0];
          // Keep the row otherwise valid so a locality CHECK does not mask
          // the intended route-FK violation on the inspection fixture.
          const context = config.table === s.serviceRequests
            && ["origin_governorate_id", "dest_governorate_id"].includes(column.name)
            ? {
              serviceType: "towing", inspectionGovernorateId: null, inspectionRegionId: null,
              originGovernorateId: gov, destGovernorateId: gov,
            }
            : {};
          await rejected(fk.getName(), "23503", (nested) =>
            nested.update(config.table).set({ ...context, [property(column.name)]: randomUUID() }).where(predicate), fk.getName());
        }
        for (const column of config.columns.filter((c) => c.notNull)) {
          await rejected(`${config.name}.${column.name} NOT NULL`, "23502", (nested) =>
            nested.update(config.table).set({ [property(column.name)]: null }).where(predicate));
        }

        const uniqueColumns = config.columns.filter((c) => c.isUnique);
        const changeUnique = (row: Record<string, unknown>, keep: string[] = []) => {
          for (const column of uniqueColumns) {
            if (!keep.includes(column.name)) {
              row[property(column.name)] = column.name.includes("phone") || column.name === "whatsapp_number"
                ? phone() : `verify_${randomUUID()}`;
            }
          }
          return row;
        };
        const pkName = config.primaryKeys[0]?.getName() ?? `${config.name}_pkey`;
        await rejected(pkName, "23505", (nested) =>
          nested.insert(config.table).values(changeUnique({ ...sample }, pkColumns.map((c) => c.name))), pkName);

        const uniqueKeys = [
          ...uniqueColumns.map((c) => ({ name: c.uniqueName!, columns: [c.name] })),
          ...config.uniqueConstraints.map((c) => ({ name: c.getName()!, columns: c.columns.map((c) => c.name) })),
        ];
        for (const unique of uniqueKeys) {
          const row = changeUnique({ ...sample }, unique.columns);
          row.id = randomUUID();
          await rejected(unique.name, "23505", (nested) => nested.insert(config.table).values(row), unique.name);
        }
      }

      const liveUser = samples.get(s.users)!;
      assert.equal(liveUser.isActive, false, "Signup is inactive by default");
      assert.deepEqual(samples.get(s.providers)!.workDays, defaultWorkDays);
      assert.deepEqual(samples.get(s.otpVerificationChallenges)!.sendAttempts, []);
      assert.equal(samples.get(s.otpVerificationChallenges)!.deliveryStatus, null);
      assertions += 4;

      for (const values of [
        { name: null }, { phone: null }, { isDeleted: true },
        { isDeleted: true, name: null, phone: null, isActive: true },
      ]) {
        await rejected("User anonymization", "23514", (nested) =>
          nested.update(s.users).set(values).where(eq(s.users.id, user)), "users_anonymization_check");
      }
      await tx.update(s.users).set({ isDeleted: true, name: null, phone: null, isActive: false }).where(eq(s.users.id, user));
      await tx.insert(s.users).values({ id: randomUUID(), name: null, phone: null, passwordHash: hash, isDeleted: true, createdAt: now, lastActiveAt: now });
      assert.equal((await tx.select().from(s.vehicles).where(eq(s.vehicles.id, vehicle)))[0].userId, user);
      assert.equal((await tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, request)))[0].userId, user);
      assertions += 3;

      for (const count of [-1, 3]) {
        await rejected("OTP bounded sends", "23514", (nested) =>
          nested.update(s.otpVerificationChallenges).set({ sendAttemptCount: count }), "otp_send_attempt_count_check");
      }
      for (const value of [sql`'[{}, {}, {}]'::json`, sql`'{}'::json`, sql`'null'::json`]) {
        await rejected("OTP metadata array length", "23514", (nested) =>
          nested.update(s.otpVerificationChallenges).set({ sendAttempts: value }), "otp_send_attempts_length_check");
      }
      await tx.update(s.otpVerificationChallenges).set({ attemptCount: 4, sendAttemptCount: 2, sendAttempts: [
        { attempt_no: 1, attempted_at: now.toISOString(), api_outcome: "failed", http_status: 503, provider_sent: false, provider_message_id: null, provider_status: null, status_at: null, error_code: "verification", error_reason: null },
        { attempt_no: 2, attempted_at: now.toISOString(), api_outcome: "unknown", http_status: null, provider_sent: null, provider_message_id: null, provider_status: null, status_at: null, error_code: null, error_reason: null },
      ] });
      assert.equal((await tx.select().from(s.otpVerificationChallenges))[0].attemptCount, 4);
      assertions++;

      for (const values of [
        { todayClosed: true, todayClosedDate: null },
        { todayClosed: false, todayClosedDate: "2026-10-04" },
      ]) {
        await rejected("Closure date integrity", "23514", (nested) =>
          nested.update(s.providers).set(values), "providers_today_closed_check");
      }
      await tx.update(s.providers).set({ todayClosed: true, todayClosedDate: now.toISOString().slice(0, 10) });
      for (const year of [1969, now.getUTCFullYear() + 1]) {
        await rejected("Vehicle year range", "23514", (nested) =>
          nested.update(s.vehicles).set({ year }), "vehicles_year_check");
      }
      await tx.update(s.vehicles).set({ year: 1970 });
      await rejected("Provider edit allowlist", "23514", (nested) =>
        nested.update(s.providerEditRequests).set({ fieldName: "password_hash" }), "provider_edit_requests_field_check");

      for (const values of [
        { inspectionGovernorateId: null }, { inspectionRegionId: null },
        { originGovernorateId: gov }, { destGovernorateId: gov }, { vehicleId: null },
      ]) {
        await rejected("Inspection locality/route/vehicle", "23514", (nested) =>
          nested.update(s.serviceRequests).set(values), "service_requests_locality_route_check");
      }
      await rejected("Towing requires both route endpoints", "23514", (nested) =>
        nested.update(s.serviceRequests).set({
          serviceType: "towing", inspectionGovernorateId: null, inspectionRegionId: null, originGovernorateId: gov,
        }), "service_requests_locality_route_check");

      const guestRequest = randomUUID();
      await tx.insert(s.serviceRequests).values({ id: guestRequest, serviceType: "inspection", userType: "guest", guestName: "verification only", guestPhone: phone(), inspectionGovernorateId: gov, inspectionRegionId: region, matchingStatus: "no_match", createdAt: now });
      assert.equal((await tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, guestRequest))).length, 0);
      await tx.insert(s.serviceRequests).values({ id: randomUUID(), serviceType: "towing", userType: "guest", guestName: "verification only", guestPhone: phone(), originGovernorateId: gov, destGovernorateId: gov, matchingStatus: "no_match", createdAt: now });
      await tx.insert(s.notifications).values({
        id: randomUUID(), serviceRequestId: request, providerId: provider,
        serviceType: "inspection", userType: "registered", userId: user,
        vehicleId: vehicle, createdAt: now,
      });
      assert.equal((await tx.select().from(s.notifications).where(eq(s.notifications.serviceRequestId, request))).length, 2);
      assertions += 3;

      // All enum catalogs must reject values outside their declared domains.
      const seenEnums = new Set<string>();
      for (const config of tableConfigs) {
        for (const [property, column] of Object.entries(getTableColumns(config.table))) {
          if (column.enumValues?.length && !seenEnums.has(column.getSQLType())) {
            seenEnums.add(column.getSQLType());
            await rejected(`${config.name}.${column.name} enum`, "22P02", (nested) =>
              nested.update(config.table).set({ [property]: "verification_invalid_enum" }));
          }
        }
      }
      // Roll back the entire verification transaction. Never seed test data.
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  assert.deepEqual(await applicationRowCounts(), before, "Verification must leave every application table unchanged");
  return { behavioralAssertions: assertions, allFixturesRolledBack: true };
}

try {
  const catalog = await verifyCatalog();
  const behavior = await verifyBehavior();
  console.log(JSON.stringify({ status: "passed", catalog, behavior, bootstrap: "deferred_by_user" }, null, 2));
} catch (error) {
  console.error("Database verification failed:", error instanceof assert.AssertionError
    ? error.message : "Database operation failed; sensitive error details withheld.");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}