import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import * as s from "../../server/db/schema.ts";
import type { AccountReferences, Vehicle, VehicleInput } from "./contracts.ts";
import { AccountError, uuid, vehicleInput } from "./validation.ts";
import { now, type AccountRuntime } from "./security.ts";

export async function references(db: Connection): Promise<AccountReferences> {
  const governorates = await db.select({ id: s.governorates.id, nameAr: s.governorates.nameAr }).from(s.governorates)
    .where(eq(s.governorates.isActive, true)).orderBy(asc(s.governorates.nameAr));
  const brandGroups = await db.select({ id: s.brandGroups.id, nameAr: s.brandGroups.nameAr }).from(s.brandGroups)
    .where(eq(s.brandGroups.isActive, true)).orderBy(asc(s.brandGroups.displayOrder));
  const brands = await db.select({ id: s.brands.id, nameAr: s.brands.nameAr, brandGroupId: s.brands.brandGroupId })
    .from(s.brands).innerJoin(s.brandGroups, eq(s.brandGroups.id, s.brands.brandGroupId))
    .where(and(eq(s.brands.isActive, true), eq(s.brandGroups.isActive, true))).orderBy(asc(s.brands.displayOrder));
  const fuelTypes = await db.select({ id: s.fuelTypes.id, nameAr: s.fuelTypes.nameAr }).from(s.fuelTypes)
    .where(eq(s.fuelTypes.isActive, true)).orderBy(asc(s.fuelTypes.displayOrder));
  return { governorates, brandGroups, brands, fuelTypes };
}
async function validateReferences(db: Connection, input: VehicleInput) {
  const [brand] = await db.select({ id: s.brands.id }).from(s.brands)
    .innerJoin(s.brandGroups, eq(s.brands.brandGroupId, s.brandGroups.id))
    .where(and(eq(s.brands.id, input.brandId), eq(s.brands.brandGroupId, input.brandGroupId),
      eq(s.brands.isActive, true), eq(s.brandGroups.isActive, true))).for("share");
  const [fuel] = await db.select({ id: s.fuelTypes.id }).from(s.fuelTypes)
    .where(and(eq(s.fuelTypes.id, input.fuelTypeId), eq(s.fuelTypes.isActive, true))).for("share");
  const fields: Record<string, string> = {};
  if (!brand) fields.brandId = "اختر ماركة فعّالة تتبع المجموعة المختارة.";
  if (!fuel) fields.fuelTypeId = "اختر نظام طاقة متاحاً.";
  if (Object.keys(fields).length) throw new AccountError(422, "تحقق من بيانات المركبة.", { fields });
}
export function derivedYear(year: number): "classic" | "mid" | "modern" {
  return year <= 1999 ? "classic" : year <= 2011 ? "mid" : "modern";
}
export async function listVehicles(db: Connection, userId: string, id?: string): Promise<Vehicle[]> {
  const rows = await db.select({
    id: s.vehicles.id, brandGroupId: s.vehicles.brandGroupId, brandId: s.vehicles.brandId, year: s.vehicles.year,
    fuelTypeId: s.vehicles.fuelTypeId, vehicleCategory: s.vehicles.vehicleCategory,
    plateNumber: s.vehicles.plateNumber, color: s.vehicles.color, notes: s.vehicles.notes,
    brandGroupName: s.brandGroups.nameAr, brandName: s.brands.nameAr, fuelTypeName: s.fuelTypes.nameAr,
    status: s.vehicles.verificationStatus,
  }).from(s.vehicles).innerJoin(s.brandGroups, eq(s.brandGroups.id, s.vehicles.brandGroupId))
    .innerJoin(s.brands, eq(s.brands.id, s.vehicles.brandId))
    .innerJoin(s.fuelTypes, eq(s.fuelTypes.id, s.vehicles.fuelTypeId))
    .where(and(eq(s.vehicles.userId, userId), ...(id ? [eq(s.vehicles.id, uuid(id))] : [])))
    .orderBy(asc(s.vehicles.createdAt), asc(s.vehicles.id));
  if (id && !rows.length) throw new AccountError(404, "المركبة غير موجودة.");
  return rows.map(({ status, ...row }) => ({ ...row, rejected: status === "rejected" }));
}
export async function writeVehicle(db: Connection, userId: string, input: unknown, runtime: AccountRuntime, id?: string) {
  const data = vehicleInput(input, now(runtime).getUTCFullYear());
  const vehicleId = id ? uuid(id) : randomUUID();
  let previous: typeof s.vehicles.$inferSelect | undefined;
  if (id) {
    [previous] = await db.select().from(s.vehicles)
      .where(and(eq(s.vehicles.id, vehicleId), eq(s.vehicles.userId, userId))).for("update");
    if (!previous) throw new AccountError(404, "المركبة غير موجودة.");
  }
  await validateReferences(db, data);
  if (!previous) {
    await db.insert(s.vehicles).values({ id: vehicleId, userId, ...data, yearCategory: derivedYear(data.year),
      verificationStatus: "pending_verification", createdAt: now(runtime) });
  } else {
    const coreChanged = (["brandGroupId", "brandId", "year", "plateNumber"] as const)
      .some((key) => previous![key] !== data[key]);
    const anyChanged = (Object.keys(data) as (keyof VehicleInput)[]).some((key) => previous![key] !== data[key]);
    await db.update(s.vehicles).set({ ...data, yearCategory: derivedYear(data.year),
      ...(coreChanged || (previous.verificationStatus === "rejected" && anyChanged)
        ? { verificationStatus: "pending_verification" as const } : {}),
    }).where(and(eq(s.vehicles.id, vehicleId), eq(s.vehicles.userId, userId)));
  }
  return (await listVehicles(db, userId, vehicleId))[0];
}