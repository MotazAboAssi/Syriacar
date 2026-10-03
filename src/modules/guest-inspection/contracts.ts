export interface LocalityOption { id: string; name: string }
export interface LocalitiesResult {
  governorates: LocalityOption[];
  regions: LocalityOption[];
}

export interface InspectionProvider {
  id: string;
  businessName: string;
  regionName: string;
  phone: string;
  hours: { start: string; end: string };
  brandGroups: string[];
  brands: string[];
  yearCategories: ("classic" | "mid" | "modern")[];
  fuelTypes: string[];
  vehicleCategories: ("car" | "truck")[];
  specializations: unknown;
}

export interface ProvidersResult {
  providers: InspectionProvider[];
  contactPhone: string | null;
}

export interface GuestInspectionInput {
  governorateId: string;
  regionId: string;
  providerId: string | null;
  guestName: string;
  guestPhone: string;
  acceptedTerms: true;
}

export interface GuestInspectionResult {
  requestId: string;
  matchingStatus: "matched" | "no_match";
  notificationId: string | null;
  provider: Pick<InspectionProvider, "id" | "businessName" | "phone"> | null;
  contactPhone: string | null;
  delivery: "not_implemented";
}

export interface InspectionApiError {
  error: string;
  fields?: Partial<Record<keyof GuestInspectionInput, string>>;
}