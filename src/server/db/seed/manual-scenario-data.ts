import { referenceId } from "./reference-data.ts";

// Public, fictional credentials ONLY. Never use these for a real account.
export const manualTestPassword = "TEST_ONLY_Syriacar_2026!";
export const manualLocality = {
  governorateId: referenceId("governorate/damascus"),
  regionId: referenceId("region/damascus/1"),
};
const baseVehicle = {
  brandGroupId: referenceId("brand-group/korean"),
  brandId: referenceId("brand/korean/1"),
  fuelTypeId: referenceId("fuel/petrol"),
  vehicleCategory: "car" as const, year: 2018, yearCategory: "modern" as const,
  color: "أبيض تجريبي",
};
const cases = [
  { key: "verified", name: "تجريبي — مركبة موثقة", status: "verified" },
  { key: "pending", name: "تجريبي — مركبة بانتظار التوثيق", status: "pending_verification" },
  { key: "rejected", name: "تجريبي — مركبة مرفوضة", status: "rejected" },
  { key: "no-match", name: "تجريبي — فحص بلا مزود مناسب", status: "verified" },
  { key: "towing-home", name: "تجريبي — سطحة من محافظة السكن", status: null },
  { key: "empty", name: "تجريبي — حساب بلا مركبات", status: null },
] as const;

export const manualScenarios = cases.map((item, i) => ({
  key: item.key, id: referenceId(`dev-manual/user/${item.key}`), name: item.name,
  phone: `+96390000770${i + 1}`,
  homeGovernorateId: item.key === "towing-home" ? manualLocality.governorateId : null,
  vehicle: item.status === null ? null : {
    ...baseVehicle, id: referenceId(`dev-manual/vehicle/${item.key}`), verificationStatus: item.status,
    plateNumber: `تجريبي-${i + 1}`, notes: `SYRIACAR_DEV_MANUAL:${item.key}`,
    ...(item.key === "no-match" ? {
      year: 1990, yearCategory: "classic" as const, vehicleCategory: "truck" as const,
      fuelTypeId: referenceId("fuel/diesel"), color: "أزرق تجريبي",
    } : {}),
  },
}));