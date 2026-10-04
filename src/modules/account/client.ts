import type { AccountReferences, ApiError, OtpState, Profile, Vehicle, VehicleInput } from "./contracts";

export class AccountApiError extends Error {
  status: number;
  detail: ApiError;
  constructor(status: number, detail: ApiError) {
    super(detail.error);
    this.status = status;
    this.detail = detail;
  }
}
async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined" &&
      /^\/api\/account\/(profile|references|vehicles)(\/|$)/.test(path)) {
      window.dispatchEvent(new Event("syriacar-account-expired"));
    }
    throw new AccountApiError(response.status, result);
  }
  return result as T;
}
export const accountApi = {
  register: (input: { name: string; phone: string; password: string }) =>
    call<OtpState>("/api/account/register", "POST", input),
  otpState: (phone: string) => call<OtpState>("/api/account/otp?phone=" + encodeURIComponent(phone)),
  verify: (input: { phone: string; code: string }) => call<Profile>("/api/account/otp", "POST", input),
  resend: (phone: string) => call<OtpState>("/api/account/otp/resend", "POST", { phone }),
  login: (input: { phone: string; password: string }) => call<Profile>("/api/account/login", "POST", input),
  logout: () => call<{ ok: true }>("/api/account/logout", "POST", {}),
  profile: () => call<Profile>("/api/account/profile"),
  saveProfile: (homeGovernorateId: string | null) =>
    call<Profile>("/api/account/profile", "PATCH", { homeGovernorateId }),
  deleteAccount: () => call<{ ok: true }>("/api/account/profile", "DELETE", {}),
  references: () => call<AccountReferences>("/api/account/references"),
  vehicles: () => call<Vehicle[]>("/api/account/vehicles"),
  vehicle: (id: string) => call<Vehicle>("/api/account/vehicles/" + encodeURIComponent(id)),
  addVehicle: (input: VehicleInput) => call<Vehicle>("/api/account/vehicles", "POST", input),
  editVehicle: (id: string, input: VehicleInput) =>
    call<Vehicle>("/api/account/vehicles/" + encodeURIComponent(id), "PATCH", input),
};