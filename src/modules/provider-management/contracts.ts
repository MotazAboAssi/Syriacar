export interface ProviderProfile {
  businessName: string;
  phone: string;
  serviceType: "inspection" | "towing";
  status: "active";
  governorate: string;
  region: string;
  towType: string | null;
  coverage: string[];
}
export interface ProviderReferences {
  governorates: { id: string; name: string; active: boolean }[];
  regions: { id: string; governorateId: string; name: string; active: boolean }[];
  towTypes: { id: string; name: string; active: boolean }[];
}
export interface ProviderNotification {
  id: string;
  createdAt: string;
  serviceType: "inspection" | "towing";
  customerType: "guest" | "registered";
  customerName: string | null;
  customerPhone: string | null;
  context: {
    governorate: string | null;
    region: string | null;
    origin: string | null;
    destination: string | null;
    vehicle: { brand: string | null; year: number; category: string; fuel: string | null } | null;
  };
}
export interface ProviderNotificationPage {
  items: ProviderNotification[];
  nextCursor: string | null;
}