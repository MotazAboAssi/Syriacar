"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { towingWarning } from "../contracts";

type Locality = { id: string; name: string };
type LocationApiError = { error?: string; fields?: Partial<Record<"governorateId" | "regionId", string>> };
type LocationResult = { whatsappUrl: string; delivery: "not_implemented" };

type Props = {
  open: boolean;
  requestProof: string;
  notificationId: string;
  onClose: () => void;
};

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error("تعذر تجهيز رسالة الموقع.") as Error & { status?: number; payload?: LocationApiError };
    error.status = response.status;
    error.payload = payload && typeof payload === "object" ? payload as LocationApiError : undefined;
    throw error;
  }
  if (!payload || typeof payload !== "object") throw new Error("تعذر تأكيد استجابة الخدمة.");
  return payload as T;
}

export default function TowLocationDialog({ open, requestProof, notificationId, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const governorateAbort = useRef<AbortController | null>(null);
  const regionAbort = useRef<AbortController | null>(null);
  const [governorates, setGovernorates] = useState<Locality[]>([]);
  const [regions, setRegions] = useState<Locality[]>([]);
  const [governorateId, setGovernorateId] = useState("");
  const [regionId, setRegionId] = useState("");
  const [loadingGovernorates, setLoadingGovernorates] = useState(false);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [whatsappUrl, setWhatsappUrl] = useState("");
  const submitRef = useRef(false);
  const prepareAbort = useRef<AbortController | null>(null);
  const prepareGeneration = useRef(0);

  useEffect(() => {
    ++prepareGeneration.current;
    prepareAbort.current?.abort();
    setWhatsappUrl("");
    setBusy(false);
    submitRef.current = false;
    return () => {
      ++prepareGeneration.current;
      prepareAbort.current?.abort();
    };
  }, [open, notificationId]);

  const loadGovernorates = useCallback(async () => {
    governorateAbort.current?.abort();
    const controller = new AbortController();
    governorateAbort.current = controller;
    setLoadingGovernorates(true);
    setError("");
    try {
      const data = await responseJson<{ governorates: Locality[]; regions: Locality[] }>(
        await fetch("/api/guest-towing/governorates", { signal: controller.signal, headers: { Accept: "application/json" } }),
      );
      if (!controller.signal.aborted) setGovernorates(data.governorates);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof TypeError ? "تعذر الاتصال بالخدمة. حاول مرة أخرى." : "تعذر تحميل المحافظات.");
    } finally {
      if (!controller.signal.aborted) setLoadingGovernorates(false);
    }
  }, []);

  useEffect(() => {
    if (open && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
    if (!open && dialogRef.current?.open) dialogRef.current.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setWhatsappUrl("");
    void loadGovernorates();
    return () => governorateAbort.current?.abort();
  }, [open, loadGovernorates]);

  useEffect(() => () => regionAbort.current?.abort(), []);

  async function changeGovernorate(value: string) {
    setGovernorateId(value);
    setRegionId("");
    setRegions([]);
    setWhatsappUrl("");
    setFieldError("");
    setError("");
    regionAbort.current?.abort();
    const current = ++generation.current;
    if (!value) { setLoadingRegions(false); return; }
    const controller = new AbortController();
    regionAbort.current = controller;
    setLoadingRegions(true);
    try {
      const query = new URLSearchParams({ governorateId: value });
      const data = await responseJson<{ governorates: Locality[]; regions: Locality[] }>(
        await fetch(`/api/guest-towing/governorates?${query}`, { signal: controller.signal, headers: { Accept: "application/json" } }),
      );
      if (current === generation.current) setRegions(data.regions);
    } catch (caught) {
      if (!controller.signal.aborted && current === generation.current) {
        setError(caught instanceof TypeError ? "تعذر الاتصال بالخدمة. حاول مرة أخرى." : "تعذر تحميل المناطق.");
      }
    } finally {
      if (current === generation.current) setLoadingRegions(false);
    }
  }

  async function prepareLocation() {
    if (submitRef.current || !governorateId || !regionId) {
      if (!governorateId || !regionId) setFieldError("اختر المحافظة والمنطقة.");
      return;
    }
    submitRef.current = true;
    setBusy(true);
    setError("");
    setFieldError("");
    setWhatsappUrl("");
    const current = ++prepareGeneration.current;
    const controller = new AbortController();
    prepareAbort.current = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const data = await responseJson<LocationResult>(await fetch("/api/guest-towing/location", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ requestProof, notificationId, governorateId, regionId }),
        signal: controller.signal,
      }));
      if (current === prepareGeneration.current) setWhatsappUrl(data.whatsappUrl);
    } catch (caught) {
      if (current !== prepareGeneration.current) return;
      const failure = caught as Error & { status?: number; payload?: LocationApiError };
      if (failure.status === 422 && failure.payload?.fields) {
        setFieldError(failure.payload.fields.regionId || failure.payload.fields.governorateId || "تحقق من المحافظة والمنطقة.");
      } else if (!failure.status || failure.status >= 500) {
        setError("تعذر معرفة نتيجة تجهيز الرسالة. لا تُعد المحاولة تلقائياً؛ يمكنك المحاولة يدوياً عند الحاجة.");
      } else {
        setError("تعذر تجهيز رسالة الموقع. راجع الاختيار وحاول مرة أخرى.");
      }
    } finally {
      clearTimeout(timer);
      if (current === prepareGeneration.current) {
        submitRef.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <dialog className="tow-location-dialog" ref={dialogRef} data-testid="location-dialog" aria-labelledby="tow-location-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={() => { if (open) onClose(); }}>
      <div className="tow-sheet-top"><span>مشاركة الموقع يدويًا</span><button className="tow-sheet-close" type="button" onClick={onClose} aria-label="إغلاق">×</button></div>
      <h2 id="tow-location-title">أرسل موقعك للمزود</h2>
      <p>اختر محافظة ومنطقة لوصف موقعك. هذا الاختيار منفصل عن مسار السطحة ولا يغيّره.</p>
      <p className="tow-warning">{towingWarning}</p>
      <div className="tow-field">
        <label htmlFor="location-governorate">المحافظة <span className="tow-required">مطلوب</span></label>
        <select id="location-governorate" value={governorateId} disabled={busy || loadingGovernorates || (!!error && governorates.length === 0)} onChange={(event) => void changeGovernorate(event.target.value)}>
          <option value="">اختر المحافظة</option>
          {governorates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      <div className="tow-field" style={{ marginBlockStart: 14 }}>
        <label htmlFor="location-region">المنطقة <span className="tow-required">مطلوب</span></label>
        <select id="location-region" value={regionId} disabled={busy || !governorateId || loadingRegions || regions.length === 0} onChange={(event) => { setRegionId(event.target.value); setWhatsappUrl(""); setFieldError(""); }}>
          <option value="">اختر المنطقة</option>
          {regions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      {loadingGovernorates && <span className="tow-hint">جارٍ تحميل المحافظات…</span>}
      {loadingRegions && <span className="tow-hint">جارٍ تحميل المناطق…</span>}
      {fieldError && <span className="tow-error" role="alert">{fieldError}</span>}
      {error && <div className="tow-inline-error" role="alert"><p>{error}</p><button type="button" className="tow-button tow-button-secondary" onClick={() => governorateId && governorates.length ? void changeGovernorate(governorateId) : void loadGovernorates()}>إعادة المحاولة</button></div>}
      {whatsappUrl && (
        <div className="tow-disclosure" role="status">
          <strong>الرسالة جاهزة للإرسال من طرفك</strong>
          <p>لم ترسل المنصة رسالة واتساب. افتح واتساب ثم أرسل الرسالة بنفسك.</p>
          <a className="tow-button tow-button-primary tow-wa-link" href={whatsappUrl} target="_blank" rel="noopener noreferrer">فتح واتساب لإرسال الموقع</a>
        </div>
      )}
      <div className="tow-location-actions">
        <button type="button" className="tow-button tow-button-secondary" onClick={onClose}>إغلاق</button>
        <button type="button" className="tow-button tow-button-primary" onClick={() => void prepareLocation()} disabled={busy || loadingGovernorates || loadingRegions || !governorateId || !regionId}>
          {busy ? "جارٍ تجهيز الرسالة…" : "أرسل موقعي"}
        </button>
      </div>
    </dialog>
  );
}