import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "../../server/db/schema.ts";
import { listProviders, type InspectionConnection as Connection } from "../guest-inspection/service.ts";
import { AccountError, uuid } from "../account/validation.ts";
import { coordinates, type RegisteredProviders } from "./contracts.ts";

export async function ownedVehicle(db: Connection, userId: string, vehicleId: unknown) {
  const [vehicle] = await db.select().from(s.vehicles)
    .where(and(eq(s.vehicles.id, uuid(vehicleId, "vehicleId")), eq(s.vehicles.userId, userId))).for("share");
  if (!vehicle) throw new AccountError(404, "المركبة غير موجودة.");
  if (vehicle.verificationStatus === "rejected") {
    throw new AccountError(422, "لا يمكن استخدام مركبة مرفوضة. عدّل بياناتها أولًا.", {
      fields: { vehicleId: "اختر مركبة غير مرفوضة." },
    });
  }
  return vehicle;
}

/** Capability junction IDs, not display names; an empty dimension never matches. */
export async function inspectionProviders(db: Connection, userId: string, vehicleId: unknown,
  governorateId: unknown, regionId: unknown, now: Date): Promise<RegisteredProviders> {
  const v = await ownedVehicle(db, userId, vehicleId);
  const result = await listProviders(governorateId, regionId, db, { now: () => now });
  const ids = result.providers.map(p => p.id);
  if (!ids.length) return { providers: [], contactPhone: result.contactPhone };
  const groups = await db.select().from(s.providerBrandGroups).where(inArray(s.providerBrandGroups.providerId, ids)).for("share");
  const brands = await db.select().from(s.providerBrands).where(inArray(s.providerBrands.providerId, ids)).for("share");
  const years = await db.select().from(s.providerYearCategories).where(inArray(s.providerYearCategories.providerId, ids)).for("share");
  const fuels = await db.select().from(s.providerFuelTypes).where(inArray(s.providerFuelTypes.providerId, ids)).for("share");
  const categories = await db.select().from(s.providerVehicleCategories)
    .where(inArray(s.providerVehicleCategories.providerId, ids)).for("share");
  const points = await db.select({ id: s.providers.id, lat: s.providers.locationLat, lng: s.providers.locationLng })
    .from(s.providers).where(inArray(s.providers.id, ids)).for("share");
  return {
    contactPhone: result.contactPhone,
    providers: result.providers.map(p => {
      const point = points.find(r => r.id === p.id);
      return { ...p, coordinates: coordinates(point?.lat, point?.lng),
        suitable: groups.some(r => r.providerId === p.id && r.brandGroupId === v.brandGroupId) &&
          brands.some(r => r.providerId === p.id && r.brandId === v.brandId) &&
          years.some(r => r.providerId === p.id && r.yearCategory === v.yearCategory) &&
          fuels.some(r => r.providerId === p.id && r.fuelTypeId === v.fuelTypeId) &&
          categories.some(r => r.providerId === p.id && r.vehicleCategory === v.vehicleCategory),
      };
    }),
  };
}