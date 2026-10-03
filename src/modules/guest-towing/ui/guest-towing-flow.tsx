"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { TowingApiError, TowingInput, TowingProvider, TowingProvidersResult, TowingResult } from "../contracts";
import { coverageWarning, towingWarning } from "../contracts";
import TowLocationDialog from "./tow-location-dialog";
import TowNotifySheet from "./tow-notify-sheet";
import TowProviderSection from "./tow-provider-section";
import "./guest-towing.css";

type Governorate = { id: string; name: string };
type ApiFailure = Error & { status?: number; payload?: TowingApiError };
type Phase = "form" | "success" | "unknown";

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error("تعذر إكمال الطلب.") as ApiFailure;
    error.status = response.status;
    error.payload = data && typeof data === "object" ? data as TowingApiError : undefined;
    throw error;
  }
  if (!data || typeof data !== "object") throw new Error("تعذر تأكيد استجابة الخدمة.");
  return data as T;
}

function phoneDisplay(phone: string) {
  return <span className="tow-phone">{phone}</span>;
}

export default function GuestTowingFlow() {
  const [governorates, setGovernorates] = useState<Governorate[]>([]);
  const [governoratesLoading, setGovernoratesLoading] = useState(true);
  const [governoratesError, setGovernoratesError] = useState("");
  const [originGovernorateId, setOriginGovernorateId] = useState("");
  const [destGovernorateId, setDestGovernorateId] = useState("");
  const [providerData, setProviderData] = useState<TowingProvidersResult | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<TowingProvider | null>(null);
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof TowingInput, string>>>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [result, setResult] = useState<TowingResult | null>(null);
  const [identityLocked, setIdentityLocked] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [unknownMessage, setUnknownMessage] = useState("");
  const [sheetKey, setSheetKey] = useState(0);
  const postInFlight = useRef(false);
  const requestProofMemory = useRef<string | null>(null);
  const providersGeneration = useRef(0);
  const providersAbort = useRef<AbortController | null>(null);
  const governoratesAbort = useRef<AbortController | null>(null);

  const loadGovernorates = useCallback(async () => {
    governoratesAbort.current?.abort();
    const controller = new AbortController();
    governoratesAbort.current = controller;
    setGovernoratesLoading(true);
    setGovernoratesError("");
    try {
      const data = await readJson<{ governorates: Governorate[]; regions: unknown[] }>(
        await fetch("/api/guest-towing/governorates", { signal: controller.signal, headers: { Accept: "application/json" } }),
      );
      if (!controller.signal.aborted) setGovernorates(data.governorates);
    } catch (error) {
      if (!controller.signal.aborted) setGovernoratesError(error instanceof TypeError ? "تعذر الاتصال بالخدمة. تحقق من اتصالك ثم أعد المحاولة." : "تعذر تحميل المحافظات.");
    } finally {
      if (!controller.signal.aborted) setGovernoratesLoading(false);
    }
  }, []);

  const loadProviders = useCallback(async (origin: string, destination: string) => {
    if (!origin || !destination) return;
    const generation = ++providersGeneration.current;
    providersAbort.current?.abort();
    const controller = new AbortController();
    providersAbort.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
    setProvidersLoading(true);
    setProvidersError("");
    setProviderData(null);
    setSelectedProvider(null);
    try {
      const query = new URLSearchParams({ originGovernorateId: origin, destGovernorateId: destination });
      const data = await readJson<TowingProvidersResult>(
        await fetch(`/api/guest-towing/providers?${query}`, { signal: controller.signal, headers: { Accept: "application/json" } }),
      );
      if (generation === providersGeneration.current) setProviderData(data);
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return;
      if (generation === providersGeneration.current) setProvidersError(error instanceof TypeError || timedOut ? "تعذر تحميل المزودين. تحقق من الاتصال ثم أعد المحاولة." : "تعذر تحميل مزودي السطحات. حاول مرة أخرى.");
    } finally {
      clearTimeout(timer);
      if (generation === providersGeneration.current) setProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGovernorates();
    return () => {
      governoratesAbort.current?.abort();
      providersAbort.current?.abort();
    };
  }, [loadGovernorates]);

  const originName = governorates.find((item) => item.id === originGovernorateId)?.name ?? "";
  const destinationName = governorates.find((item) => item.id === destGovernorateId)?.name ?? "";

  function resetFeedback() {
    setFieldErrors({});
    setFormError("");
  }

  function updateRoute(kind: "origin" | "destination", value: string) {
    if (requestProofMemory.current) return;
    const nextOrigin = kind === "origin" ? value : originGovernorateId;
    const nextDestination = kind === "destination" ? value : destGovernorateId;
    if (kind === "origin") setOriginGovernorateId(value);
    else setDestGovernorateId(value);
    setSelectedProvider(null);
    setProviderData(null);
    setProvidersError("");
    setProvidersLoading(false);
    providersAbort.current?.abort();
    ++providersGeneration.current;
    resetFeedback();
    setResult(null);
    setPhase("form");
    if (nextOrigin && nextDestination) void loadProviders(nextOrigin, nextDestination);
  }

  function openNotify(provider: TowingProvider) {
    if (postInFlight.current) return;
    setSelectedProvider(provider);
    setSheetKey((key) => key + 1);
    setFieldErrors({});
    setFormError("");
  }

  async function submitNotification(name: string, phone: string) {
    if (!selectedProvider || postInFlight.current) return;
    postInFlight.current = true;
    setSubmitting(true);
    setFieldErrors({});
    setFormError("");
    setUnknownMessage("");
    const input: TowingInput = {
      originGovernorateId,
      destGovernorateId,
      providerId: selectedProvider.id,
      guestName: identityLocked ? guestName : name.trim(),
      guestPhone: identityLocked ? guestPhone : phone.trim(),
      acceptedTerms: true,
      ...(requestProofMemory.current ? { requestProof: requestProofMemory.current } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let timedOut = false;
    try {
      controller.signal.addEventListener("abort", () => { timedOut = true; }, { once: true });
      const response = await fetch("/api/guest-towing/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (response.status === 409) {
        setSelectedProvider(null);
        setFormError("تغيّر توفر هذا المزود. حدّثنا الخيارات؛ اختر مزودًا متاحًا ثم أكّد الإشعار.");
        await loadProviders(originGovernorateId, destGovernorateId);
        return;
      }
      const data = await readJson<TowingResult>(response);
      if (!requestProofMemory.current) requestProofMemory.current = data.requestProof;
      setGuestName(input.guestName);
      setGuestPhone(input.guestPhone);
      setIdentityLocked(true);
      setResult(data);
      setPhase("success");
      setSelectedProvider(null);
      setFieldErrors({});
      setFormError("");
    } catch (error) {
      const failure = error as ApiFailure;
      if (failure.status === 422 && failure.payload?.fields) {
        setFieldErrors(failure.payload.fields);
        setFormError("يرجى مراجعة البيانات الموضحة.");
      } else if (failure.status === 500 || failure.status === 503) {
        setFormError("تعذر تسجيل الإشعار. لم تُرسل رسالة واتساب.");
      } else if (failure.status) {
        setFormError(failure.payload?.error || "تعذر تسجيل الإشعار. راجع الاختيار وحاول مرة أخرى.");
      } else if (requestProofMemory.current) {
        setUnknownMessage("تعذر معرفة نتيجة إشعار هذا المزود. لم تتم إعادة المحاولة تلقائيًا؛ يمكنك اختيار مزود آخر لهذا الطلب.");
        setSelectedProvider(null);
      } else {
        setPhase("unknown");
        setFormError(timedOut ? "انتهت مهلة الاتصال؛ قد يكون الطلب قد سُجّل. لم تتم إعادة المحاولة تلقائيًا." : "تعذر معرفة نتيجة الإرسال. قد يكون الطلب قد سُجّل؛ لم تتم إعادة المحاولة تلقائيًا.");
        setSelectedProvider(null);
      }
    } finally {
      clearTimeout(timer);
      postInFlight.current = false;
      setSubmitting(false);
    }
  }

  function startNewRequest() {
    ++providersGeneration.current;
    providersAbort.current?.abort();
    setProvidersLoading(false);
    setLocationOpen(false);
    requestProofMemory.current = null;
    setOriginGovernorateId("");
    setDestGovernorateId("");
    setProviderData(null);
    setProvidersError("");
    setSelectedProvider(null);
    setGuestName("");
    setGuestPhone("");
    setIdentityLocked(false);
    setResult(null);
    setPhase("form");
    setUnknownMessage("");
    resetFeedback();
  }

  function openLocation() {
    if (result) setLocationOpen(true);
  }

  function scrollToProviders() {
    document.querySelector(".tow-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function retryProviders() {
    void loadProviders(originGovernorateId, destGovernorateId);
  }

  function continueRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors: Partial<Record<keyof TowingInput, string>> = {};
    if (!originGovernorateId) errors.originGovernorateId = "اختر محافظة الانطلاق.";
    if (!destGovernorateId) errors.destGovernorateId = "اختر محافظة الوصول.";
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    if (providersError) retryProviders();
    else if (providerData) document.querySelector(".tow-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderProviderResults() {
    if (!originGovernorateId || !destGovernorateId) return null;
    const sectionA = providerData?.sectionA ?? [];
    const sectionB = providerData?.sectionB ?? [];
    const noMatch = (
      <div className="tow-no-match" data-testid="towing-no-match">
        <span className="tow-no-match-mark" aria-hidden="true">i</span>
        <span>
          لا يوجد مزود يغطي هذا المسار
          {providerData?.contactPhone ? <> — يمكنك التواصل معنا على {phoneDisplay(providerData.contactPhone)}</> : null}
        </span>
      </div>
    );
    return (
      <div className="tow-results" id="tow-results">
        <div className="tow-warning"><span className="tow-warning-mark" aria-hidden="true">i</span><span>{coverageWarning}</span></div>
        {providersLoading ? (
          <div className="tow-result-section" aria-label="جارٍ تحميل المزودين" aria-live="polite">
            <div className="tow-result-heading"><h2>مزودو السطحات</h2><p>جارٍ تحميل الخيارات…</p></div>
            <div className="tow-skeleton-list"><div className="tow-skeleton" /><div className="tow-skeleton" /></div>
          </div>
        ) : providersError ? (
          <div className="tow-inline-error" role="alert">
            <p>{providersError}</p>
            <button type="button" className="tow-button tow-button-secondary" onClick={retryProviders}>إعادة تحميل المزودين</button>
          </div>
        ) : providerData ? (
          <>
            <TowProviderSection section="A" title="مناسب لمشكلتك" providers={sectionA} onNotify={openNotify} empty={noMatch} />
            <TowProviderSection section="B" title="باقي المزودين" providers={sectionB} onNotify={openNotify} />
          </>
        ) : null}
      </div>
    );
  }

  if (phase === "unknown") {
    return (
      <section className="tow-success" aria-live="assertive">
        <p className="tow-warning">{towingWarning}</p>
        <div className="tow-success-head">
          <span className="tow-success-symbol" aria-hidden="true">!</span>
          <p className="tow-kicker">تعذّر تأكيد النتيجة</p>
          <h1>لم نتمكن من معرفة حالة الطلب</h1>
          <p>{formError}</p>
        </div>
        <p className="tow-unknown">لتجنب إنشاء طلب مكرر، لم نعد الإرسال تلقائيًا. ابدأ طلبًا جديدًا فقط إذا رغبت بالمتابعة من البداية.</p>
        <div className="tow-success-actions"><button className="tow-button tow-button-secondary" type="button" data-testid="new-request" onClick={startNewRequest}>بدء طلب جديد</button></div>
      </section>
    );
  }

  return (
    <div className="guest-towing">
      <header className="tow-heading">
        <span className="tow-heading-mark" aria-hidden="true">س</span>
        <div>
          <p className="tow-kicker">طلب ضيف · سطحة</p>
          <h1>اعثر على مزود سطحة لمسارك</h1>
          <p className="tow-lede">اختر محافظتي الانطلاق والوصول، ثم أبلغ المزود بعد مراجعة التفاصيل.</p>
        </div>
      </header>
      <p className="tow-warning">{towingWarning}</p>

      {phase === "success" && result && (
        <section className="tow-success" data-testid="towing-success" aria-live="polite" aria-labelledby="tow-success-title">
          <div className="tow-success-head">
            <span className="tow-success-symbol" aria-hidden="true">✓</span>
            <p className="tow-kicker">نتيجة الإشعار</p>
            <h1 id="tow-success-title">تم تسجيل إشعار المزود</h1>
            <p>{result.provider.businessName}</p>
          </div>
          <div className="tow-success-note">
            <strong>ما الذي تم؟</strong>
            <p>سُجّل الطلب والإشعار في قاعدة البيانات. لم ترسل المنصة رسالة واتساب؛ أرسلها بنفسك من الرابط عند رغبتك.</p>
            <p>هاتف المزود: {phoneDisplay(result.provider.phone)}</p>
            <p>{result.matchingStatus === "matched" ? "حالة الطلب: يوجد مزود مناسب للمسار." : "حالة الطلب: لم تتم مطابقة المسار بمزود مناسب بعد."}</p>
            <p>المسار المسجل: {originName} ← {destinationName}</p>
          </div>
          <div className="tow-warning"><span className="tow-warning-mark" aria-hidden="true">i</span><span>{towingWarning}</span></div>
          <div className="tow-success-actions">
            <a className="tow-button tow-button-primary tow-wa-link" href={result.whatsappUrl} target="_blank" rel="noopener noreferrer">فتح واتساب وإرسال الرسالة</a>
            <button type="button" className="tow-button tow-button-secondary" onClick={openLocation}>أرسل موقعك للمزود</button>
          </div>
          <button type="button" className="tow-button tow-button-secondary tow-another" data-testid="another-provider" onClick={scrollToProviders}>أبلغ مزودًا آخر للمسار نفسه</button>
          {unknownMessage && <p className="tow-error" role="alert">{unknownMessage}</p>}
          <button type="button" className="tow-inline-action" data-testid="new-request" onClick={startNewRequest}>بدء طلب جديد</button>
        </section>
      )}

      <form className="tow-form" onSubmit={continueRoute} noValidate>
        <section className="tow-form-section" aria-labelledby="tow-route-title">
          <div className="tow-section-title">
            <span className="tow-index">١</span>
            <div><h2 id="tow-route-title">حدد مسار السطحة</h2><p>اختر محافظة الانطلاق ومحافظة الوصول.</p></div>
          </div>
          <div className="tow-field-grid">
            <div className="tow-field">
              <label htmlFor="origin-governorate">محافظة الانطلاق <span className="tow-required">مطلوب</span></label>
              <select id="origin-governorate" value={originGovernorateId} disabled={governoratesLoading || !!governoratesError || identityLocked} onChange={(event) => updateRoute("origin", event.target.value)} aria-invalid={!!fieldErrors.originGovernorateId}>
                <option value="">اختر محافظة الانطلاق</option>
                {governorates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              {fieldErrors.originGovernorateId && <span className="tow-error">{fieldErrors.originGovernorateId}</span>}
            </div>
            <div className="tow-field">
              <label htmlFor="dest-governorate">محافظة الوصول <span className="tow-required">مطلوب</span></label>
              <select id="dest-governorate" value={destGovernorateId} disabled={governoratesLoading || !!governoratesError || identityLocked} onChange={(event) => updateRoute("destination", event.target.value)} aria-invalid={!!fieldErrors.destGovernorateId}>
                <option value="">اختر محافظة الوصول</option>
                {governorates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              {fieldErrors.destGovernorateId && <span className="tow-error">{fieldErrors.destGovernorateId}</span>}
            </div>
          </div>
          {governoratesLoading && <span className="tow-hint">جارٍ تحميل المحافظات…</span>}
          {governoratesError && <div className="tow-inline-error" role="alert"><p>{governoratesError}</p><button className="tow-button tow-button-secondary" type="button" onClick={() => void loadGovernorates()}>إعادة المحاولة</button></div>}
          {identityLocked && <span className="tow-hint">المسار والهوية ثابتان لهذا الطلب. لبدء مسار جديد استخدم «بدء طلب جديد».</span>}
        </section>
        {formError && !selectedProvider && <p className="tow-form-message" role="alert">{formError}</p>}
        <div className="tow-form-footer">
          <p>لا يُسجَّل إشعار إلا بعد مراجعة بيانات التواصل وموافقتك في خطوة التأكيد.</p>
          <button className="tow-button tow-button-primary tow-submit submit-button" type="submit" disabled={governoratesLoading || !!governoratesError || providersLoading || identityLocked}>
            {providersLoading ? "جارٍ البحث…" : "متابعة"}
          </button>
        </div>
      </form>
      {renderProviderResults()}
      {selectedProvider && (
        <TowNotifySheet
          key={`${selectedProvider.id}-${sheetKey}`}
          provider={selectedProvider}
          originName={originName}
          destinationName={destinationName}
          guestName={guestName}
          guestPhone={guestPhone}
          identityLocked={identityLocked}
          submitting={submitting}
          formError={formError}
          fieldErrors={fieldErrors}
          onIdentityChange={(name, phone) => {
            if (identityLocked) return;
            setGuestName(name);
            setGuestPhone(phone);
            setFormError("");
            setFieldErrors((current) => ({ ...current, guestName: undefined, guestPhone: undefined }));
          }}
          onConfirm={(name, phone) => void submitNotification(name, phone)}
          onCancel={() => { if (!submitting) { setSelectedProvider(null); setFormError(""); setFieldErrors({}); } }}
        />
      )}
      {result && (
        <TowLocationDialog
          open={locationOpen}
          requestProof={requestProofMemory.current ?? result.requestProof}
          notificationId={result.notificationId}
          onClose={() => setLocationOpen(false)}
        />
      )}
    </div>
  );
}