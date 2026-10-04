"use client";

import "./provider.css";
import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useParams } from "next/navigation";
import type { ProviderNotification, ProviderProfile, ProviderReferences } from "../contracts";
import { ProviderApiError } from "../client";
import { useProviderLogin, useProviderLogout, useProviderNotification, useProviderNotifications, useProviderSession } from "./use-provider";

type Session = { profile: ProviderProfile; references: ProviderReferences };
const SessionContext = createContext<Session | null>(null);
function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Provider shell is missing");
  return value;
}

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function safeReference(value: string | null | undefined, entries: { id: string; name: string }[], fallback = "غير متاح") {
  if (!value) return fallback;
  const found = entries.find(entry => entry.id === value);
  if (found) return found.name;
  return isUuid(value) ? fallback : value;
}
const serviceName = (serviceType: "inspection" | "towing") => serviceType === "inspection" ? "فحص مركبة" : "سطحة";
function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "وقت غير متاح";
  return new Intl.DateTimeFormat("ar-SY", { timeZone: "Asia/Damascus", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

export function ProviderShell({ children }: { children: ReactNode }) {
  const { data, loading, error, retry, sessionFailed } = useProviderSession();
  const { logout, loading: loggingOut } = useProviderLogout();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  useEffect(() => { if (sessionFailed) router.replace("/provider/login"); }, [sessionFailed, router]);
  const leave = async () => {
    setLeaving(true);
    try { await logout(); } catch (error) {
      if (!(error instanceof ProviderApiError && (error.status === 401 ||
        (error.status === 403 && error.message === "حساب المزود غير متاح للدخول.")))) {
        setLogoutError("تعذّر تسجيل الخروج. حاول مجدداً."); setLeaving(false); return;
      }
    }
    router.replace("/provider/login");
  };
  if (sessionFailed || leaving) return null;
  if (loading) return <div className="provider-app" dir="rtl"><main className="provider-frame" aria-busy="true" aria-label="جارٍ تحميل بيانات المركز"><div className="provider-skeleton" /><div style={{ height: 18 }} /><div className="provider-skeleton" /></main></div>;
  if (error || !data) return <div className="provider-app" dir="rtl"><main className="provider-frame"><StatusError title="تعذّر التحقق من جلسة المركز" onRetry={retry} /></main></div>;
  return <div className="provider-app" dir="rtl">
    <header className="provider-topbar">
      <Link className="provider-brand" href="/provider" aria-label="الرئيسية">
        <span className="provider-mark" aria-hidden="true">SC</span>
        <span className="provider-brand-copy"><strong>Syriacar</strong><small>بوابة مراكز الخدمة</small></span>
      </Link>
      <div className="provider-topbar-end">
        <span className="provider-role">حساب مركز</span>
        <button className="provider-logout" type="button" onClick={leave} disabled={loggingOut}>{loggingOut ? "جارٍ الخروج…" : "تسجيل الخروج"}</button>
      </div>
    </header>
    <main className="provider-frame">
      <ProviderNavigation />
      {logoutError && <p role="alert">{logoutError}</p>}
      <SessionContext.Provider value={data}>{children}</SessionContext.Provider>
      <footer style={{ marginTop: 40, color: "var(--p-muted)", fontSize: 12, textAlign: "center" }}>Syriacar · مساحة مخصصة لمراكز الخدمة</footer>
    </main>
  </div>;
}

function ProviderNavigation() {
  const pathname = usePathname();
  return <nav className="provider-nav" aria-label="التنقل الرئيسي">
    <Link href="/provider" aria-current={pathname === "/provider" ? "page" : undefined}>بيانات المركز</Link>
    <Link href="/provider/notifications" aria-current={pathname.startsWith("/provider/notifications") ? "page" : undefined}>إشعارات العملاء</Link>
  </nav>;
}

function StatusError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return <section className="provider-panel provider-error" role="alert"><h2>{title}</h2><p>يمكنك المحاولة مرة أخرى بعد قليل.</p><button className="provider-button secondary" type="button" onClick={onRetry}>إعادة المحاولة</button></section>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="provider-detail"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function ProviderProfilePage() {
  const { profile, references } = useSession();
  const governorates = useMemo(() => references.governorates.map(({ id, name }) => ({ id, name })), [references.governorates]);
  const regions = useMemo(() => references.regions.map(({ id, name }) => ({ id, name })), [references.regions]);
  const towTypes = useMemo(() => references.towTypes.map(({ id, name }) => ({ id, name })), [references.towTypes]);
  const coverageNames = profile.coverage.map(item => safeReference(item, governorates)).filter(item => item !== "غير متاح");
  return <section className="provider-content">
    <header className="provider-heading"><p className="provider-kicker">ملف المركز</p><h1>بيانات مركزك</h1><p>معلومات مرجعية للعرض فقط.</p></header>
    <div className="provider-profile-banner">
      <div><p className="provider-kicker">مركز خدمة</p><h2>{safeReference(profile.businessName, [])}</h2><p>{serviceName(profile.serviceType)}</p></div>
      <span className="provider-status">حساب نشط</span>
    </div>
    <dl className="provider-panel provider-details">
      <Detail label="رقم الهاتف"><span dir="ltr">{profile.phone && !isUuid(profile.phone) ? profile.phone : "غير متاح"}</span></Detail>
      <Detail label="نوع الخدمة">{serviceName(profile.serviceType)}</Detail>
      <Detail label="المحافظة">{safeReference(profile.governorate, governorates)}</Detail>
      <Detail label="المنطقة">{safeReference(profile.region, regions)}</Detail>
      {profile.serviceType === "towing" && <Detail label="نوع السطحة">{safeReference(profile.towType, towTypes)}</Detail>}
      {profile.serviceType === "towing" && <Detail label="المحافظات المغطاة">
        {coverageNames.length ? <div className="provider-coverages">{coverageNames.map((name, index) => <span className="provider-chip" key={`${name}-${index}`}>{name}</span>)}</div> : "غير متاح"}
      </Detail>}
    </dl>
  </section>;
}

function NotificationCard({ notification }: { notification: ProviderNotification }) {
  return <Link className="provider-panel provider-notice" href={`/provider/notifications/${encodeURIComponent(notification.id)}`}>
    <span className="provider-notice-main">
      <span className="provider-notice-title">{notification.customerName && !isUuid(notification.customerName) ? notification.customerName : "غير متاح"}<span className="provider-service-tag">{serviceName(notification.serviceType)}</span></span>
      <span className="provider-notice-meta"><span>{safeReference(notification.context.governorate, [])}</span><span>{notification.customerType === "guest" ? "زائر" : "مسجل"}</span></span>
    </span>
    <time className="provider-date" dateTime={notification.createdAt}>{formatDate(notification.createdAt)}</time>
    <span className="provider-arrow" aria-hidden="true">←</span>
  </Link>;
}

export function ProviderNotificationsPage() {
  const { items, cursor, loading, loadingMore, error, sessionFailed, retry, loadMore } = useProviderNotifications();
  const router = useRouter();
  useEffect(() => { if (sessionFailed) router.replace("/provider/login"); }, [sessionFailed, router]);
  if (sessionFailed) return null;
  return <section className="provider-content">
    <header className="provider-heading"><p className="provider-kicker">الوارد</p><h1>إشعارات العملاء</h1><p>طلبات اطلاع فقط، مرتبة من الأحدث إلى الأقدم.</p></header>
    {loading ? <div className="provider-list" aria-busy="true" aria-label="جارٍ تحميل الإشعارات">{[0, 1, 2].map(item => <div className="provider-skeleton" key={item} />)}</div>
      : error ? <StatusError title="تعذّر تحميل الإشعارات" onRetry={retry} />
      : items.length === 0 ? <section className="provider-panel provider-empty"><span className="provider-empty-mark" aria-hidden="true">—</span><h2>لا توجد إشعارات حالياً</h2><p>ستظهر هنا طلبات العملاء الموجّهة إلى مركزك.</p></section>
      : <div className="provider-list">{items.map(item => <NotificationCard key={item.id} notification={item} />)}</div>}
    {!loading && !error && cursor && <div className="provider-actions"><button className="provider-button secondary" type="button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? <><span className="provider-spin" aria-hidden="true" /> جارٍ التحميل…</> : "تحميل المزيد"}</button></div>}
  </section>;
}

function ContextValue({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <div className="provider-context-item"><span>{label}</span><strong>{value === null || value === undefined || value === "" ? "غير متاح" : value}</strong></div>;
}

export function ProviderNotificationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const { data, loading, error, retry, sessionFailed } = useProviderNotification(id);
  const { references } = useSession();
  const router = useRouter();
  useEffect(() => { if (sessionFailed) router.replace("/provider/login"); }, [sessionFailed, router]);
  if (sessionFailed) return null;
  if (loading) return <div className="provider-content" aria-busy="true"><div className="provider-skeleton" /></div>;
  if (error || !data) return <div className="provider-content"><StatusError title="تعذّر تحميل الإشعار" onRetry={retry} /></div>;
  const { context } = data;
  const governorates = references.governorates.map(({ id: refId, name }) => ({ id: refId, name }));
  const regions = references.regions.map(({ id: refId, name }) => ({ id: refId, name }));
  return <section className="provider-content">
    <Link className="provider-back" href="/provider/notifications">→ العودة إلى الإشعارات</Link>
    <header className="provider-heading"><p className="provider-kicker">تفاصيل الإشعار</p><h1>{serviceName(data.serviceType)}</h1><p><time dateTime={data.createdAt}>{formatDate(data.createdAt)}</time></p></header>
    <div className="provider-detail-layout">
      <section className="provider-panel provider-request-card"><h2>سياق الطلب</h2>
        <div className="provider-context-grid">
          <ContextValue label="الخدمة" value={serviceName(data.serviceType)} />
          <ContextValue label="المحافظة" value={safeReference(context.governorate, governorates)} />
          <ContextValue label="المنطقة" value={safeReference(context.region, regions)} />
          <ContextValue label="نقطة الانطلاق" value={context.origin && !isUuid(context.origin) ? context.origin : "غير متاح"} />
          <ContextValue label="الوجهة" value={context.destination && !isUuid(context.destination) ? context.destination : "غير متاح"} />
          <ContextValue label="المركبة" value={context.vehicle?.brand && !isUuid(context.vehicle.brand) ? context.vehicle.brand : "غير متاح"} />
          <ContextValue label="سنة الصنع" value={context.vehicle?.year} />
          <ContextValue label="الفئة" value={context.vehicle?.category === "car" ? "سيارة" : context.vehicle?.category === "truck" ? "شاحنة" : "غير متاح"} />
          <ContextValue label="الوقود" value={context.vehicle?.fuel && !isUuid(context.vehicle.fuel) ? context.vehicle.fuel : "غير متاح"} />
        </div>
      </section>
      <aside className="provider-panel provider-customer"><h2>بيانات العميل</h2>
        <div className="provider-customer-row"><span>الاسم</span><strong>{data.customerName && !isUuid(data.customerName) ? data.customerName : "غير متاح"}</strong></div>
        <div className="provider-customer-row"><span>رقم الهاتف</span><strong dir="ltr">{data.customerPhone && !isUuid(data.customerPhone) ? data.customerPhone : "غير متاح"}</strong></div>
        <div className="provider-customer-row"><span>نوع الحساب</span><strong>{data.customerType === "guest" ? "زائر" : "مسجل"}</strong></div>
      </aside>
    </div>
  </section>;
}

export function ProviderLoginPage() {
  const router = useRouter();
  const { login, loading, error } = useProviderLogin();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await login(phone.trim(), password)) router.replace("/provider");
  };
  return <div className="provider-app provider-login-page" dir="rtl">
    <div className="provider-login-wrap">
      <div className="provider-login-brand"><span className="provider-mark" aria-hidden="true">SC</span><div className="provider-brand-copy"><strong>Syriacar</strong><small>بوابة مراكز الخدمة</small></div></div>
      <form className="provider-panel provider-login-card" onSubmit={submit}>
        <p className="provider-kicker">دخول آمن للمركز</p><h1>مرحباً بعودتك</h1><p>سجّل الدخول لمتابعة إشعارات العملاء ومعلومات مركزك.</p>
        <div className="provider-field"><label htmlFor="provider-phone">رقم الهاتف</label><input id="provider-phone" name="phone" type="tel" autoComplete="username" inputMode="tel" dir="ltr" placeholder="+963…" value={phone} onChange={event => setPhone(event.target.value)} required /><small>بصيغة +963 ثم الرقم.</small></div>
        <div className="provider-field"><label htmlFor="provider-password">كلمة المرور</label><input id="provider-password" name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></div>
        {error && <p className="provider-login-error" role="alert">{error}</p>}
        <button className="provider-button provider-login-submit" type="submit" disabled={loading}>{loading ? <><span className="provider-spin" aria-hidden="true" /> جارٍ التحقق…</> : "تسجيل الدخول"}</button>
        <p className="provider-login-foot">هذه البوابة مخصصة لمراكز الفحص والسحب.</p>
      </form>
    </div>
  </div>;
}