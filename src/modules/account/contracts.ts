export interface ApiError {
  error: string;
  fields?: Record<string, string>;
  code?: "inactive" | "otp_invalid";
  otp?: OtpState;
}
export interface OtpState {
  phone: string;
  expiresAt: string;
  resendAt: string;
  canResend: boolean;
  sendStatus: "pending" | "api_accepted" | "failed" | "unknown";
  deliveryStatus: string | null;
}
export interface Profile {
  name: string;
  phone: string;
  homeGovernorateId: string | null;
}
export interface ReferenceItem { id: string; nameAr: string }
export interface AccountReferences {
  governorates: ReferenceItem[];
  brandGroups: ReferenceItem[];
  brands: (ReferenceItem & { brandGroupId: string })[];
  fuelTypes: ReferenceItem[];
}
export interface VehicleInput {
  brandGroupId: string;
  brandId: string;
  year: number;
  fuelTypeId: string;
  vehicleCategory: "car" | "truck";
  plateNumber: string | null;
  color: string | null;
  notes: string | null;
}
export interface Vehicle extends VehicleInput {
  id: string;
  brandGroupName: string;
  brandName: string;
  fuelTypeName: string;
  rejected: boolean;
}