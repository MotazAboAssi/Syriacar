import { referenceId } from "./reference-data.ts";
import { manualLocality, manualScenarios } from "./manual-scenario-data.ts";
import type { WorkDays } from "../schema/types.ts";

export const providerFixtureOwner = {
  id: referenceId("dev-provider-fixtures/owner"),
  name: "تجريبي — منشئ مزودي الاختبار المعطّل",
  username: "__dev_provider_fixture_owner__",
  role: "operations" as const, isActive: false,
};
export const providerFixtureRoutes = {
  originGovernorateId: manualLocality.governorateId,
  destGovernorateId: referenceId("governorate/rural-damascus"),
  bOnlyDestinationId: referenceId("governorate/aleppo"),
};
export const providerFixtureVehicle = manualScenarios.find(s => s.key === "verified")!.vehicle!;
export const providerFixtureWorkDays: WorkDays = {
  sat: { enabled: true, start: "00:00", end: "23:59" },
  sun: { enabled: true, start: "00:00", end: "23:59" },
  mon: { enabled: true, start: "00:00", end: "23:59" },
  tue: { enabled: true, start: "00:00", end: "23:59" },
  wed: { enabled: true, start: "00:00", end: "23:59" },
  thu: { enabled: true, start: "00:00", end: "23:59" },
  fri: { enabled: true, start: "00:00", end: "23:59" },
};
// NANP 555-01xx fictional/example range, not Syrian or real provider data.
// Links may be prepared by existing flows; never open/send to them in tests.
const definitions = [
  { key: "inspection-map", businessName: "تجريبي فقط — فحص مناسب على الخريطة",
    serviceType: "inspection", coordinates: ["33.513800", "36.276500"], capabilities: "matching", coverage: ["damascus"] },
  { key: "inspection-list", businessName: "تجريبي فقط — فحص مناسب في القائمة",
    serviceType: "inspection", coordinates: null, capabilities: "matching", coverage: ["damascus"] },
  { key: "inspection-incompatible", businessName: "تجريبي فقط — فحص غير متوافق بالوقود",
    serviceType: "inspection", coordinates: ["33.505000", "36.300000"], capabilities: "electric", coverage: ["damascus"] },
  { key: "towing-a-map", businessName: "تجريبي فقط — سطحة A على الخريطة",
    serviceType: "towing", coordinates: ["33.510000", "36.290000"], capabilities: null, coverage: ["damascus", "rural-damascus"] },
  { key: "towing-a-second", businessName: "تجريبي فقط — سطحة A ثانية",
    serviceType: "towing", coordinates: ["33.571000", "36.400000"], capabilities: null, coverage: ["damascus", "rural-damascus"] },
  { key: "towing-b-map", businessName: "تجريبي فقط — سطحة B تغطي دمشق فقط",
    serviceType: "towing", coordinates: ["33.500000", "36.320000"], capabilities: null, coverage: ["damascus"] },
] as const;

export const providerFixtures = definitions.map((d, i) => ({
  key: d.key,
  provider: {
    id: referenceId(`dev-provider-fixtures/provider/${d.key}`),
    businessName: d.businessName,
    phone: `+1202555011${i + 1}`, whatsappNumber: `+1202555012${i + 1}`,
    serviceType: d.serviceType, status: "active" as const,
    governorateId: i === 4 ? providerFixtureRoutes.destGovernorateId : manualLocality.governorateId,
    regionId: i === 4 ? referenceId("region/rural-damascus/1") : manualLocality.regionId,
    locationLat: d.coordinates?.[0] ?? null, locationLng: d.coordinates?.[1] ?? null,
    locationUrl: null, workDays: providerFixtureWorkDays, todayClosed: false, todayClosedDate: null,
    specializations: ["بيانات اختبار وهمية فقط — لا تراسل هذا الرقم"],
    towTypeId: d.serviceType === "towing" ? referenceId(`tow/${i === 4 ? "ordinary" : "hydraulic"}`) : null,
    createdBy: providerFixtureOwner.id,
  },
  coverage: d.coverage.map(g => ({
    id: referenceId(`dev-provider-fixtures/coverage/${d.key}/${g}`),
    providerId: referenceId(`dev-provider-fixtures/provider/${d.key}`),
    governorateId: referenceId(`governorate/${g}`),
  })),
  capabilities: d.capabilities ? {
    brandGroupId: providerFixtureVehicle.brandGroupId, brandId: providerFixtureVehicle.brandId,
    yearCategory: providerFixtureVehicle.yearCategory, vehicleCategory: providerFixtureVehicle.vehicleCategory,
    fuelTypeId: d.capabilities === "electric" ? referenceId("fuel/electric") : providerFixtureVehicle.fuelTypeId,
  } : null,
}));