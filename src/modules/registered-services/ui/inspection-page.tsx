"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Vehicle, Profile } from "../../account/contracts";
import type { RegisteredProvider, RegisteredProviders, Confirmation } from "../contracts";
import { coordinates } from "../contracts";
import { AccessibleSheet, expireRegisteredSession, genericServiceError, serviceRequest, type Locality, type ServiceError } from "./service-common";
import "./registered-services.css";

function FailedMap({ onMapFailure }: { onMapFailure: () => void }) {
  const fail = useRef(onMapFailure);
  useEffect(() => { fail.current(); }, []);
  return null;
}
const InspectionMap = dynamic(() => import("./inspection-map").catch(() => ({ default: FailedMap })), {
  ssr: false,
  loading: () => <div className="rs-map rs-skeleton" aria-label="جارٍ تحميل الخريطة"><i/><i/><i/></div>,
});

type LocalitiesResult = { governorates: Locality[]; regions: Locality[] };
type Stage = "selection" | "results";
type SheetMode = "details" | "confirm-provider" | "confirm-empty";

function displayUnknown(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(displayUnknown);
  if (value && typeof value === "object") return Object.values(value).flatMap(displayUnknown);
  return [];
}
function category(value: string) {
  return value === "classic" ? "كلاسيكية" : value === "mid" ? "متوسطة" : value === "modern" ? "حديثة" : value;
}
function renderTags(values: string[], empty = "غير محدد") {
  return values.length ? <div className="rs-tag-list">{values.map((value,index)=><span className="rs-tag" key={`${value}-${index}`}>{value}</span>)}</div> : <span className="rs-muted">{empty}</span>;
}

export default function InspectionPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [localities, setLocalities] = useState<LocalitiesResult | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState("");
  const [regionsLoading, setRegionsLoading] = useState(false);
  const [regionsError, setRegionsError] = useState("");
  const [regionsRetry, setRegionsRetry] = useState(0);
  const [governorateId, setGovernorateId] = useState("");
  const [regionId, setRegionId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [stage, setStage] = useState<Stage>("selection");
  const [providers, setProviders] = useState<RegisteredProviders | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState("");
  const [mapMode, setMapMode] = useState<"loading" | "ready" | "fallback">("loading");
  const [sheetProvider, setSheetProvider] = useState<RegisteredProvider | null>(null);
  const [sheetMode, setSheetMode] = useState<SheetMode>("details");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [gpsPoint, setGpsPoint] = useState<{lat:number;lng:number}|null>(null);
  const [gpsMessage, setGpsMessage] = useState("");
  const [gpsBusy, setGpsBusy] = useState(false);
  const generation = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);
  const mapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const contextRequestId = useRef<string | null>(null);
  const gpsGeneration = useRef(0);
  const selectedVehicle = useMemo(() => vehicles?.find(item => item.id === vehicleId) ?? null, [vehicles, vehicleId]);
  const governorateName = localities?.governorates.find(item=>item.id===governorateId)?.name ?? "";
  const regionName = localities?.regions.find(item=>item.id===regionId)?.name ?? "";

  const handleExpired = useCallback(() => expireRegisteredSession(router), [router]);
  useEffect(() => {
    window.addEventListener("syriacar-account-expired", handleExpired);
    return () => window.removeEventListener("syriacar-account-expired", handleExpired);
  }, [handleExpired]);

  const loadBase = useCallback(async () => {
    setInitializing(true); setInitError("");
    try {
      const [account, ownedVehicles, localityData] = await Promise.all([
        serviceRequest<Profile>("/api/account/profile"),
        serviceRequest<Vehicle[]>("/api/account/vehicles"),
        serviceRequest<LocalitiesResult>("/api/guest-inspection/localities"),
      ]);
      setProfile(account); setVehicles(ownedVehicles); setLocalities(localityData);
    } catch (caught) {
      const error = caught as ServiceError;
      if (error.status === 401) expireRegisteredSession(router);
      else setInitError(error instanceof TypeError ? "تعذر الاتصال بالخدمة. تحقق من اتصالك ثم أعد المحاولة." : genericServiceError);
    } finally { setInitializing(false); }
  }, [router]);
  useEffect(() => { void loadBase(); return () => { requestAbort.current?.abort(); if(mapTimer.current)clearTimeout(mapTimer.current); }; }, [loadBase]);
  useEffect(() => {
    const controller = new AbortController();
    setLocalities(old => old ? { ...old, regions: [] } : old);
    setRegionsError(""); setRegionsLoading(false);
    if (!governorateId) return;
    setRegionsLoading(true);
    serviceRequest<LocalitiesResult>(`/api/guest-inspection/localities?${new URLSearchParams({ governorateId })}`,
      { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setLocalities(value); })
      .catch(error => { if (!controller.signal.aborted) setRegionsError(error.message || genericServiceError); })
      .finally(() => { if (!controller.signal.aborted) setRegionsLoading(false); });
    return () => controller.abort();
  }, [governorateId, regionsRetry]);

  function resetContext() {
    ++generation.current;
    ++gpsGeneration.current;
    requestAbort.current?.abort();
    if (mapTimer.current) clearTimeout(mapTimer.current);
    contextRequestId.current = null;
    setStage("selection"); setProviders(null); setProvidersError(""); setProvidersLoading(false);
    setConfirmation(null); setSheetProvider(null); setSheetMode("details"); setSubmitError("");
    setGpsPoint(null); setGpsMessage(""); setGpsBusy(false);
  }
  function updateGovernorate(value:string) {
    setGovernorateId(value); setRegionId(""); resetContext();
  }
  function updateRegion(value:string) { setRegionId(value); resetContext(); }
  function updateVehicle(value:string) { setVehicleId(value); resetContext(); }

  async function loadProviders() {
    if (!vehicleId || !governorateId || !regionId) return;
    const current = ++generation.current;
    if (mapTimer.current) clearTimeout(mapTimer.current);
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    setProvidersLoading(true); setProvidersError(""); setProviders(null); setConfirmation(null);
    setStage("results"); setMapMode("loading");
    try {
      const query = new URLSearchParams({vehicleId,governorateId,regionId});
      const result = await serviceRequest<RegisteredProviders>(`/api/inspection/providers?${query}`, {signal:controller.signal});
      if (current !== generation.current) return;
      setProviders(result);
      if (mapTimer.current) clearTimeout(mapTimer.current);
      mapTimer.current = setTimeout(() => setMapMode(mode => mode === "loading" ? "fallback" : mode), 5000);
    } catch (caught) {
      if (controller.signal.aborted || current !== generation.current) return;
      const error = caught as ServiceError;
      if (error.status === 401) { expireRegisteredSession(router); return; }
      setProvidersError(error.status === 422 ? (error.message || "تحقق من المركبة والمحلية المختارتين.") : genericServiceError);
      setStage("selection");
    } finally {
      if (current === generation.current) setProvidersLoading(false);
    }
  }
  function mapReady() {
    if (mapTimer.current) clearTimeout(mapTimer.current);
    setMapMode(current => current === "fallback" ? current : "ready");
  }
  function mapFailure() {
    if (mapTimer.current) clearTimeout(mapTimer.current);
    setMapMode("fallback");
  }
  function locate() {
    setGpsMessage("");
    if (!navigator.geolocation) { setGpsMessage("الموقع غير متاح على هذا الجهاز. يمكنك المتابعة باختيار المحلية."); return; }
    setGpsBusy(true);
    const currentGps = ++gpsGeneration.current;
    navigator.geolocation.getCurrentPosition(position => {
      if (currentGps !== gpsGeneration.current) return;
      const point = coordinates(position.coords.latitude,position.coords.longitude);
      setGpsPoint(point);
      setGpsBusy(false);
      if (!point) setGpsMessage("تعذر قراءة موقع صالح. اختر المحلية يدويًا.");
    }, () => {
      if (currentGps !== gpsGeneration.current) return;
      setGpsBusy(false); setGpsMessage("لم نتمكن من الوصول إلى موقعك. يمكنك المتابعة باختيار المحلية.");
    }, {enableHighAccuracy:false,timeout:8000,maximumAge:60000});
  }
  function openProvider(item:RegisteredProvider) {
    setSheetProvider(item); setSheetMode("details"); setAcceptedTerms(false); setSubmitError("");
  }
  function openNoMatchConfirmation() {
    setSheetProvider(null); setSheetMode("confirm-empty"); setAcceptedTerms(false); setSubmitError("");
  }
  async function submit(provider:RegisteredProvider|null) {
    if (busyRef.current || !acceptedTerms || !vehicleId || !governorateId || !regionId) return;
    busyRef.current = true; setBusy(true); setSubmitError("");
    const submittedGeneration = generation.current;
    const popup = provider ? window.open("about:blank","_blank") : null;
    if (popup) popup.opener = null;
    try {
      const response = await serviceRequest<Confirmation>("/api/inspection/requests", {
        method:"POST",
        body:JSON.stringify({
          vehicleId, governorateId, regionId, providerId:provider?.id ?? null, acceptedTerms:true,
          ...(contextRequestId.current ? {requestId:contextRequestId.current} : {}),
        }),
      });
      if (submittedGeneration !== generation.current) { popup?.close(); return; }
      contextRequestId.current = response.requestId;
      setConfirmation(response); setSheetProvider(null);
      setSheetMode("details");
      if (popup && response.whatsappUrl) popup.location.href = response.whatsappUrl;
      else popup?.close();
    } catch (caught) {
      popup?.close();
      if (submittedGeneration !== generation.current) return;
      const error = caught as ServiceError;
      if (error.status === 401) { expireRegisteredSession(router); return; }
      setSubmitError(error.status === 422 ? (error.message || "لم يعد هذا الاختيار متاحًا. حدّث النتائج ثم حاول.") : "تعذر تأكيد النتيجة. لم تتم إعادة المحاولة تلقائيًا؛ راجع الحالة قبل أي متابعة.");
    } finally { busyRef.current=false; setBusy(false); }
  }

  const suitable = providers?.providers.filter(item=>item.suitable) ?? [];
  const mapList = suitable.length === 0 ? [] : mapMode === "fallback" ? providers?.providers ?? [] :
    providers?.providers.filter(item=>!item.coordinates || !coordinates(item.coordinates.lat,item.coordinates.lng)) ?? [];
  const canSearch = !!selectedVehicle && !selectedVehicle.rejected && !!governorateId && !!regionId;

  return <main className="rs" dir="rtl">
    <header className="rs-header"><Link className="rs-brand" href="/account"><span className="rs-brand-mark" aria-hidden="true">S</span>سيرياكار</Link><Link className="rs-back" href="/account">العودة إلى الحساب</Link></header>
    <div className="rs-wrap">
      <p className="rs-kicker">خدمات للمركبات المسجلة</p>
      <h1 className="rs-title">الفحص الفني</h1>
      <p className="rs-lead">اختر مركبتك ومحليتك لنبحث عن مزودي الفحص المتاحين.</p>

      {initializing && <div className="rs-skeleton" aria-label="جارٍ تحميل بيانات الحساب"><i/><i/><i/></div>}
      {!initializing && initError && <section className="rs-panel"><p className="rs-alert" role="alert">{initError}</p><button className="rs-button secondary" type="button" onClick={()=>void loadBase()}>إعادة المحاولة</button></section>}
      {!initializing && !initError && vehicles?.length===0 && <section className="rs-empty" style={{marginTop:24}}><h2>أضف مركبتك أولًا لاستخدام خدمة الفحص.</h2><p>بعد تسجيل مركبتك يمكنك اختيارها هنا ومتابعة الطلب.</p><Link className="rs-button" href="/account/vehicles/new">إضافة مركبة</Link></section>}
      {!initializing && !initError && !!vehicles?.length && <>
        <section className="rs-panel" aria-labelledby="inspection-selection-title">
          <h2 id="inspection-selection-title" className="rs-section-label" style={{marginTop:0}}>بيانات الفحص</h2>
          <div className="rs-field"><span className="rs-hint">المركبة المسجلة</span>
            <div className="rs-vehicle-options" role="group" aria-label="اختيار مركبة محفوظة">
              {vehicles.map(vehicle=><div className="rs-vehicle-option-wrap" key={vehicle.id}>
                <button type="button" className="rs-vehicle-option" aria-pressed={vehicleId===vehicle.id} disabled={vehicle.rejected}
                  onClick={()=>updateVehicle(vehicle.id)}>
                  <span className="rs-vehicle-mark" aria-hidden="true">م</span>
                  <span className="rs-vehicle-copy"><strong>{vehicle.brandGroupName} · {vehicle.brandName} · {vehicle.year}</strong>
                    <small>{vehicle.fuelTypeName} · {vehicle.vehicleCategory==="car"?"سيارة":"شاحنة"}{vehicle.rejected?" · مرفوضة":""}</small></span>
                </button>
                {vehicle.rejected&&<Link className="rs-button secondary rs-edit-rejected" href={`/account/vehicles/${encodeURIComponent(vehicle.id)}/edit`}>تعديل المركبة</Link>}
              </div>)}
            </div>
          </div>
          <div className="rs-form-grid" style={{marginTop:18}}>
            <div className="rs-field"><label htmlFor="inspection-governorate">المحافظة <span aria-hidden="true">*</span></label>
              <select id="inspection-governorate" className="rs-select" value={governorateId} onChange={event=>updateGovernorate(event.target.value)}>
                <option value="">اختر المحافظة</option>{localities?.governorates.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            <div className="rs-field"><label htmlFor="inspection-region">المنطقة <span aria-hidden="true">*</span></label>
              <select id="inspection-region" className="rs-select" value={regionId} disabled={!governorateId||regionsLoading} onChange={event=>updateRegion(event.target.value)}>
                <option value="">اختر المنطقة</option>{localities?.regions.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
          </div>
          {regionsLoading&&<p role="status">جارٍ تحميل المناطق…</p>}
          {regionsError&&<div><p className="rs-alert" role="alert">{regionsError}</p><button type="button" className="rs-button secondary" onClick={()=>setRegionsRetry(value=>value+1)}>إعادة تحميل المناطق</button></div>}
          <div className="rs-gps-row">
            <button type="button" className="rs-button secondary" onClick={gpsPoint ? ()=>setGpsPoint(null) : locate} disabled={gpsBusy}>{gpsBusy?"جارٍ تحديد الموقع…":gpsPoint?"إزالة موقعي من العرض":"استخدام موقعي للعرض فقط"}</button>
            {gpsMessage&&<p className="rs-hint" role="status">{gpsMessage}</p>}
            {gpsPoint&&<p className="rs-hint" role="status">يعرض موقعك على الخريطة فقط؛ لا يُرسل ولا يُحفظ، واختيار المحافظة والمنطقة يبقى إلزاميًا.</p>}
          </div>
          <div className="rs-actions"><button className="rs-button" type="button" onClick={()=>void loadProviders()} disabled={!canSearch||providersLoading}>{providersLoading?"جارٍ البحث…":"عرض مزودي الفحص"}</button></div>
          <p className="rs-hint" style={{marginTop:12}}>هوية الحساب: {profile?.name} · {selectedVehicle?`${selectedVehicle.brandName} ${selectedVehicle.year}`:"اختر مركبة"}</p>
        </section>
        {providersError&&<section className="rs-panel"><p className="rs-alert" role="alert">{providersError}</p><button className="rs-button secondary" type="button" onClick={()=>void loadProviders()}>إعادة المحاولة</button></section>}
        {stage==="results"&&providersLoading&&<div className="rs-skeleton" aria-label="جارٍ البحث عن مزودين"><i/><i/><i/></div>}
        {stage==="results"&&providers&&!providersLoading&&<>
          {confirmation&&<section className="rs-success" role="status">
            <h2>{confirmation.notificationId?"تم تسجيل إشعارك للمزود":"لا يوجد مزود مطابق في نطاقك"}</h2>
            {confirmation.notificationId&&<p>استخدم واتساب وأرسل الرسالة بنفسك؛ المنصة لا ترسلها تلقائيًا.</p>}
            {!confirmation.notificationId&&confirmation.contactPhone&&<p>يمكنك التواصل معنا على <bdi className="rs-phone">{confirmation.contactPhone}</bdi></p>}
            {confirmation.provider&&<p>المزود: {confirmation.provider.businessName} · <bdi className="rs-phone">{confirmation.provider.phone}</bdi></p>}
            {confirmation.whatsappUrl&&<a className="rs-button" href={confirmation.whatsappUrl} target="_blank" rel="noopener noreferrer">فتح واتساب وإرسال الرسالة</a>}
          </section>}
          <div className="rs-results-head"><div><p className="rs-kicker">النتائج · {governorateName}، {regionName}</p><h2>مزودو الفحص</h2></div><span className="rs-count">{providers.providers.length} مزود</span></div>
          {suitable.length>0&&<div className="rs-map-shell">
            {mapMode==="fallback"&&<div className="rs-map-fallback" role="status">تعذر تحميل الخريطة أو استغرق تحميلها أكثر من 5 ثوانٍ؛ تظهر جميع النتائج في قائمة نصية.</div>}
            {mapMode!=="fallback"&&<InspectionMap providers={providers.providers} userPoint={gpsPoint} onSelect={openProvider} onMapReady={mapReady} onMapFailure={mapFailure}/>}
          </div>}
          {!providers.providers.length&&<div className="rs-empty"><h2>لا يوجد مزود فحص متاح في هذه المحلية.</h2><p>يمكنك تأكيد عدم وجود مزود مطابق لتسجيل النتيجة.</p></div>}
          {mapList.length>0&&<div className="rs-provider-list" aria-label={mapMode==="fallback"?"قائمة مزودي الفحص":"مزودون يظهرون في القائمة فقط"}>
            {mapList.map(item=><button className="rs-provider" key={item.id} type="button" onClick={()=>openProvider(item)}>
              <span><strong>{item.businessName}</strong><small>{item.regionName} · <bdi className="rs-phone">{item.phone}</bdi></small></span>
              <span className={`rs-status${item.suitable?"":" no"}`}>{item.suitable?"مناسب لمركبتك":"غير مناسب"}</span>
            </button>)}
          </div>}
          {mapMode==="ready"&&providers.providers.some(item=>item.coordinates&&coordinates(item.coordinates.lat,item.coordinates.lng))&&
            <p className="rs-hint" style={{marginTop:12}}>على الخريطة: <span className="rs-status">مناسب</span> و<span className="rs-status no">غير مناسب</span>. تظهر القائمة أسفلها للمزودين الذين لا تتوفر لهم إحداثيات صالحة.</p>}
          {suitable.length>0&&<p className="rs-hint" style={{marginTop:14}}>اختيار المزود المناسب اختياري؛ يمكنك فتح بطاقة المزود لعرض قدراته وساعات عمله.</p>}
          {suitable.length===0&&!confirmation&&<section className="rs-panel">
            <p className="rs-alert info">لا يوجد مزود مطابق لمركبتك في نطاقك.</p>
            {providers.contactPhone&&<p>يمكنك التواصل معنا على <bdi className="rs-phone">{providers.contactPhone}</bdi></p>}
            <button className="rs-button" type="button" onClick={openNoMatchConfirmation} disabled={busy}>تأكيد عدم وجود مزود مطابق</button>
          </section>}
        </>}
      </>}
    </div>

    {sheetProvider&&<AccessibleSheet title={sheetMode==="details"?"تفاصيل مزود الفحص":"تأكيد إشعار المزود"} labelledBy="inspection-sheet-title" onClose={()=>{if(busyRef.current)return;setSheetProvider(null);setAcceptedTerms(false);}}>
      {sheetMode==="details"?<>
        <h3 style={{margin:"0 0 8px"}}>{sheetProvider.businessName}</h3>
        <p className="rs-muted">{sheetProvider.regionName} · <bdi className="rs-phone">{sheetProvider.phone}</bdi></p>
        <p><span className={`rs-status${sheetProvider.suitable?"":" no"}`}>{sheetProvider.suitable?"مناسب لمركبتك":"غير مناسب لمركبتك"}</span></p>
        <dl className="rs-detail-grid">
          <div><dt>مجموعات الماركات</dt><dd>{renderTags(sheetProvider.brandGroups)}</dd></div>
          <div><dt>الماركات</dt><dd>{renderTags(sheetProvider.brands)}</dd></div>
          <div><dt>فئات السنوات</dt><dd>{renderTags(sheetProvider.yearCategories.map(category))}</dd></div>
          <div><dt>أنظمة الطاقة</dt><dd>{renderTags(sheetProvider.fuelTypes)}</dd></div>
          <div><dt>فئة المركبة</dt><dd>{renderTags(sheetProvider.vehicleCategories.map(value=>value==="car"?"سيارة":value==="truck"?"شاحنة":value))}</dd></div>
          <div><dt>التخصصات</dt><dd>{renderTags(displayUnknown(sheetProvider.specializations))}</dd></div>
          <div><dt>ساعات العمل</dt><dd><bdi dir="ltr">{sheetProvider.hours.start} – {sheetProvider.hours.end}</bdi></dd></div>
        </dl>
        {sheetProvider.suitable&&<button className="rs-button" type="button" onClick={()=>{setSheetMode("confirm-provider");setAcceptedTerms(false);setSubmitError("");}}>أبلغ المزود</button>}
      </>:<>
        <p>سيُنشأ إشعار باسم حسابك للمركبة <strong>{selectedVehicle?.brandName} {selectedVehicle?.year}</strong> في {governorateName}، {regionName}.</p>
        {sheetProvider&&<p>المزود: <strong>{sheetProvider.businessName}</strong> · <bdi className="rs-phone">{sheetProvider.phone}</bdi></p>}
        <p className="rs-warning">الإشعار ليس حجزًا ولا ضمانًا لاستجابة المزود. ستفتح رسالة واتساب لتراجعها وترسلها بنفسك.</p>
        {submitError&&<p className="rs-alert" role="alert">{submitError}</p>}
        <label className="rs-checkline"><input type="checkbox" checked={acceptedTerms} onChange={event=>setAcceptedTerms(event.target.checked)}/><span>أوافق على شروط الاستخدام وإرسال بيانات الطلب للمزود.</span></label>
        <div className="rs-actions"><button className="rs-button" type="button" disabled={!acceptedTerms||busy} onClick={()=>void submit(sheetProvider)}>{busy?"جارٍ التأكيد…":"تأكيد وإبلاغ المزود"}</button><button className="rs-button secondary" type="button" disabled={busy} onClick={()=>setSheetProvider(null)}>إلغاء</button></div>
      </>}
    </AccessibleSheet>}
    {sheetMode==="confirm-empty"&&!sheetProvider&&<AccessibleSheet title="تأكيد عدم وجود مزود مطابق" labelledBy="inspection-empty-title" onClose={()=>{if(busyRef.current)return;setSheetMode("details");setAcceptedTerms(false);}}>
      <p>سيتم تسجيل نتيجة عدم توفر مزود مطابق لهذه المركبة في {governorateName}، {regionName}. لن يُرسل إشعار إلى أي مزود.</p>
      {providers?.contactPhone&&<p>للتواصل: <bdi className="rs-phone">{providers.contactPhone}</bdi></p>}
      {submitError&&<p className="rs-alert" role="alert">{submitError}</p>}
      <label className="rs-checkline"><input type="checkbox" checked={acceptedTerms} onChange={event=>setAcceptedTerms(event.target.checked)}/><span>أؤكد تسجيل نتيجة عدم توفر مزود مطابق وأوافق على شروط الاستخدام.</span></label>
      <div className="rs-actions"><button className="rs-button" type="button" disabled={!acceptedTerms||busy} onClick={()=>void submit(null)}>{busy?"جارٍ التأكيد…":"تأكيد النتيجة"}</button><button className="rs-button secondary" type="button" disabled={busy} onClick={()=>setSheetMode("details")}>إلغاء</button></div>
    </AccessibleSheet>}
  </main>;
}