"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { Profile } from "../../account/contracts";

export const expiredMessage = "انتهت جلستك. الرجاء تسجيل الدخول مجدداً.";
export const genericServiceError = "تعذر إكمال الطلب. حاول مرة أخرى.";

export type ServiceError = Error & { status?: number; payload?: { error?: string; fields?: Record<string, string> } };

export async function readServiceJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(value?.error || genericServiceError) as ServiceError;
    error.status = response.status;
    error.payload = value && typeof value === "object" ? value : undefined;
    throw error;
  }
  if (!value || typeof value !== "object") throw new Error("تعذر تأكيد استجابة الخدمة.");
  return value as T;
}

export async function serviceRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  return readServiceJson<T>(response);
}

export function expireRegisteredSession(router: ReturnType<typeof useRouter>) {
  if (typeof window !== "undefined") {
    sessionStorage.setItem("syriacar.account.sessionError", expiredMessage);
    router.replace("/login");
  }
}

export function useRegisteredSession(onExpired: () => void) {
  useEffect(() => {
    window.addEventListener("syriacar-account-expired", onExpired);
    return () => window.removeEventListener("syriacar-account-expired", onExpired);
  }, [onExpired]);
}

export type Locality = { id: string; name: string };
export type ProfileProps = { profile: Profile };

type SheetProps = { title: string; onClose: () => void; children: React.ReactNode; labelledBy: string };

export function AccessibleSheet({ title, onClose, children, labelledBy }: SheetProps) {
  const box = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = box.current;
    const focusables = () => current?.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    );
    focusables()?.[0]?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const items = Array.from(focusables() || []);
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return <div className="rs-sheet-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={box} className="rs-sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
      <div className="rs-sheet-top">
        <h2 id={labelledBy}>{title}</h2>
        <button className="rs-close" type="button" onClick={onClose} aria-label="إغلاق">×</button>
      </div>
      {children}
    </section>
  </div>;
}