import type { InspectionProvider } from "../guest-inspection/contracts.ts";

export interface RegisteredProvider extends InspectionProvider {
  suitable: boolean;
  coordinates: { lat: number; lng: number } | null;
}
export interface RegisteredProviders {
  providers: RegisteredProvider[];
  contactPhone: string | null;
}
export interface Confirmation {
  requestId: string;
  notificationId: string | null;
  matchingStatus: "matched" | "no_match";
  provider: { id: string; businessName: string; phone: string } | null;
  whatsappUrl: string | null;
  contactPhone: string | null;
  delivery: "not_implemented";
}
/** Client-only coordinates. Never include these in an API request or storage. */
export function coordinates(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  if (lat === null || lat === undefined || lng === null || lng === undefined ||
    lat === "" || lng === "" || !["number", "string"].includes(typeof lat) ||
    !["number", "string"].includes(typeof lng)) return null;
  const a = Number(lat), b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180
    ? { lat: a, lng: b } : null;
}
export function gpsLocationLink(whatsappUrl: string, name: string, lat: unknown, lng: unknown): string | null {
  const point = coordinates(lat, lng);
  if (!point) return null;
  const url = new URL(whatsappUrl);
  if (url.origin !== "https://wa.me" || !/^\/\d+$/.test(url.pathname)) return null;
  url.searchParams.set("text", `Syriacar — ${name} — سطحة — موقعي: https://maps.google.com/?q=${point.lat},${point.lng}`);
  return url.toString();
}