"use client";
import type { ProviderNotification, ProviderNotificationPage, ProviderProfile, ProviderReferences } from "./contracts.ts";

export class ProviderApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) { super(message); }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/provider" + path, {
    ...init, credentials: "same-origin", cache: "no-store",
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new ProviderApiError(response.status, data.error ?? "تعذّر تحميل البيانات.",
    response.headers.has("Retry-After") ? Number(response.headers.get("Retry-After")) : undefined);
  return data as T;
}
export const providerApi = {
  login: (phone: string, password: string) => request<ProviderProfile>("/login", {
    method: "POST", body: JSON.stringify({ phone, password }),
  }),
  logout: () => request<{ ok: true }>("/logout", { method: "POST" }),
  profile: () => request<ProviderProfile>("/profile"),
  references: () => request<ProviderReferences>("/references"),
  notifications: (cursor?: string) => request<ProviderNotificationPage>("/notifications" +
    (cursor ? "?cursor=" + encodeURIComponent(cursor) : "")),
  notification: (id: string) => request<ProviderNotification>("/notifications/" + encodeURIComponent(id)),
};