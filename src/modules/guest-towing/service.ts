import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "../../server/db/client.ts";
import * as s from "../../server/db/schema.ts";
import { openWindow } from "../guest-inspection/availability.ts";
import { listLocalities, type InspectionConnection, type InspectionRuntime } from "../guest-inspection/service.ts";
import { isE164, isUuid } from "../guest-inspection/validation.ts";
import type { TowingProvider, TowingProvidersResult, TowingResult } from "./contracts.ts";
import { objectBody, parseRoute, parseTowing, TowingError } from "./validation.ts";
import { signRequest, verifyRequest } from "./request-proof.ts";

export { listLocalities as listGovernorates };
export type TowingConnection = InspectionConnection;
export type TowingRuntime = InspectionRuntime;

async function validateRoute(connection: TowingConnection, origin: string, dest: string) {
  const rows = await connection.select({ id: s.governorates.id }).from(s.governorates)
    .where(and(inArray(s.governorates.id, [...new Set([origin, dest])]), eq(s.governorates.isActive, true))).for("share");
  const fields: { originGovernorateId?: string; destGovernorateId?: string } = {};
  if (!rows.some((r) => r.id === origin)) fields.originGovernorateId = "اختر محافظة انطلاق متاحة.";
  if (!rows.some((r) => r.id === dest)) fields.destGovernorateId = "اختر محافظة وصول متاحة.";
  if (Object.keys(fields).length) throw new TowingError(422, "المحافظة غير متاحة.", fields);
}

async function contactPhone(connection: TowingConnection) {
  const [config] = await connection.select().from(s.systemConfig).where(eq(s.systemConfig.key, "contact_phone"));
  if (!config) return null;
  if (!isE164(config.value)) throw new TowingError(503, "تعذر تحميل رقم التواصل.");
  return config.value;
}

export function towingOrder(origin: string, dest: string) {
  return [
    sql`case when ${s.providers.governorateId} = ${origin} then 0
      when ${s.providers.governorateId} = ${dest} then 1 else 2 end`,
    sql`random()`,
  ];
}

async function candidates(connection: TowingConnection, origin: string, dest: string, now: Date) {
  const rows = await connection.select({
    id: s.providers.id, businessName: s.providers.businessName, phone: s.providers.phone,
    whatsappNumber: s.providers.whatsappNumber, workDays: s.providers.workDays,
    todayClosed: s.providers.todayClosed, todayClosedDate: s.providers.todayClosedDate, towTypeId: s.providers.towTypeId,
  }).from(s.providers).where(and(eq(s.providers.serviceType, "towing"), eq(s.providers.status, "active")))
    .orderBy(...towingOrder(origin, dest)).for("share");
  const open = rows.filter((row) => openWindow(row, now));
  if (!open.length) return [];
  // Sequential queries: connections can be transaction-pinned pg clients.
  const coverage = await connection.select({
    providerId: s.providerCoverage.providerId, id: s.governorates.id, name: s.governorates.nameAr,
  }).from(s.providerCoverage).innerJoin(s.governorates, eq(s.providerCoverage.governorateId, s.governorates.id))
    .where(inArray(s.providerCoverage.providerId, open.map((p) => p.id))).orderBy(s.governorates.nameAr).for("share");
  const types = await connection.select().from(s.towTypes);
  return open.map((row) => {
    const covered = coverage.filter((c) => c.providerId === row.id).map(({ id, name }) => ({ id, name }));
    return {
      ...row, coverage: covered, towType: types.find((t) => t.id === row.towTypeId)?.nameAr ?? null,
      coversRoute: [origin, dest].every((id) => covered.some((c) => c.id === id)),
    };
  });
}

export async function listTowingProviders(origin: unknown, dest: unknown,
  connection: TowingConnection = getDatabase(), runtime: TowingRuntime = {}): Promise<TowingProvidersResult> {
  const route = parseRoute(origin, dest);
  await validateRoute(connection, route.originGovernorateId, route.destGovernorateId);
  const rows = await candidates(connection, route.originGovernorateId, route.destGovernorateId, (runtime.now ?? (() => new Date()))());
  const card = (p: typeof rows[number]): TowingProvider => ({
    id: p.id, businessName: p.businessName, phone: p.phone, coverage: p.coverage, towType: p.towType,
  });
  return { sectionA: rows.filter((p) => p.coversRoute).map(card),
    sectionB: rows.filter((p) => !p.coversRoute).map(card), contactPhone: await contactPhone(connection) };
}

export function whatsappLink(number: string, text: string) {
  if (!isE164(number)) throw new TowingError(503, "رقم واتساب المزود غير صالح.");
  return `https://wa.me/${number.slice(1)}?text=${encodeURIComponent(text)}`;
}

async function existingRequest(connection: TowingConnection, proof: unknown) {
  const id = verifyRequest(proof);
  const [parent] = await connection.select().from(s.serviceRequests)
    .where(and(eq(s.serviceRequests.id, id), eq(s.serviceRequests.serviceType, "towing"), eq(s.serviceRequests.userType, "guest")))
    .for("update");
  if (!parent || !parent.guestName || !parent.guestPhone) throw new TowingError(403, "تعذر التحقق من الطلب السابق.");
  return parent;
}

export async function notifyTowing(body: unknown, connection: TowingConnection = getDatabase(),
  runtime: TowingRuntime = {}): Promise<TowingResult> {
  const input = parseTowing(body);
  const id = runtime.id ?? randomUUID;
  return connection.transaction(async (tx) => {
    const parent = input.requestProof ? await existingRequest(tx, input.requestProof) : null;
    if (parent && (parent.originGovernorateId !== input.originGovernorateId || parent.destGovernorateId !== input.destGovernorateId
      || parent.guestName !== input.guestName || parent.guestPhone !== input.guestPhone)) {
      throw new TowingError(409, "لا يمكن تغيير مسار أو بيانات الطلب السابق. ابدأ طلباً جديداً.");
    }
    await validateRoute(tx, input.originGovernorateId, input.destGovernorateId);
    const now = (runtime.now ?? (() => new Date()))();
    const rows = await candidates(tx, input.originGovernorateId, input.destGovernorateId, now);
    const provider = rows.find((p) => p.id === input.providerId);
    if (!provider) throw new TowingError(409, "المزود المختار لم يعد متاحاً. حدّث القائمة واختر مجدداً.");
    const requestId = parent?.id ?? id(), notificationId = id();
    // Compute proof/link BEFORE inserts; a missing secret/invalid destination
    // must never leave a committed request with a failed response.
    const requestProof = signRequest(requestId);
    const whatsappUrl = whatsappLink(provider.whatsappNumber,
      `أنا مستخدمك من «Syriacar»، اسمي ${input.guestName}، رقمي ${input.guestPhone}، وأريد سطحة.`);
    const matchingStatus = parent?.matchingStatus === "matched" || provider.coversRoute ? "matched" : "no_match";
    if (!parent) {
      await tx.insert(s.serviceRequests).values({
        id: requestId, serviceType: "towing", userType: "guest", userId: null, vehicleId: null,
        guestName: input.guestName, guestPhone: input.guestPhone,
        originGovernorateId: input.originGovernorateId, destGovernorateId: input.destGovernorateId,
        inspectionGovernorateId: null, inspectionRegionId: null, matchingStatus, createdAt: now,
      });
    } else if (parent.matchingStatus !== matchingStatus) {
      await tx.update(s.serviceRequests).set({ matchingStatus }).where(eq(s.serviceRequests.id, requestId));
    }
    await tx.insert(s.notifications).values({
      id: notificationId, serviceRequestId: requestId, providerId: provider.id,
      serviceType: "towing", userType: "guest", userId: null, vehicleId: null,
      guestName: input.guestName, guestPhone: input.guestPhone,
      originGovernorateId: input.originGovernorateId, destGovernorateId: input.destGovernorateId, createdAt: now,
    });
    return { requestId, requestProof, notificationId, matchingStatus,
      provider: { id: provider.id, businessName: provider.businessName, phone: provider.phone },
      whatsappUrl, delivery: "not_implemented" };
  });
}

/** Manual U-16 fallback only; no GPS, persistence, maps, or new location model. */
export async function prepareLocation(body: unknown, connection: TowingConnection = getDatabase()) {
  const data = objectBody(body, ["requestProof", "notificationId", "governorateId", "regionId"]);
  if (!isUuid(data.notificationId) || !isUuid(data.governorateId) || !isUuid(data.regionId)) {
    throw new TowingError(422, "اختر محافظة ومنطقة للموقع.", { regionId: "اختر منطقة صالحة." });
  }
  return connection.transaction(async (tx) => {
    const parent = await existingRequest(tx, data.requestProof);
    const [notice] = await tx.select({ whatsappNumber: s.providers.whatsappNumber }).from(s.notifications)
      .innerJoin(s.providers, eq(s.notifications.providerId, s.providers.id))
      .where(and(eq(s.notifications.id, (data.notificationId as string).toLowerCase()), eq(s.notifications.serviceRequestId, parent.id)));
    if (!notice) throw new TowingError(403, "الإشعار لا يتبع هذا الطلب.");
    const [locality] = await tx.select({ governorate: s.governorates.nameAr, region: s.regions.nameAr }).from(s.regions)
      .innerJoin(s.governorates, eq(s.regions.governorateId, s.governorates.id))
      .where(and(eq(s.governorates.id, (data.governorateId as string).toLowerCase()), eq(s.regions.id, (data.regionId as string).toLowerCase()),
        eq(s.governorates.isActive, true), eq(s.regions.isActive, true))).for("share");
    if (!locality) throw new TowingError(422, "المنطقة لا تتبع المحافظة المختارة.", { regionId: "اختر منطقة تابعة للمحافظة." });
    return { whatsappUrl: whatsappLink(notice.whatsappNumber,
      `Syriacar — ${parent.guestName} — سطحة — موقعي: محافظة ${locality.governorate}، منطقة ${locality.region}`), delivery: "not_implemented" };
  });
}