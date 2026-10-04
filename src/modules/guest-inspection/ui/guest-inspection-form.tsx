"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type {
  GuestInspectionInput,
  GuestInspectionResult,
  InspectionApiError,
  InspectionProvider,
  LocalitiesResult,
  LocalityOption,
  ProvidersResult,
} from "../contracts";
import ProviderCard, { phoneDisplay } from "./provider-card";
import "./guest-inspection.css";

type ApiFailure = Error & { status?: number; payload?: InspectionApiError };
type Phase = "form" | "success" | "unknown";

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error("تعذر إكمال الطلب.") as ApiFailure;
    error.status = response.status;
    error.payload = data && typeof data === "object" ? (data as InspectionApiError) : undefined;
    throw error;
  }
  if (!data || typeof data !== "object") throw new Error("تعذر تأكيد استجابة الخدمة.");
  return data as T;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof TypeError) return "تعذر الاتصال بالخدمة. تحقق من اتصالك ثم أعد المحاولة.";
  return fallback;
}

export default function GuestInspectionForm() {
  const [localities, setLocalities] = useState<LocalitiesResult | null>(null);
  const [localitiesError, setLocalitiesError] = useState("");
  const [localitiesLoading, setLocalitiesLoading] = useState(true);
  const [governorateId, setGovernorateId] = useState("");
  const [regionId, setRegionId] = useState("");
  const [providers, setProviders] = useState<InspectionProvider[]>([]);
  const [contactPhone, setContactPhone] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof GuestInspectionInput, string>>>({});
  const [formError, setFormError] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [result, setResult] = useState<GuestInspectionResult | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const postInFlight = useRef(false);
  const localityGeneration = useRef(0);
  const providerGeneration = useRef(0);
  const localityAbort = useRef<AbortController | null>(null);
  const providersAbort = useRef<AbortController | null>(null);

  const loadLocalities = useCallback(async (selectedGovernorate = "") => {
    const generation = ++localityGeneration.current;
    localityAbort.current?.abort();
    const controller = new AbortController();
    localityAbort.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
    setLocalitiesLoading(true);
    setLocalitiesError("");
    try {
      const query = selectedGovernorate ? `?governorateId=${encodeURIComponent(selectedGovernorate)}` : "";
      const response = await fetch(`/api/guest-inspection/localities${query}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      const data = await readJson<LocalitiesResult>(response);
      if (generation === localityGeneration.current) setLocalities(data);
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return;
      if (generation === localityGeneration.current) {
        setLocalitiesError(getErrorMessage(error, "تعذر تحميل المناطق. حاول مرة أخرى."));
      }
    } finally {
      clearTimeout(timer);
      if (generation === localityGeneration.current) setLocalitiesLoading(false);
    }
  }, []);

  const loadProviders = useCallback(async (governorate: string, region: string) => {
    if (!governorate || !region) return;
    const generation = ++providerGeneration.current;
    providersAbort.current?.abort();
    const controller = new AbortController();
    providersAbort.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
    setProvidersLoading(true);
    setProvidersError("");
    setProviders([]);
    setContactPhone(null);
    setSelectedProviderId(null);
    try {
      const query = new URLSearchParams({ governorateId: governorate, regionId: region });
      const response = await fetch(`/api/guest-inspection/providers?${query}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      const data = await readJson<ProvidersResult>(response);
      if (generation === providerGeneration.current) {
        setProviders(data.providers);
        setContactPhone(data.contactPhone);
      }
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return;
      if (generation === providerGeneration.current) {
        setProvidersError(getErrorMessage(error, "تعذر تحميل المزودين المطابقين. حاول مرة أخرى."));
      }
    } finally {
      clearTimeout(timer);
      if (generation === providerGeneration.current) setProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLocalities();
    return () => {
      localityAbort.current?.abort();
      providersAbort.current?.abort();
    };
  }, [loadLocalities]);

  const regions: LocalityOption[] = localities?.regions ?? [];
  const visibleRegions = regions;

  function resetResultAndErrors() {
    setPhase("form");
    setResult(null);
    setFormError("");
    setFieldErrors({});
  }

  function handleGovernorateChange(value: string) {
    ++providerGeneration.current;
    setProvidersLoading(false);
    setGovernorateId(value);
    setRegionId("");
    setProviders([]);
    setSelectedProviderId(null);
    setProvidersError("");
    setContactPhone(null);
    providersAbort.current?.abort();
    resetResultAndErrors();
    if (value) void loadLocalities(value);
    else {
      setLocalities((current) => current ? { ...current, regions: [] } : current);
      void loadLocalities();
    }
  }

  function handleRegionChange(value: string) {
    ++providerGeneration.current;
    providersAbort.current?.abort();
    setProvidersLoading(false);
    setRegionId(value);
    setSelectedProviderId(null);
    setProviders([]);
    setProvidersError("");
    setContactPhone(null);
    resetResultAndErrors();
    if (value) void loadProviders(governorateId, value);
  }

  function changeGuestName(value: string) {
    setGuestName(value);
    setFieldErrors((current) => ({ ...current, guestName: undefined }));
    resetResultAndErrors();
  }

  function changeGuestPhone(value: string) {
    setGuestPhone(value);
    setFieldErrors((current) => ({ ...current, guestPhone: undefined }));
    resetResultAndErrors();
  }

  function validateForm() {
    const errors: Partial<Record<keyof GuestInspectionInput, string>> = {};
    if (!governorateId) errors.governorateId = "اختر المحافظة.";
    if (!regionId) errors.regionId = "اختر المنطقة.";
    if (!providersLoading && !providersError && providers.length > 0 && !selectedProviderId) {
      errors.providerId = "اختر مزوداً للمتابعة.";
    }
    if (!guestName.trim()) errors.guestName = "أدخل الاسم.";
    if (!guestPhone.trim()) errors.guestPhone = "أدخل رقم الهاتف.";
    else if (!/^\+[1-9]\d{1,14}$/.test(guestPhone.trim())) errors.guestPhone = "أدخل الهاتف بصيغة دولية تبدأ بعلامة +.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0 && !providersLoading && !providersError;
  }

  function openConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!validateForm()) {
      const firstError = document.querySelector<HTMLElement>(".field-error");
      firstError?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setTermsAccepted(false);
    dialogRef.current?.showModal();
  }

  async function submitConfirmed() {
    if (!termsAccepted || postInFlight.current) return;
    postInFlight.current = true;
    setSubmitting(true);
    setFormError("");
    setFieldErrors({});
    const input: GuestInspectionInput = {
      governorateId,
      regionId,
      providerId: providers.length === 0 ? null : selectedProviderId,
      guestName: guestName.trim(),
      guestPhone: guestPhone.trim(),
      acceptedTerms: true,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch("/api/guest-inspection/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (response.status === 409) {
        dialogRef.current?.close();
        setProvidersError("");
        setSelectedProviderId(null);
        setFormError("تغيّر توفر المزودين. حدّثنا الخيارات؛ اختر من جديد ثم أكّد الطلب.");
        await loadProviders(governorateId, regionId);
        return;
      }
      const data = await readJson<GuestInspectionResult>(response);
      dialogRef.current?.close();
      setResult(data);
      setPhase("success");
      setTermsAccepted(false);
    } catch (error) {
      dialogRef.current?.close();
      const failure = error as ApiFailure;
      if (failure.status === 422 && failure.payload?.fields) {
        setFieldErrors(failure.payload.fields);
        setFormError("يرجى مراجعة البيانات الموضحة.");
      } else if (failure.status === 500 || failure.status === 503) {
        setFormError("حدث خطأ أثناء تسجيل الطلب. حاول مرة أخرى.");
      } else if (failure.status) {
        setFormError(failure.payload?.error || "تعذر تسجيل الطلب. تحقق من البيانات وحاول مرة أخرى.");
      } else {
        setPhase("unknown");
        setFormError("تعذر معرفة نتيجة الإرسال. قد يكون الطلب قد سُجّل؛ لم تتم إعادة المحاولة تلقائياً.");
      }
    } finally {
      clearTimeout(timer);
      postInFlight.current = false;
      setSubmitting(false);
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Tab") {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function startOver() {
    setPhase("form");
    setResult(null);
    setFormError("");
    setFieldErrors({});
  }

  if (phase === "success" && result) {
    const noMatch = result.matchingStatus === "no_match";
    return (
      <section className="guest-result" aria-live="polite" aria-labelledby="guest-result-title">
        <span className={`result-symbol${noMatch ? " result-symbol-muted" : ""}`} aria-hidden="true">{noMatch ? "i" : "✓"}</span>
        <p className="guest-kicker">نتيجة الطلب</p>
        <h1 id="guest-result-title">{noMatch ? "تم تسجيل طلبك" : "تم تسجيل طلبك للمزود"}</h1>
        {noMatch ? (
          <p className="result-no-match">
            لا يوجد مزود مطابق في نطاقك.{result.contactPhone ? <> يمكنك التواصل معنا على {phoneDisplay(result.contactPhone)}</> : null}
          </p>
        ) : (
          <p className="result-provider">{result.provider?.businessName ?? "تم تسجيل الطلب للمزود المختار."}</p>
        )}
        <div className="result-note">
          <strong>للتوضيح</strong>
          <p>{noMatch ? "هذا الإصدار يسجل الطلب فقط، ولا يرسل رسالة واتساب." : "هذا الإصدار يسجل الطلب وإشعار المزود فقط، ولا يرسل رسالة واتساب."}</p>
          {result.provider?.phone && <p>هاتف المزود: {phoneDisplay(result.provider.phone)}</p>}
        </div>
        <button className="guest-button guest-button-primary result-action" type="button" onClick={startOver}>طلب فحص آخر</button>
      </section>
    );
  }

  if (phase === "unknown") {
    return (
      <section className="guest-result guest-result-warning" aria-live="assertive" aria-labelledby="guest-result-title">
        <span className="result-symbol result-symbol-warning" aria-hidden="true">!</span>
        <p className="guest-kicker">تعذّر تأكيد النتيجة</p>
        <h1 id="guest-result-title">لم نتمكن من معرفة حالة الطلب</h1>
        <p>{formError}</p>
        <p className="unknown-advice">لتجنب إنشاء طلب مكرر، لا نعيد الإرسال تلقائياً.</p>
        <button className="guest-button guest-button-secondary result-action" type="button" onClick={startOver}>العودة إلى النموذج</button>
      </section>
    );
  }

  return (
    <div className="guest-inspection">
      <header className="guest-page-heading">
        <div className="guest-heading-mark" aria-hidden="true">ف</div>
        <div>
          <p className="guest-kicker">طلب ضيف · فحص مركبة</p>
          <h1>اعثر على مزود فحص في منطقتك</h1>
          <p className="guest-lede">اختر نطاق الخدمة، ثم أرسل بيانات التواصل بعد مراجعة التفاصيل.</p>
        </div>
      </header>

      <div className="guest-progress" aria-label="خطوات الطلب">
        <span className="progress-step is-current"><i>١</i> الموقع</span>
        <span className="progress-line" aria-hidden="true" />
        <span className={`progress-step${regionId ? " is-current" : ""}`}><i>٢</i> المزود</span>
        <span className="progress-line" aria-hidden="true" />
        <span className="progress-step"><i>٣</i> التأكيد</span>
      </div>

      <form className="guest-form" onSubmit={openConfirmation} noValidate>
        <section className="form-section" aria-labelledby="location-heading">
          <div className="section-heading">
            <span className="section-index">١</span>
            <div><h2 id="location-heading">أين تحتاج الفحص؟</h2><p>اختر المحافظة والمنطقة التابعة لها.</p></div>
          </div>
          <div className="field-grid">
            <div className="guest-field">
              <label htmlFor="governorate">المحافظة <span className="required-mark">مطلوب</span></label>
              <select id="governorate" value={governorateId} onChange={(event) => handleGovernorateChange(event.target.value)} disabled={localitiesLoading && !localities} aria-describedby={fieldErrors.governorateId ? "governorate-error" : undefined}>
                <option value="">اختر المحافظة</option>
                {(localities?.governorates ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              {fieldErrors.governorateId && <span className="field-error" id="governorate-error">{fieldErrors.governorateId}</span>}
              {localitiesLoading && !localities && <span className="field-hint">جارٍ تحميل المحافظات…</span>}
              {localitiesError && <span className="field-error" role="alert">{localitiesError} <button type="button" className="inline-action" onClick={() => void loadLocalities(governorateId)}>إعادة المحاولة</button></span>}
            </div>
            <div className="guest-field">
              <label htmlFor="region">المنطقة <span className="required-mark">مطلوب</span></label>
              <select id="region" value={regionId} onChange={(event) => handleRegionChange(event.target.value)} disabled={!governorateId || localitiesLoading || !!localitiesError || visibleRegions.length === 0} aria-describedby={fieldErrors.regionId ? "region-error" : undefined}>
                <option value="">اختر المنطقة</option>
                {visibleRegions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              {fieldErrors.regionId && <span className="field-error" id="region-error">{fieldErrors.regionId}</span>}
              {governorateId && !localitiesLoading && !localitiesError && visibleRegions.length === 0 && <span className="field-hint">لا توجد مناطق متاحة لهذه المحافظة.</span>}
            </div>
          </div>
        </section>

        {regionId && (
          <section className="form-section providers-section" aria-labelledby="providers-heading">
            <div className="section-heading">
              <span className="section-index">٢</span>
              <div><h2 id="providers-heading">مزودو الفحص في النطاق</h2><p>المعلومات التالية للتعريف فقط؛ القدرات لا تُستخدم لتصفية الاختيار.</p></div>
            </div>
            {providersLoading ? (
              <div className="provider-skeletons" aria-label="جارٍ تحميل المزودين">
                <div /><div />
              </div>
            ) : providersError ? (
              <div className="inline-error" role="alert">
                <p>{providersError}</p>
                <button type="button" className="guest-button guest-button-secondary" onClick={() => void loadProviders(governorateId, regionId)}>إعادة تحميل المزودين</button>
              </div>
            ) : providers.length > 0 ? (
              <div className="provider-list" role="radiogroup" aria-label="اختيار مزود الفحص" aria-describedby={fieldErrors.providerId ? "provider-error" : undefined}>
                {providers.map((provider) => (
                  <ProviderCard key={provider.id} provider={provider} selected={selectedProviderId === provider.id} onSelect={() => {
                    setSelectedProviderId(provider.id);
                    setFieldErrors((current) => ({ ...current, providerId: undefined }));
                    resetResultAndErrors();
                  }} />
                ))}
              </div>
            ) : (
              <div className="no-provider-inline">
                <span className="no-provider-mark" aria-hidden="true">i</span>
                <div><strong>لا يوجد مزود مطابق في نطاقك.</strong>
                  {contactPhone && <p>يمكنك التواصل معنا على {phoneDisplay(contactPhone)}</p>}
                  <p>يمكنك إرسال طلبك دون اختيار مزود.</p>
                </div>
              </div>
            )}
            {fieldErrors.providerId && <span className="field-error provider-error" id="provider-error">{fieldErrors.providerId}</span>}
          </section>
        )}

        <section className="form-section guest-details-section" aria-labelledby="identity-heading">
          <div className="section-heading">
            <span className="section-index">٣</span>
            <div><h2 id="identity-heading">بيانات التواصل</h2><p>سنستخدمها لهذا الطلب فقط.</p></div>
          </div>
          <div className="field-grid">
            <div className="guest-field">
              <label htmlFor="guest-name">الاسم <span className="required-mark">مطلوب</span></label>
              <input id="guest-name" name="guestName" autoComplete="name" value={guestName} onChange={(event) => changeGuestName(event.target.value)} aria-invalid={!!fieldErrors.guestName} aria-describedby={fieldErrors.guestName ? "guest-name-error" : undefined} placeholder="الاسم الكامل" />
              {fieldErrors.guestName && <span className="field-error" id="guest-name-error">{fieldErrors.guestName}</span>}
            </div>
            <div className="guest-field">
              <label htmlFor="guest-phone">رقم الهاتف <span className="required-mark">مطلوب</span></label>
              <input id="guest-phone" name="guestPhone" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" value={guestPhone} onChange={(event) => changeGuestPhone(event.target.value)} aria-invalid={!!fieldErrors.guestPhone} aria-describedby={`phone-disclosure guest-phone-hint${fieldErrors.guestPhone ? " guest-phone-error" : ""}`} placeholder="+963 9xx xxx xxx" />
              {fieldErrors.guestPhone && <span className="field-error" id="guest-phone-error">{fieldErrors.guestPhone}</span>}
              <span className="field-hint" id="guest-phone-hint">أدخل الرقم الذي يمكن للمزود التواصل معك عليه.</span>
            </div>
          </div>
          <div className="contact-disclosure" id="phone-disclosure">
            <span className="disclosure-mark" aria-hidden="true">i</span>
            <p>{providers.length ? "سيُرسَل رقمك للمزود لكي يتواصل معك." : "سيُحفظ اسمك ورقمك مع طلب الفحص."}</p>
          </div>
        </section>

        {formError && <p className="form-message" role="alert">{formError}</p>}
        <div className="form-footer">
          <p>لن يتم تسجيل الطلب إلا بعد مراجعتك للتفاصيل والضغط على التأكيد.</p>
          <button className="guest-button guest-button-primary submit-button" type="submit" disabled={submitting || localitiesLoading || !!localitiesError || !localities || (!!regionId && (providersLoading || !!providersError))}>
            {submitting ? "جارٍ تسجيل الطلب…" : "مراجعة الطلب"}
            <span aria-hidden="true">←</span>
          </button>
        </div>
      </form>

      <dialog
        className="confirmation-dialog"
        ref={dialogRef}
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-description"
        onKeyDown={handleDialogKeyDown}
        onCancel={(event) => { if (postInFlight.current) event.preventDefault(); }}
        onClose={() => { if (!postInFlight.current) setTermsAccepted(false); }}
      >
        <div className="dialog-topline"><span>مراجعة أخيرة</span><button type="button" className="dialog-close" aria-label="إلغاء وإغلاق" onClick={() => dialogRef.current?.close()} disabled={submitting}>×</button></div>
        <h2 id="confirmation-title">تأكيد إرسال طلب الفحص</h2>
        <p id="confirmation-description" className="dialog-intro">راجع النطاق وبيانات التواصل قبل التسجيل.</p>
        <dl className="confirmation-summary">
          <div><dt>الموقع</dt><dd>{localities?.governorates.find((item) => item.id === governorateId)?.name}، {regions.find((item) => item.id === regionId)?.name}</dd></div>
          <div><dt>المزود</dt><dd>{providers.length === 0 ? "لا يوجد مزود مطابق في النطاق" : providers.find((item) => item.id === selectedProviderId)?.businessName}</dd></div>
          <div><dt>الاسم</dt><dd>{guestName.trim()}</dd></div>
          <div><dt>الهاتف</dt><dd>{phoneDisplay(guestPhone.trim())}</dd></div>
        </dl>
        <div className="dialog-disclosure">
          <strong>مشاركة بيانات التواصل</strong>
          <p>{providers.length ? "سيُرسَل رقمك للمزود لكي يتواصل معك." : "سيُحفظ اسمك ورقمك مع طلب الفحص."}</p>
        </div>
        <div className="implementation-note">
          <strong>ماذا يحدث بعد التأكيد؟</strong>
          <p>{providers.length === 0 ? "يسجل هذا الإصدار الطلب فقط، ولا يرسل رسالة واتساب." : "يسجل هذا الإصدار الطلب وإشعار المزود فقط، ولا يرسل رسالة واتساب."}</p>
        </div>
        <label className="terms-check">
          <input type="checkbox" checked={termsAccepted} disabled={submitting} onChange={(event) => setTermsAccepted(event.target.checked)} />
          <span>أوافق على شروط الاستخدام وحفظ بيانات التواصل لهذا الطلب.</span>
        </label>
        <div className="dialog-actions">
          <button type="button" className="guest-button guest-button-secondary" onClick={() => dialogRef.current?.close()} disabled={submitting}>إلغاء</button>
          <button type="button" className="guest-button guest-button-primary" onClick={() => void submitConfirmed()} disabled={!termsAccepted || submitting}>
            {submitting ? "جارٍ التسجيل…" : "تأكيد وتسجيل الطلب"}
          </button>
        </div>
      </dialog>
    </div>
  );
}