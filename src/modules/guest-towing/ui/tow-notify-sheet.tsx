"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { TowingProvider } from "../contracts";
import { towingWarning } from "../contracts";

type Props = {
  provider: TowingProvider;
  originName: string;
  destinationName: string;
  guestName: string;
  guestPhone: string;
  identityLocked: boolean;
  submitting: boolean;
  formError: string;
  fieldErrors: Partial<Record<"guestName" | "guestPhone", string>>;
  onIdentityChange: (name: string, phone: string) => void;
  onConfirm: (name: string, phone: string) => void;
  onCancel: () => void;
};

export default function TowNotifySheet({
  provider, originName, destinationName, guestName, guestPhone, identityLocked, submitting,
  formError, fieldErrors, onIdentityChange, onConfirm, onCancel,
}: Props) {
  const [name, setName] = useState(guestName);
  const [phone, setPhone] = useState(guestPhone);
  const [step, setStep] = useState<"details" | "review">(identityLocked ? "review" : "details");
  const [accepted, setAccepted] = useState(false);
  const [localErrors, setLocalErrors] = useState<Partial<Record<"guestName" | "guestPhone", string>>>({});
  const backdropRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheetRef.current?.querySelector<HTMLElement>("input, button")?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onCancel();
      if (event.key === "Tab") {
        const controls = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), a[href]",
        ) ?? []);
        const first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !sheetRef.current?.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !sheetRef.current?.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (identityLocked) {
      setStep("review");
      return;
    }
    const errors: Partial<Record<"guestName" | "guestPhone", string>> = {};
    if (!name.trim()) errors.guestName = "أدخل الاسم.";
    if (!phone.trim()) errors.guestPhone = "أدخل رقم الهاتف.";
    else if (!/^\+[1-9]\d{1,14}$/.test(phone.trim())) errors.guestPhone = "أدخل الهاتف بصيغة دولية تبدأ بعلامة +.";
    setLocalErrors(errors);
    if (Object.keys(errors).length === 0) {
      onIdentityChange(name.trim(), phone.trim());
      setAccepted(false);
      setStep("review");
    }
  }

  return (
    <div className="tow-sheet-backdrop" ref={backdropRef} onMouseDown={(event) => { if (event.target === backdropRef.current && !submitting) onCancel(); }}>
      <section ref={sheetRef} className="tow-sheet" role="dialog" aria-modal="true" aria-labelledby="tow-sheet-title">
        <div className="tow-sheet-top">
          <span>{step === "details" ? "بيانات التواصل" : "مراجعة أخيرة"}</span>
          <button className="tow-sheet-close" type="button" onClick={onCancel} aria-label="إلغاء وإغلاق" disabled={submitting}>×</button>
        </div>
        <p className="tow-warning">{towingWarning}</p>
        {step === "details" ? (
          <>
            <h2 id="tow-sheet-title">أبلغ {provider.businessName}</h2>
            <p className="tow-sheet-intro">أدخل بيانات التواصل أولًا، ثم راجع ما سيُسجَّل قبل التأكيد.</p>
            <form onSubmit={review} noValidate>
              <div className="tow-field">
                <label htmlFor="guest-name">الاسم <span className="tow-required">مطلوب</span></label>
                <input id="guest-name" name="guestName" autoComplete="name" value={name} onChange={(event) => {
                  const value = event.target.value;
                  setName(value);
                  onIdentityChange(value, phone);
                  setLocalErrors((current) => ({ ...current, guestName: undefined }));
                }} aria-invalid={!!(localErrors.guestName || fieldErrors.guestName)} />
                {(localErrors.guestName || fieldErrors.guestName) && <span className="tow-error">{localErrors.guestName || fieldErrors.guestName}</span>}
              </div>
              <div className="tow-field" style={{ marginBlockStart: 14 }}>
                <label htmlFor="guest-phone">رقم الهاتف <span className="tow-required">مطلوب</span></label>
                <input id="guest-phone" name="guestPhone" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" placeholder="+963 9xx xxx xxx" value={phone} onChange={(event) => {
                  const value = event.target.value;
                  setPhone(value);
                  onIdentityChange(name, value);
                  setLocalErrors((current) => ({ ...current, guestPhone: undefined }));
                }} aria-invalid={!!(localErrors.guestPhone || fieldErrors.guestPhone)} />
                {(localErrors.guestPhone || fieldErrors.guestPhone) && <span className="tow-error">{localErrors.guestPhone || fieldErrors.guestPhone}</span>}
                <span className="tow-hint">أدخل رقمًا دوليًا يبدأ بعلامة +.</span>
              </div>
              <div className="tow-disclosure" style={{ marginBlockStart: 17 }}>
                <strong>مشاركة بيانات التواصل</strong>
                <p>سيُرسَل اسمك ورقمك للمزود ويُحفظان مع الطلب والإشعار.</p>
              </div>
              {formError && <p className="tow-error" role="alert">{formError}</p>}
              <div className="tow-sheet-actions">
                <button type="button" className="tow-button tow-button-secondary" onClick={onCancel} disabled={submitting}>إلغاء</button>
                <button type="submit" className="tow-button tow-button-primary" data-testid="review">مراجعة الطلب</button>
              </div>
            </form>
          </>
        ) : (
          <>
            <h2 id="tow-sheet-title">تأكيد إشعار المزود</h2>
            <p className="tow-sheet-intro">راجع المسار وبيانات التواصل قبل تسجيل الإشعار.</p>
            <dl className="tow-review-summary">
              <div><dt>مسار السطحة</dt><dd>{originName} ← {destinationName}</dd></div>
              <div><dt>المزود</dt><dd>{provider.businessName}</dd></div>
              <div><dt>الاسم</dt><dd>{name.trim() || guestName}</dd></div>
              <div><dt>الهاتف</dt><dd><span className="tow-phone">{phone.trim() || guestPhone}</span></dd></div>
            </dl>
            <div className="tow-disclosure">
              <strong>مشاركة بيانات التواصل</strong>
              <p>سيُرسَل الاسم ورقم الهاتف للمزود ويُحفظان مع الطلب والإشعار.</p>
            </div>
            <div className="tow-implementation">
              <strong>ما الذي يحدث بعد التأكيد؟</strong>
              <p>يسجل النظام الطلب وإشعار المزود في قاعدة البيانات فقط. لم تُرسل المنصة رسالة واتساب؛ يمكنك فتح واتساب وإرسالها بنفسك بعد التسجيل.</p>
            </div>
            {formError && <p className="tow-error" role="alert">{formError}</p>}
            <label className="tow-terms">
              <input className="terms-check" data-testid="terms-check" type="checkbox" checked={accepted} disabled={submitting} onChange={(event) => setAccepted(event.target.checked)} />
              <span>أوافق على شروط الاستخدام ومشاركة بيانات التواصل وحفظها لهذا الطلب.</span>
            </label>
            <div className="tow-sheet-actions">
              <button type="button" className="tow-button tow-button-secondary" onClick={() => { if (identityLocked) onCancel(); else setStep("details"); }} disabled={submitting}>رجوع</button>
              <button type="button" className="tow-button tow-button-primary" data-testid="confirm" onClick={() => onConfirm(name.trim() || guestName, phone.trim() || guestPhone)} disabled={!accepted || submitting}>
                {submitting ? "جارٍ تسجيل الإشعار…" : "تأكيد وتسجيل الإشعار"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}