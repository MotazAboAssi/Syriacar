"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Profile } from "../../account/contracts";
import type { TowingProvider, TowingProvidersResult } from "../../guest-towing/contracts";
import { coverageWarning, towingWarning } from "../../guest-towing/contracts";
import type { Confirmation } from "../contracts";
import { gpsLocationLink } from "../contracts";
import { AccessibleSheet, expireRegisteredSession, genericServiceError, serviceRequest, type Locality, type ServiceError } from "./service-common";
import "./registered-services.css";

type GovernoratesResult = { governorates: Locality[]; regions: Locality[] };
type SheetMode = "details" | "confirm";

export default function TowingPage() {
  const router = useRouter();
  const [profile,setProfile] = useState<Profile|null>(null);
  const [governorates,setGovernorates] = useState<Locality[]>([]);
  const [origin,setOrigin] = useState("");
  const [destination,setDestination] = useState("");
  const [baseLoading,setBaseLoading] = useState(true);
  const [baseError,setBaseError] = useState("");
  const [providers,setProviders] = useState<TowingProvidersResult|null>(null);
  const [providersLoading,setProvidersLoading] = useState(false);
  const [providersError,setProvidersError] = useState("");
  const [selected,setSelected] = useState<TowingProvider|null>(null);
  const [sheetMode,setSheetMode] = useState<SheetMode>("details");
  const [acceptedTerms,setAcceptedTerms] = useState(false);
  const [busy,setBusy] = useState(false);
  const [submitError,setSubmitError] = useState("");
  const [confirmation,setConfirmation] = useState<Confirmation|null>(null);
  const [routeStage,setRouteStage] = useState(false);
  const [locationOpen,setLocationOpen] = useState(false);
  const [locationMode,setLocationMode] = useState<"gps"|"manual">("gps");
  const [locationGovernorate,setLocationGovernorate] = useState("");
  const [locationRegion,setLocationRegion] = useState("");
  const [regions,setRegions] = useState<Locality[]>([]);
  const [regionsLoading,setRegionsLoading] = useState(false);
  const [locationBusy,setLocationBusy] = useState(false);
  const [locationError,setLocationError] = useState("");
  const [locationUrl,setLocationUrl] = useState("");
  const [gpsBusy,setGpsBusy] = useState(false);
  const [gpsUnavailable,setGpsUnavailable] = useState("");
  const generation=useRef(0);
  const providerAbort=useRef<AbortController|null>(null);
  const regionAbort=useRef<AbortController|null>(null);
  const requestBusy=useRef(false);
  const locationBusyRef=useRef(false);
  const requestIdRef=useRef<string|null>(null);
  const locationGeneration = useRef(0);

  const handleExpired=useCallback(()=>expireRegisteredSession(router),[router]);
  useEffect(()=>{window.addEventListener("syriacar-account-expired",handleExpired);return()=>window.removeEventListener("syriacar-account-expired",handleExpired);},[handleExpired]);

  const loadBase=useCallback(async()=>{
    setBaseLoading(true);setBaseError("");
    try{
      const [account,refs]=await Promise.all([
        serviceRequest<Profile>("/api/account/profile"),
        serviceRequest<GovernoratesResult>("/api/guest-towing/governorates"),
      ]);
      setProfile(account);setGovernorates(refs.governorates);
      if(account.homeGovernorateId&&refs.governorates.some(item=>item.id===account.homeGovernorateId))setOrigin(account.homeGovernorateId);
    }catch(caught){
      const error=caught as ServiceError;
      if(error.status===401)expireRegisteredSession(router);
      else setBaseError(error instanceof TypeError?"تعذر الاتصال بالخدمة. تحقق من اتصالك ثم أعد المحاولة.":genericServiceError);
    }finally{setBaseLoading(false);}
  },[router]);
  useEffect(()=>{void loadBase();return()=>{providerAbort.current?.abort();regionAbort.current?.abort();};},[loadBase]);

  function resetRoute(nextOrigin:string,nextDestination:string){
    ++generation.current;providerAbort.current?.abort();requestIdRef.current=null;
    setProviders(null);setProvidersError("");setProvidersLoading(false);setConfirmation(null);
    setSelected(null);setLocationOpen(false);setLocationUrl("");setLocationError("");
    ++locationGeneration.current; regionAbort.current?.abort(); setGpsBusy(false);
    setOrigin(nextOrigin);setDestination(nextDestination);
  }
  function changeOrigin(value:string){resetRoute(value,destination);}
  function changeDestination(value:string){resetRoute(origin,value);}

  async function loadProviders(){
    if(!origin||!destination)return;
    const current=++generation.current;
    providerAbort.current?.abort();
    const controller=new AbortController();providerAbort.current=controller;
    setProvidersLoading(true);setProvidersError("");setProviders(null);setConfirmation(null);setRouteStage(true);
    try{
      const query=new URLSearchParams({originGovernorateId:origin,destGovernorateId:destination});
      const value=await serviceRequest<TowingProvidersResult>(`/api/guest-towing/providers?${query}`,{signal:controller.signal});
      if(current!==generation.current)return;
      setProviders(value);
    }catch(caught){
      if(controller.signal.aborted||current!==generation.current)return;
      const error=caught as ServiceError;
      if(error.status===401){expireRegisteredSession(router);return;}
      setProvidersError(error.status===422?(error.message||"تحقق من محافظتي الانطلاق والوصول."):genericServiceError);
      setRouteStage(false);
    }finally{if(current===generation.current)setProvidersLoading(false);}
  }
  function openProvider(provider:TowingProvider){
    setSelected(provider);setSheetMode("details");setAcceptedTerms(false);setSubmitError("");
  }
  async function submit(){
    if(!selected||requestBusy.current||!acceptedTerms)return;
    requestBusy.current=true;setBusy(true);setSubmitError("");
    const submittedGeneration=generation.current;
    const popup=window.open("about:blank","_blank");
    if (popup) popup.opener = null;
    try{
      const value=await serviceRequest<Confirmation>("/api/towing/requests",{
        method:"POST",
        body:JSON.stringify({originGovernorateId:origin,destGovernorateId:destination,providerId:selected.id,acceptedTerms:true,...(requestIdRef.current?{requestId:requestIdRef.current}:{})}),
      });
      if(submittedGeneration!==generation.current){popup?.close();return;}
      requestIdRef.current=value.requestId;
      setConfirmation(value);setSelected(null);setLocationOpen(false);setLocationUrl("");
      if(value.whatsappUrl&&popup)popup.location.href=value.whatsappUrl;else popup?.close();
    }catch(caught){
      popup?.close();
      if(submittedGeneration!==generation.current)return;
      const error=caught as ServiceError;
      if(error.status===401){expireRegisteredSession(router);return;}
      setSubmitError(error.status===422?(error.message||"لم يعد هذا الاختيار متاحًا. حدّث النتائج ثم حاول."):
        "تعذر تأكيد النتيجة. لم تتم إعادة المحاولة تلقائيًا؛ راجع الحالة قبل أي متابعة.");
    }finally{requestBusy.current=false;setBusy(false);}
  }
  function openLocation(){
    ++locationGeneration.current; regionAbort.current?.abort(); setGpsBusy(false); setRegionsLoading(false);
    setLocationOpen(true);setLocationMode("gps");setLocationError("");setGpsUnavailable("");setLocationUrl("");setLocationGovernorate("");setLocationRegion("");setRegions([]);
  }
  function useGps(){
    if(!confirmation?.whatsappUrl||!profile)return;
    const current = ++locationGeneration.current;
    setGpsBusy(true);setGpsUnavailable("");setLocationError("");
    const popup=window.open("about:blank","_blank");
    if (popup) popup.opener = null;
    if(!navigator.geolocation){popup?.close();setGpsBusy(false);setGpsUnavailable("الموقع غير متاح على هذا الجهاز. اختر المحافظة والمنطقة يدويًا.");setLocationMode("manual");return;}
    navigator.geolocation.getCurrentPosition(position=>{
      if (current !== locationGeneration.current) { popup?.close(); return; }
      const link=gpsLocationLink(confirmation.whatsappUrl!,profile.name,position.coords.latitude,position.coords.longitude);
      setGpsBusy(false);
      if(link){setLocationUrl(link);if(popup)popup.location.href=link;}
      else{popup?.close();setGpsUnavailable("تعذر قراءة موقع صالح. اختر المحافظة والمنطقة يدويًا.");setLocationMode("manual");}
    },()=>{
      if (current !== locationGeneration.current) { popup?.close(); return; }
      popup?.close();
      setGpsBusy(false);setGpsUnavailable("لم نتمكن من الوصول إلى موقعك. اختر المحافظة والمنطقة يدويًا.");setLocationMode("manual");
    },{enableHighAccuracy:false,timeout:8000,maximumAge:60000});
  }
  async function loadRegions(governorateId:string){
    setLocationGovernorate(governorateId);setLocationRegion("");setRegions([]);setLocationUrl("");setLocationError("");
    regionAbort.current?.abort();
    setRegionsLoading(false);
    if(!governorateId)return;
    const controller=new AbortController();regionAbort.current=controller;setRegionsLoading(true);
    try{
      const query=new URLSearchParams({governorateId});
      const value=await serviceRequest<GovernoratesResult>(`/api/guest-towing/governorates?${query}`,{signal:controller.signal});
      if(!controller.signal.aborted)setRegions(value.regions);
    }catch(caught){
      if(!controller.signal.aborted){
        const error=caught as ServiceError;
        if(error.status===401)expireRegisteredSession(router);
        else setLocationError(error.message||"تعذر تحميل المناطق.");
      }
    }finally{if(!controller.signal.aborted)setRegionsLoading(false);}
  }
  async function sendManualLocation(){
    if(locationBusyRef.current||!confirmation?.requestId||!confirmation.notificationId||!locationGovernorate||!locationRegion)return;
    locationBusyRef.current=true;setLocationBusy(true);setLocationError("");
    const current = ++locationGeneration.current;
    const popup=window.open("about:blank","_blank");
    if (popup) popup.opener = null;
    try{
      const value=await serviceRequest<{whatsappUrl:string;delivery:"not_implemented"}>("/api/towing/location",{
        method:"POST",body:JSON.stringify({requestId:confirmation.requestId,notificationId:confirmation.notificationId,governorateId:locationGovernorate,regionId:locationRegion}),
      });
      if (current !== locationGeneration.current) { popup?.close(); return; }
      setLocationUrl(value.whatsappUrl);
      if(popup)popup.location.href=value.whatsappUrl;
    }catch(caught){
      popup?.close();
      if(current!==locationGeneration.current)return;
      const error=caught as ServiceError;
      if(error.status===401){expireRegisteredSession(router);return;}
      setLocationError(error.status===422?(error.message||"تحقق من المحافظة والمنطقة."):genericServiceError);
    }finally{locationBusyRef.current=false;setLocationBusy(false);}
  }

  const originName=governorates.find(item=>item.id===origin)?.name||"";
  const destinationName=governorates.find(item=>item.id===destination)?.name||"";
  const hasMatching=!!providers?.sectionA.length;
  const routeValid=!!origin&&!!destination;

  return <main className="rs" dir="rtl">
    <header className="rs-header"><Link className="rs-brand" href="/account"><span className="rs-brand-mark" aria-hidden="true">S</span>سيرياكار</Link><Link className="rs-back" href="/account">العودة إلى الحساب</Link></header>
    <div className="rs-wrap">
      <p className="rs-kicker">خدمات للمركبات المسجلة</p><h1 className="rs-title">خدمة السطحة</h1>
      <p className="rs-lead">حدّد مسار الرحلة لعرض مزودي السطحات المتاحين.</p>
      <p className="rs-warning">{towingWarning}</p>
      {baseLoading&&<div className="rs-skeleton" aria-label="جارٍ تحميل الحساب"><i/><i/><i/></div>}
      {!baseLoading&&baseError&&<section className="rs-panel"><p className="rs-alert" role="alert">{baseError}</p><button className="rs-button secondary" type="button" onClick={()=>void loadBase()}>إعادة المحاولة</button></section>}
      {!baseLoading&&!baseError&&<section className="rs-panel">
        <div className="rs-form-grid">
          <div className="rs-field"><label htmlFor="tow-origin">محافظة الانطلاق <span aria-hidden="true">*</span></label>
            <select id="tow-origin" className="rs-select" value={origin} onChange={event=>changeOrigin(event.target.value)}><option value="">اختر محافظة الانطلاق</option>{governorates.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </div>
          <div className="rs-field"><label htmlFor="tow-destination">محافظة الوصول <span aria-hidden="true">*</span></label>
            <select id="tow-destination" className="rs-select" value={destination} onChange={event=>changeDestination(event.target.value)}><option value="">اختر محافظة الوصول</option>{governorates.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </div>
        </div>
        <p className="rs-hint" style={{marginTop:12}}>محافظة السكن: {governorates.find(item=>item.id===profile?.homeGovernorateId)?.name||"غير محددة أو غير متاحة"} · يمكن تعديل الانطلاق دون تغيير بيانات حسابك.</p>
        <div className="rs-actions"><button className="rs-button" type="button" disabled={!routeValid||providersLoading} onClick={()=>void loadProviders()}>{providersLoading?"جارٍ البحث…":"عرض مزودي السطحات"}</button></div>
      </section>}
      {providersError&&<section className="rs-panel"><p className="rs-alert" role="alert">{providersError}</p><button className="rs-button secondary" type="button" onClick={()=>void loadProviders()}>إعادة المحاولة</button></section>}
      {providersLoading&&<div className="rs-skeleton" aria-label="جارٍ تحميل مزودي السطحات"><i/><i/><i/></div>}
      {routeStage&&providers&&!providersLoading&&<section className="rs-tow-sections">
        <div className="rs-results-head"><div><p className="rs-kicker">المسار المختار</p><h2>{originName} ← {destinationName}</h2></div></div>
        <p className="rs-warning">{coverageWarning}</p><p className="rs-warning">{towingWarning}</p>
        {confirmation&&<section className="rs-success" role="status">
          <h2>تم تجهيز إشعارك</h2><p>أرسل الرسالة بنفسك في واتساب؛ لم تُرسل المنصة رسالة تلقائيًا.</p>
          {confirmation.provider&&<p>{confirmation.provider.businessName} · <bdi className="rs-phone">{confirmation.provider.phone}</bdi></p>}
          {confirmation.whatsappUrl&&<a className="rs-button" href={confirmation.whatsappUrl} target="_blank" rel="noopener noreferrer">فتح واتساب وإرسال الرسالة</a>}
          <p className="rs-warning">{towingWarning}</p>
          <div className="rs-success-actions">
            {confirmation.notificationId&&<button className="rs-button secondary" type="button" onClick={openLocation}>أرسل موقعي</button>}
            <button className="rs-button" type="button" onClick={()=>setConfirmation(null)}>إبلاغ مزود آخر على المسار نفسه</button>
          </div>
        </section>}
        <div className="rs-tow-section">
          <h2>مناسب لمشكلتك</h2><p className="rs-warning">{coverageWarning}</p>
          {!hasMatching&&<div className="rs-empty"><h3>لا يوجد مزود يغطي هذا المسار</h3>{providers.contactPhone&&<p>يمكنك التواصل معنا على <bdi className="rs-phone">{providers.contactPhone}</bdi></p>}</div>}
          <div className="rs-tow-cards">{providers.sectionA.map(provider=><TowingCard key={provider.id} provider={provider} onSelect={openProvider}/>)}</div>
        </div>
        <div className="rs-tow-section">
          <h2>باقي المزودين</h2><p className="rs-warning">{coverageWarning}</p>
          <div className="rs-tow-cards">{providers.sectionB.map(provider=><TowingCard key={provider.id} provider={provider} onSelect={openProvider}/>)}</div>
          {!providers.sectionB.length&&<p className="rs-hint">لا توجد نتائج إضافية لهذا المسار.</p>}
        </div>
      </section>}
    </div>

    {selected&&<AccessibleSheet title={sheetMode==="details"?"تفاصيل مزود السطحة":"تأكيد إشعار المزود"} labelledBy="towing-sheet-title" onClose={()=>{if(requestBusy.current)return;setSelected(null);setAcceptedTerms(false);}}>
      {sheetMode==="details"?<>
        <h3 style={{margin:"0 0 6px"}}>{selected.businessName}</h3>
        <p>المحافظات التي يغطيها</p><div className="rs-tag-list">{selected.coverage.map(item=><span className="rs-tag" key={item.id}>{item.name}</span>)}</div>
        <p>نوع السطحة: {selected.towType||"غير محدد"}</p>
        <p>الهاتف: <bdi className="rs-phone">{selected.phone}</bdi></p>
        <p className="rs-warning">{coverageWarning}</p><p className="rs-warning">{towingWarning}</p>
        <button className="rs-button" type="button" onClick={()=>{setSheetMode("confirm");setAcceptedTerms(false);setSubmitError("");}}>أبلغ المزود</button>
      </>:<>
        <p>الانطلاق: <strong>{originName}</strong> · الوصول: <strong>{destinationName}</strong></p>
        <p>المزود: {selected.businessName} · <bdi className="rs-phone">{selected.phone}</bdi></p>
        <p className="rs-warning">{coverageWarning}</p><p className="rs-warning">{towingWarning}</p>
        {submitError&&<p className="rs-alert" role="alert">{submitError}</p>}
        <label className="rs-checkline"><input type="checkbox" checked={acceptedTerms} onChange={event=>setAcceptedTerms(event.target.checked)}/><span>أوافق على شروط الاستخدام وإرسال بيانات الطلب للمزود.</span></label>
        <div className="rs-actions"><button className="rs-button" type="button" disabled={!acceptedTerms||busy} onClick={()=>void submit()}>{busy?"جارٍ التأكيد…":"تأكيد وإبلاغ المزود"}</button><button className="rs-button secondary" type="button" disabled={busy} onClick={()=>setSelected(null)}>إلغاء</button></div>
      </>}
    </AccessibleSheet>}

    {locationOpen&&confirmation&&<AccessibleSheet title="مشاركة موقعك مع المزود" labelledBy="towing-location-title" onClose={()=>{++locationGeneration.current;regionAbort.current?.abort();setLocationOpen(false);}}>
      <p className="rs-warning">{towingWarning}</p>
      <p>هذا الموقع للمشاركة فقط، ولا يغيّر محافظة الانطلاق أو الوصول في الطلب.</p>
      {locationMode==="gps"&&<>
        <p>يمكن استخدام GPS في هذا الجهاز فقط؛ لن تُرسل الإحداثيات إلى المنصة أو تُحفظ.</p>
        <button className="rs-button" type="button" disabled={gpsBusy} onClick={useGps}>{gpsBusy?"جارٍ تحديد موقعك…":"استخدام GPS ومشاركة الموقع"}</button>
        {gpsUnavailable&&<p className="rs-alert info" role="status">{gpsUnavailable}</p>}
        <button className="rs-button secondary" style={{marginInlineStart:8}} type="button" onClick={()=>{++locationGeneration.current;setGpsBusy(false);setLocationMode("manual");}}>اختيار الموقع يدويًا</button>
      </>}
      {locationMode==="manual"&&<>
        <div className="rs-field" style={{marginTop:14}}><label htmlFor="tow-location-governorate">المحافظة</label>
          <select id="tow-location-governorate" className="rs-select" value={locationGovernorate} disabled={locationBusy} onChange={event=>void loadRegions(event.target.value)}><option value="">اختر المحافظة</option>{governorates.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select>
        </div>
        <div className="rs-field" style={{marginTop:14}}><label htmlFor="tow-location-region">المنطقة</label>
          <select id="tow-location-region" className="rs-select" value={locationRegion} disabled={!locationGovernorate||regionsLoading||locationBusy} onChange={event=>{setLocationRegion(event.target.value);setLocationUrl("");}}><option value="">اختر المنطقة</option>{regions.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select>
        </div>
        {regionsLoading&&<p className="rs-hint">جارٍ تحميل المناطق…</p>}
        <button className="rs-button" type="button" style={{marginTop:14}} disabled={!locationGovernorate||!locationRegion||locationBusy} onClick={()=>void sendManualLocation()}>{locationBusy?"جارٍ تجهيز الرسالة…":"تجهيز رسالة الموقع"}</button>
      </>}
      {locationError&&<p className="rs-alert" role="alert">{locationError}</p>}
      {locationUrl&&<div className="rs-success" role="status"><strong>الرسالة جاهزة للإرسال من طرفك.</strong><p>افتح واتساب ثم أرسل الرسالة بنفسك.</p><a className="rs-button" href={locationUrl} target="_blank" rel="noopener noreferrer">فتح واتساب لإرسال الموقع</a></div>}
    </AccessibleSheet>}
  </main>;
}

function TowingCard({provider,onSelect}:{provider:TowingProvider;onSelect:(provider:TowingProvider)=>void}){
  return <article className="rs-tow-card">
    <div><h3>{provider.businessName}</h3><p>{provider.coverage.map(item=>item.name).join("، ")}</p><p>{provider.towType||"نوع السطحة غير محدد"} · <bdi className="rs-phone">{provider.phone}</bdi></p></div>
    <button className="rs-button" type="button" onClick={()=>onSelect(provider)}>عرض التفاصيل وإبلاغ المزود</button>
  </article>;
}