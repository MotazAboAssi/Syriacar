export interface TowingInput {
  originGovernorateId: string;
  destGovernorateId: string;
  providerId: string;
  guestName: string;
  guestPhone: string;
  acceptedTerms: true;
  requestProof?: string;
}

export interface TowingProvider {
  id: string;
  businessName: string;
  phone: string;
  coverage: { id: string; name: string }[];
  towType: string | null;
}

export interface TowingProvidersResult {
  sectionA: TowingProvider[];
  sectionB: TowingProvider[];
  contactPhone: string | null;
}

export interface TowingResult {
  requestId: string;
  requestProof: string;
  notificationId: string;
  matchingStatus: "matched" | "no_match";
  provider: Pick<TowingProvider, "id" | "businessName" | "phone">;
  whatsappUrl: string;
  delivery: "not_implemented";
}

export interface TowingApiError {
  error: string;
  fields?: Partial<Record<keyof TowingInput | "governorateId" | "regionId", string>>;
}

export const coverageWarning = "التغطية الدقيقة داخل المحافظة تُحدَّد بالاتصال مع المزود.";
export const towingWarning = "التواصل يعتمد على استجابة المزود، والإشعار ليس حجزًا ولا ضمانًا.";