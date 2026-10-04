import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDatabase } from "../../server/db/client.ts";
import * as s from "../../server/db/schema.ts";
import type { GuestInspectionResult, InspectionProvider, LocalitiesResult, ProvidersResult } from "./contracts.ts";
import { openWindow } from "./availability.ts";
import { InspectionError, isE164, isUuid, parseGuestInspection, parseLocality } from "./validation.ts";
import { GuestLimits, guestTransaction, type GuestQuotaRuntime } from "../guest-security/rate-limits.ts";

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type InspectionConnection = Database | Transaction;
export interface InspectionRuntime extends GuestQuotaRuntime { now?: () => Date; id?: () => string }

async function validateLocality(connection: InspectionConnection, governorateId: string, regionId: string) {
  const [row] = await connection.select({ id: s.regions.id }).from(s.regions)
    .innerJoin(s.governorates, eq(s.regions.governorateId, s.governorates.id))
    .where(and(eq(s.governorates.id, governorateId), eq(s.regions.id, regionId),
      eq(s.governorates.isActive, true), eq(s.regions.isActive, true)))
    .for("share");
  if (!row) throw new InspectionError(422, "المنطقة لا تتبع المحافظة المختارة أو لم تعد متاحة.",
    { regionId: "اختر منطقة متاحة تابعة للمحافظة." });
}

async function readContactPhone(connection: InspectionConnection) {
  const [row] = await connection.select({ value: s.systemConfig.value }).from(s.systemConfig)
    .where(eq(s.systemConfig.key, "contact_phone"));
  if (!row) return null; // Owner approved no contact suffix until configured.
  if (!isE164(row.value)) throw new InspectionError(503, "تعذّر تحميل بيانات التواصل. حاول مجدداً.");
  return row.value;
}

async function candidateRows(connection: InspectionConnection, governorateId: string, regionId: string) {
  // The guest has no saved vehicle: capabilities are display-only, never filters.
  return connection.select({
    id: s.providers.id, businessName: s.providers.businessName, phone: s.providers.phone,
    regionName: s.regions.nameAr, workDays: s.providers.workDays,
    todayClosed: s.providers.todayClosed, todayClosedDate: s.providers.todayClosedDate,
    specializations: s.providers.specializations,
  }).from(s.providers).innerJoin(s.regions, eq(s.providers.regionId, s.regions.id))
    .where(and(eq(s.providers.serviceType, "inspection"), eq(s.providers.status, "active"),
      eq(s.providers.governorateId, governorateId), eq(s.providers.regionId, regionId)))
    .orderBy(s.providers.id).for("share");
}

export async function listLocalities(governorateId: string | null, connection: InspectionConnection = getDatabase()): Promise<LocalitiesResult> {
  if (governorateId !== null && !isUuid(governorateId)) {
    throw new InspectionError(422, "اختر المحافظة.", { governorateId: "اختر محافظة صالحة." });
  }
  const governorates = await connection.select({ id: s.governorates.id, name: s.governorates.nameAr })
    .from(s.governorates).where(eq(s.governorates.isActive, true)).orderBy(s.governorates.nameAr);
  if (governorateId === null) return { governorates, regions: [] };
  const id = governorateId.toLowerCase();
  if (!governorates.some((g) => g.id === id)) {
    throw new InspectionError(422, "المحافظة لم تعد متاحة.", { governorateId: "اختر محافظة متاحة." });
  }
  const regions = await connection.select({ id: s.regions.id, name: s.regions.nameAr })
    .from(s.regions).where(and(eq(s.regions.governorateId, id), eq(s.regions.isActive, true)))
    .orderBy(s.regions.nameAr);
  return { governorates, regions };
}

export async function listProviders(
  governorateId: unknown, regionId: unknown, connection: InspectionConnection = getDatabase(),
  runtime: InspectionRuntime = {},
): Promise<ProvidersResult> {
  const locality = parseLocality(governorateId, regionId);
  await validateLocality(connection, locality.governorateId, locality.regionId);
  const rows = await candidateRows(connection, locality.governorateId, locality.regionId);
  const now = (runtime.now ?? (() => new Date()))();
  const providers: InspectionProvider[] = rows.flatMap((row) => {
    const hours = openWindow(row, now);
    return hours ? [{
      id: row.id, businessName: row.businessName, regionName: row.regionName, phone: row.phone,
      hours, specializations: row.specializations, brandGroups: [], brands: [],
      yearCategories: [], fuelTypes: [], vehicleCategories: [],
    }] : [];
  });
  if (providers.length) {
    const ids = providers.map((p) => p.id);
    // A transaction pins one pg client. Keep queries sequential there (pg 9
    // will no longer support concurrent queries on an executing client).
    const [groups, brands, years, fuels, vehicles] = [
      await connection.select({ providerId: s.providerBrandGroups.providerId, value: s.brandGroups.nameAr })
        .from(s.providerBrandGroups).innerJoin(s.brandGroups, eq(s.providerBrandGroups.brandGroupId, s.brandGroups.id))
        .where(inArray(s.providerBrandGroups.providerId, ids)).orderBy(s.brandGroups.displayOrder),
      await connection.select({ providerId: s.providerBrands.providerId, value: s.brands.nameAr })
        .from(s.providerBrands).innerJoin(s.brands, eq(s.providerBrands.brandId, s.brands.id))
        .innerJoin(s.brandGroups, eq(s.brands.brandGroupId, s.brandGroups.id))
        .where(inArray(s.providerBrands.providerId, ids)).orderBy(s.brandGroups.displayOrder, s.brands.displayOrder),
      await connection.select({ providerId: s.providerYearCategories.providerId, value: s.providerYearCategories.yearCategory })
        .from(s.providerYearCategories).where(inArray(s.providerYearCategories.providerId, ids)),
      await connection.select({ providerId: s.providerFuelTypes.providerId, value: s.fuelTypes.nameAr })
        .from(s.providerFuelTypes).innerJoin(s.fuelTypes, eq(s.providerFuelTypes.fuelTypeId, s.fuelTypes.id))
        .where(inArray(s.providerFuelTypes.providerId, ids)).orderBy(s.fuelTypes.displayOrder),
      await connection.select({ providerId: s.providerVehicleCategories.providerId, value: s.providerVehicleCategories.vehicleCategory })
        .from(s.providerVehicleCategories).where(inArray(s.providerVehicleCategories.providerId, ids)),
    ] as const;
    for (const p of providers) {
      p.brandGroups = groups.filter((r) => r.providerId === p.id).map((r) => r.value);
      p.brands = brands.filter((r) => r.providerId === p.id).map((r) => r.value);
      p.yearCategories = years.filter((r) => r.providerId === p.id).map((r) => r.value);
      p.fuelTypes = fuels.filter((r) => r.providerId === p.id).map((r) => r.value);
      p.vehicleCategories = vehicles.filter((r) => r.providerId === p.id).map((r) => r.value);
    }
  }
  return { providers, contactPhone: await readContactPhone(connection) };
}

/** First explicit confirmation only. No writes happen while browsing results. */
export async function createGuestInspection(
  body: unknown, connection: InspectionConnection = getDatabase(), runtime: InspectionRuntime = {},
): Promise<GuestInspectionResult> {
  const input = parseGuestInspection(body);
  const id = runtime.id ?? randomUUID;
  const limits = new GuestLimits();
  return guestTransaction(connection, async (tx) => {
    await validateLocality(tx, input.governorateId, input.regionId);
    // Share locks keep existing provider status/locality/schedule stable during
    // confirmation. History stores the match at creation, not later reclassification.
    const rows = await candidateRows(tx, input.governorateId, input.regionId);
    const now = (runtime.now ?? (() => new Date()))();
    const matching = rows.filter((p) => openWindow(p, now) !== null);
    const provider = matching.find((p) => p.id === input.providerId);
    if (input.providerId !== null && !provider) {
      throw new InspectionError(409, "المزود المختار لم يعد متاحاً. حدّث القائمة واختر مجدداً.");
    }
    if (input.providerId === null && matching.length > 0) {
      throw new InspectionError(409, "يوجد مزود متاح الآن. حدّث القائمة واختر مزوداً قبل التأكيد.");
    }
    const contactPhone = await readContactPhone(tx);
    const requestId = id(), notificationId = provider ? id() : null;
    const matchingStatus = provider ? "matched" : "no_match";
    await limits.admit(tx, input.guestPhone, true, !!provider, runtime);
    await tx.insert(s.serviceRequests).values({
      id: requestId, serviceType: "inspection", userType: "guest",
      userId: null, vehicleId: null, guestName: input.guestName, guestPhone: input.guestPhone,
      inspectionGovernorateId: input.governorateId, inspectionRegionId: input.regionId,
      originGovernorateId: null, destGovernorateId: null, matchingStatus, createdAt: now,
    });
    if (provider && notificationId) {
      await tx.insert(s.notifications).values({
        id: notificationId, serviceRequestId: requestId, providerId: provider.id,
        serviceType: "inspection", userType: "guest", userId: null, vehicleId: null,
        guestName: input.guestName, guestPhone: input.guestPhone,
        originGovernorateId: null, destGovernorateId: null, createdAt: now,
      });
    }
    await limits.cleanup(tx);
    return {
      requestId, notificationId, matchingStatus, contactPhone,
      provider: provider ? { id: provider.id, businessName: provider.businessName, phone: provider.phone } : null,
      delivery: "not_implemented",
    };
  });
}