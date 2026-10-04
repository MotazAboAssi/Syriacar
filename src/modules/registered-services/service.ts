import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as s from "../../server/db/schema.ts";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import { listLocalities } from "../guest-inspection/service.ts";
import { listTowingProviders, whatsappLink } from "../guest-towing/service.ts";
import { AccountError, object, uuid } from "../account/validation.ts";
import type { User } from "../account/service.ts";
import { inspectionProviders, ownedVehicle } from "./inspection.ts";
import type { Confirmation } from "./contracts.ts";

async function parentRequest(db: Connection, userId: string, service: "inspection" | "towing", id: unknown) {
  const [parent] = await db.select().from(s.serviceRequests).where(and(
    eq(s.serviceRequests.id, uuid(id, "requestId")), eq(s.serviceRequests.userId, userId),
    eq(s.serviceRequests.userType, "registered"), eq(s.serviceRequests.serviceType, service),
  )).for("update");
  if (!parent) throw new AccountError(403, "غير مصرح لك بهذا الطلب.");
  return parent;
}
function input(body: unknown, service: "inspection" | "towing") {
  const data = object(body, service === "inspection"
    ? ["vehicleId", "governorateId", "regionId", "providerId", "acceptedTerms", "requestId"]
    : ["originGovernorateId", "destGovernorateId", "providerId", "acceptedTerms", "requestId"]);
  if (data.acceptedTerms !== true) throw new AccountError(422, "يجب الموافقة على شروط الاستخدام.", {
    fields: { acceptedTerms: "وافق على شروط الاستخدام." },
  });
  return {
    vehicleId: service === "inspection" ? uuid(data.vehicleId, "vehicleId") : null,
    inspectionGovernorateId: service === "inspection" ? uuid(data.governorateId, "governorateId") : null,
    inspectionRegionId: service === "inspection" ? uuid(data.regionId, "regionId") : null,
    originGovernorateId: service === "towing" ? uuid(data.originGovernorateId, "originGovernorateId") : null,
    destGovernorateId: service === "towing" ? uuid(data.destGovernorateId, "destGovernorateId") : null,
    providerId: service === "inspection" && data.providerId === null ? null : uuid(data.providerId, "providerId"),
    requestId: data.requestId === undefined ? null : uuid(data.requestId, "requestId"),
  };
}

/** Caller holds authenticated-user lock in one transaction; all writes are atomic. */
export async function confirm(db: Connection, user: User, body: unknown,
  service: "inspection" | "towing", time: Date): Promise<Confirmation> {
  const data = input(body, service);
  const parent = data.requestId ? await parentRequest(db, user.id, service, data.requestId) : null;
  const context = {
    vehicleId: data.vehicleId, inspectionGovernorateId: data.inspectionGovernorateId,
    inspectionRegionId: data.inspectionRegionId, originGovernorateId: data.originGovernorateId,
    destGovernorateId: data.destGovernorateId,
  };
  if (parent && (Object.keys(context) as (keyof typeof context)[]).some(key => parent[key] !== context[key])) {
    throw new AccountError(409, "لا يمكن تغيير سياق الطلب السابق. ابدأ طلبًا جديدًا.");
  }
  let provider: { id: string; businessName: string; phone: string } | null = null;
  let contactPhone: string | null = null;
  let matched = false;
  let message = "";
  if (service === "inspection") {
    const v = await ownedVehicle(db, user.id, data.vehicleId);
    const results = await inspectionProviders(db, user.id, data.vehicleId,
      data.inspectionGovernorateId, data.inspectionRegionId, time);
    contactPhone = results.contactPhone;
    provider = results.providers.find(p => p.id === data.providerId && p.suitable) ?? null;
    if (data.providerId && !provider) throw new AccountError(409, "المزود لم يعد مناسبًا أو متاحًا. حدّث النتائج.");
    if (!data.providerId && results.providers.some(p => p.suitable)) {
      throw new AccountError(409, "يوجد مزود مناسب الآن. حدّث النتائج.");
    }
    matched = !!provider;
    const [brand] = await db.select({ name: s.brands.nameAr }).from(s.brands).where(eq(s.brands.id, v.brandId));
    message = `أنا مستخدمك من «Syriacar»، اسمي ${user.name}، وأريد فحصاً لسيارة ${brand.name} - ${v.year}.`;
  } else {
    const results = await listTowingProviders(data.originGovernorateId, data.destGovernorateId, db, { now: () => time });
    provider = [...results.sectionA, ...results.sectionB].find(p => p.id === data.providerId) ?? null;
    if (!provider) throw new AccountError(409, "المزود لم يعد متاحًا. حدّث النتائج.");
    matched = results.sectionA.some(p => p.id === provider!.id);
    contactPhone = results.contactPhone;
    message = `أنا مستخدمك من «Syriacar»، اسمي ${user.name}، وأريد سطحة.`;
  }
  let whatsappUrl: string | null = null;
  if (provider) {
    const [row] = await db.select({ number: s.providers.whatsappNumber }).from(s.providers)
      .where(eq(s.providers.id, provider.id)).for("share");
    whatsappUrl = whatsappLink(row.number, message);
  }
  const matchingStatus = parent?.matchingStatus === "matched" || matched ? "matched" : "no_match";
  const requestId = parent?.id ?? randomUUID(), notificationId = provider ? randomUUID() : null;
  const identity = { userType: "registered" as const, userId: user.id, guestName: null, guestPhone: null };
  if (!parent) await db.insert(s.serviceRequests).values({
    id: requestId, serviceType: service, ...identity, ...context, matchingStatus, createdAt: time,
  });
  else if (matchingStatus !== parent.matchingStatus) {
    await db.update(s.serviceRequests).set({ matchingStatus }).where(eq(s.serviceRequests.id, parent.id));
  }
  if (provider && notificationId) await db.insert(s.notifications).values({
    id: notificationId, serviceRequestId: requestId, providerId: provider.id,
    serviceType: service, ...identity, vehicleId: data.vehicleId,
    originGovernorateId: data.originGovernorateId, destGovernorateId: data.destGovernorateId, createdAt: time,
  });
  return { requestId, notificationId, matchingStatus, contactPhone, whatsappUrl,
    provider: provider ? { id: provider.id, businessName: provider.businessName, phone: provider.phone } : null,
    delivery: "not_implemented" };
}

/** Only manual locality crosses the network. No request/notification/location writes. */
export async function location(db: Connection, user: User, body: unknown) {
  const data = object(body, ["requestId", "notificationId", "governorateId", "regionId"]);
  const parent = await parentRequest(db, user.id, "towing", data.requestId);
  const [notice] = await db.select({ number: s.providers.whatsappNumber }).from(s.notifications)
    .innerJoin(s.providers, eq(s.providers.id, s.notifications.providerId))
    .where(and(eq(s.notifications.id, uuid(data.notificationId, "notificationId")),
      eq(s.notifications.serviceRequestId, parent.id), eq(s.notifications.userId, user.id),
      eq(s.notifications.userType, "registered"), eq(s.notifications.serviceType, "towing")));
  if (!notice) throw new AccountError(403, "الإشعار لا يتبع هذا الطلب.");
  const governorateId = uuid(data.governorateId, "governorateId"), regionId = uuid(data.regionId, "regionId");
  const refs = await listLocalities(governorateId, db);
  if (!refs.regions.some(r => r.id === regionId)) throw new AccountError(422, "اختر منطقة تابعة للمحافظة.", {
    fields: { regionId: "اختر منطقة تابعة للمحافظة." },
  });
  const [locality] = await db.select({ governorate: s.governorates.nameAr, region: s.regions.nameAr })
    .from(s.regions).innerJoin(s.governorates, eq(s.governorates.id, s.regions.governorateId))
    .where(and(eq(s.regions.id, regionId), eq(s.governorates.id, governorateId),
      eq(s.regions.isActive, true), eq(s.governorates.isActive, true))).for("share");
  if (!locality) throw new AccountError(422, "الموقع لم يعد متاحًا.");
  return { whatsappUrl: whatsappLink(notice.number,
    `Syriacar — ${user.name} — سطحة — موقعي: محافظة ${locality.governorate}، منطقة ${locality.region}`),
    delivery: "not_implemented" };
}