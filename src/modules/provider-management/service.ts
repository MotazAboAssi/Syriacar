import "server-only";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import * as s from "../../server/db/schema.ts";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import { AccountError, credentials, messages, uuid } from "../account/validation.ts";
import { checkPassword, type AccountRuntime } from "../account/security.ts";
import { accountTransaction, type AccountLimits } from "../account/rate-limits.ts";
import { providerSessionCookie } from "./security.ts";
import type { ProviderNotification, ProviderNotificationPage, ProviderProfile, ProviderReferences } from "./contracts.ts";

export type Provider = typeof s.providers.$inferSelect;
export async function activeProvider(db: Connection, id: string): Promise<Provider> {
  const [provider] = await db.select().from(s.providers).where(eq(s.providers.id, id)).for("share");
  if (!provider || provider.status !== "active") throw new AccountError(403, "حساب المزود غير متاح للدخول.");
  return provider;
}
export async function profile(db: Connection, provider: Provider): Promise<ProviderProfile> {
  const [gov] = await db.select({ name: s.governorates.nameAr }).from(s.governorates)
    .where(eq(s.governorates.id, provider.governorateId));
  const [region] = await db.select({ name: s.regions.nameAr }).from(s.regions)
    .where(eq(s.regions.id, provider.regionId));
  const coverage = await db.select({ name: s.governorates.nameAr }).from(s.providerCoverage)
    .innerJoin(s.governorates, eq(s.providerCoverage.governorateId, s.governorates.id))
    .where(eq(s.providerCoverage.providerId, provider.id)).orderBy(asc(s.governorates.nameAr));
  const tow = provider.towTypeId ? await db.select({ name: s.towTypes.nameAr }).from(s.towTypes)
    .where(eq(s.towTypes.id, provider.towTypeId)) : [];
  return {
    businessName: provider.businessName, phone: provider.phone, serviceType: provider.serviceType, status: "active",
    governorate: gov?.name ?? "غير متاح", region: region?.name ?? "غير متاح",
    towType: provider.serviceType === "towing" ? tow[0]?.name ?? null : null,
    coverage: provider.serviceType === "towing" ? coverage.map(row => row.name) : [],
  };
}
export async function references(db: Connection): Promise<ProviderReferences> {
  // Sequential: db may be a transaction-pinned connection.
  const governorates = await db.select({ id: s.governorates.id, name: s.governorates.nameAr, active: s.governorates.isActive })
    .from(s.governorates).orderBy(asc(s.governorates.nameAr));
  const regions = await db.select({ id: s.regions.id, governorateId: s.regions.governorateId,
    name: s.regions.nameAr, active: s.regions.isActive }).from(s.regions).orderBy(asc(s.regions.nameAr));
  const towTypes = await db.select({ id: s.towTypes.id, name: s.towTypes.nameAr, active: s.towTypes.isActive })
    .from(s.towTypes).orderBy(asc(s.towTypes.displayOrder), asc(s.towTypes.id));
  return { governorates, regions, towTypes };
}
export async function login(input: unknown, db: Connection, runtime: AccountRuntime, limits: AccountLimits) {
  const data = credentials(input);
  // AccountLimits accepts opaque identity strings. Its exact SQL/policy is unchanged.
  const identity = "provider:" + data.phone;
  const result = await accountTransaction(db, async tx => {
    const [provider] = await tx.select().from(s.providers).where(eq(s.providers.phone, data.phone)).for("update");
    const blocked = await limits.checkLogin(tx, identity, runtime);
    if (blocked) return { error: blocked };
    if (!await checkPassword(data.password, provider?.passwordHash) || !provider) {
      const error = await limits.failLogin(tx, identity, runtime) ?? new AccountError(401, messages.invalidLogin);
      await limits.cleanup(tx);
      return { error }; // Commit failed-login accounting before translating to HTTP.
    }
    await limits.successfulLogin(tx, identity, runtime);
    await limits.cleanup(tx);
    if (provider.status !== "active") return { error: new AccountError(403, "حساب المزود غير متاح للدخول.") };
    return { data: await profile(tx, provider), cookie: await providerSessionCookie(provider.id, runtime) };
  });
  if (result.error) throw result.error;
  return { data: result.data!, cookie: result.cookie! };
}

interface Cursor { at: string; id: string }
export interface NotificationQuery { limit: number; cursor: Cursor | null }
export function notificationQuery(url: URL): NotificationQuery {
  if ([...url.searchParams.keys()].some(key => !["limit", "cursor"].includes(key)) ||
    url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1) {
    throw new AccountError(422, "بيانات الصفحة غير صالحة.");
  }
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^\d{1,2}$/.test(rawLimit)) throw new AccountError(422, "حجم الصفحة غير صالح.");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (limit < 1 || limit > 50) throw new AccountError(422, "حجم الصفحة غير صالح.");
  const raw = url.searchParams.get("cursor");
  if (raw === null) return { limit, cursor: null };
  try {
    if (!raw || raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("Invalid cursor");
    const cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(",") !== "at,id" ||
      typeof cursor.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(cursor.at) ||
      new Date(cursor.at.slice(0, 23) + "Z").toISOString().slice(0, 23) !== cursor.at.slice(0, 23)) {
      throw new Error("Invalid cursor");
    }
    return { limit, cursor: { at: cursor.at, id: uuid(cursor.id) } };
  } catch { throw new AccountError(422, "بيانات الصفحة غير صالحة."); }
}
const noticeSelection = {
  id: s.notifications.id,
  // Preserve PostgreSQL microseconds for keyset pagination, not JS's millisecond Date.
  orderAt: sql<string>`to_char(${s.notifications.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
  serviceType: s.notifications.serviceType, customerType: s.notifications.userType,
  guestName: s.notifications.guestName, guestPhone: s.notifications.guestPhone,
  userName: s.users.name, userPhone: s.users.phone, userDeleted: s.users.isDeleted,
  inspectionGovernorateId: s.serviceRequests.inspectionGovernorateId,
  inspectionRegionId: s.serviceRequests.inspectionRegionId,
  originGovernorateId: s.serviceRequests.originGovernorateId,
  destGovernorateId: s.serviceRequests.destGovernorateId,
  brandId: s.vehicles.brandId, year: s.vehicles.year,
  category: s.vehicles.vehicleCategory, fuelTypeId: s.vehicles.fuelTypeId,
};
function noticeQuery(db: Connection) {
  return db.select(noticeSelection).from(s.notifications)
    .innerJoin(s.serviceRequests, eq(s.notifications.serviceRequestId, s.serviceRequests.id))
    .leftJoin(s.users, eq(s.notifications.userId, s.users.id))
    .leftJoin(s.vehicles, eq(s.notifications.vehicleId, s.vehicles.id));
}
type NoticeRow = Awaited<ReturnType<ReturnType<typeof noticeQuery>["execute"]>>[number];
async function noticeDtos(db: Connection, rows: NoticeRow[]): Promise<ProviderNotification[]> {
  if (!rows.length) return [];
  // Reference-only names. Never project provider/customer IDs, plate, color, notes or follow-up data.
  const govs = await db.select({ id: s.governorates.id, name: s.governorates.nameAr }).from(s.governorates);
  const regions = await db.select({ id: s.regions.id, name: s.regions.nameAr }).from(s.regions);
  const brands = await db.select({ id: s.brands.id, name: s.brands.nameAr }).from(s.brands);
  const fuels = await db.select({ id: s.fuelTypes.id, name: s.fuelTypes.nameAr }).from(s.fuelTypes);
  const name = (list: { id: string; name: string }[], id: string | null) => list.find(row => row.id === id)?.name ?? null;
  return rows.map(row => ({
    id: row.id, createdAt: row.orderAt + "Z", serviceType: row.serviceType, customerType: row.customerType,
    customerName: row.customerType === "guest" ? row.guestName : row.userDeleted ? null : row.userName,
    customerPhone: row.customerType === "guest" ? row.guestPhone : row.userDeleted ? null : row.userPhone,
    context: {
      governorate: name(govs, row.inspectionGovernorateId), region: name(regions, row.inspectionRegionId),
      origin: name(govs, row.originGovernorateId), destination: name(govs, row.destGovernorateId),
      vehicle: row.year !== null && row.category !== null ? {
        brand: name(brands, row.brandId), year: row.year, category: row.category, fuel: name(fuels, row.fuelTypeId),
      } : null,
    },
  }));
}
export async function notifications(db: Connection, providerId: string, query: NotificationQuery): Promise<ProviderNotificationPage> {
  const after = query.cursor ? or(lt(s.notifications.createdAt, sql`${query.cursor.at}::timestamp`),
    and(eq(s.notifications.createdAt, sql`${query.cursor.at}::timestamp`), lt(s.notifications.id, query.cursor.id))) : undefined;
  const rows = await noticeQuery(db).where(and(eq(s.notifications.providerId, providerId), after))
    .orderBy(desc(s.notifications.createdAt), desc(s.notifications.id)).limit(query.limit + 1);
  const page = rows.slice(0, query.limit), last = page.at(-1);
  return { items: await noticeDtos(db, page), nextCursor: rows.length > query.limit && last
    ? Buffer.from(JSON.stringify({ at: last.orderAt, id: last.id })).toString("base64url") : null };
}
export async function notification(db: Connection, providerId: string, id: string): Promise<ProviderNotification> {
  const rows = await noticeQuery(db).where(and(eq(s.notifications.providerId, providerId), eq(s.notifications.id, id))).limit(1);
  if (!rows.length) throw new AccountError(404, "الإشعار غير موجود.");
  return (await noticeDtos(db, rows))[0];
}