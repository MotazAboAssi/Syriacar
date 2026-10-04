"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AccountApiError, accountApi } from "../client";
import { isE164 } from "../../guest-inspection/validation";
import type { AccountReferences, OtpState, Profile, Vehicle, VehicleInput } from "../contracts";
import "./account.css";

type ScreenProps = { profile?: Profile };
const phoneKey = "syriacar.account.otpPhone";
const otpErrorKey = "syriacar.account.otpError";
const sessionError = "انتهت جلستك. الرجاء تسجيل الدخول مجدداً.";
const genericError = "حدث خطأ. حاول مجدداً.";

function westernDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, digit => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}
function normalizePhone(value: string): string | null {
  const clean = westernDigits(value).trim().replace(/[()\s-]/g, "");
  return /^\+963\d+$/.test(clean) && isE164(clean) ? clean : null;
}
function errorMessage(error: unknown, fallback = genericError): string {
  if (error instanceof AccountApiError) return error.detail.error || fallback;
  return fallback;
}
function goOtp(router: ReturnType<typeof useRouter>, phone: string) {
  sessionStorage.setItem(phoneKey, phone);
  router.push("/otp");
}
function BrandHeader({ context, profile }: { context: string; profile?: Profile }) {
  const path = usePathname();
  return <header className="sc-topbar">
    <Link href={profile ? "/account" : "/"} className="sc-brand"><span className="sc-brandmark" aria-hidden="true">S</span><span>سيرياكار</span></Link>
    <span className="sc-context">{context}</span>
    {profile && <nav className="sc-top-links" aria-label="التنقل الرئيسي">
      <Link href="/account" aria-current={path === "/account" ? "page" : undefined}>الرئيسية</Link>
      <Link href="/account/vehicles" aria-current={path.includes("/vehicles") ? "page" : undefined}>مركباتي</Link>
      <Link href="/account/profile" aria-current={path === "/account/profile" ? "page" : undefined}>الملف</Link>
    </nav>}
    {!profile && <nav className="sc-top-links" aria-label="الحساب">
      <Link href="/login">دخول</Link><Link href="/register">إنشاء حساب</Link>
    </nav>}
  </header>;
}
function Frame({ children, context, profile, narrow = false }: { children: React.ReactNode; context: string; profile?: Profile; narrow?: boolean }) {
  return <div className="sc-account"><BrandHeader context={context} profile={profile}/><main className={`sc-main${narrow ? " narrow" : ""}`}>{children}</main><footer className="sc-footer">سيرياكار · خدمات لمركبتك</footer></div>;
}
function LoadingFrame() {
  return <div className="sc-account"><BrandHeader context="حسابك"/><main className="sc-main narrow" aria-label="جارٍ تحميل الحساب"><div className="sc-loading"><div className="sc-skeleton" style={{width:"38%"}}/><div className="sc-skeleton large"/><div className="sc-skeleton" style={{width:"72%"}}/></div></main></div>;
}
function Protected({ children, context }: { children: (profile: Profile) => React.ReactNode; context: string }) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const expireSession = useCallback(() => {
    sessionStorage.setItem("syriacar.account.sessionError", sessionError);
    setProfile(null);
    setFailed(false);
    setLoading(false);
    router.replace("/login");
  }, [router]);
  useEffect(() => {
    window.addEventListener("syriacar-account-expired", expireSession);
    return () => window.removeEventListener("syriacar-account-expired", expireSession);
  }, [expireSession]);
  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try { const value = await accountApi.profile(); setProfile(value); }
    catch (error) {
      if (error instanceof AccountApiError && error.status === 401) expireSession();
      else setFailed(true);
    } finally { setLoading(false); }
  }, [expireSession]);
  useEffect(() => { void load(); }, [load]);
  if (loading) return <LoadingFrame/>;
  if (failed) return <Frame context={context}><section className="sc-panel"><p className="sc-alert" role="alert">{genericError}</p><button className="sc-btn" onClick={() => void load()}>إعادة المحاولة</button></section></Frame>;
  if (!profile) return <LoadingFrame/>;
  return <Frame context={context} profile={profile}>{children(profile)}</Frame>;
}
function Field({ label, id, children, help }: { label: string; id: string; children: React.ReactNode; help?: string }) {
  return <div className="sc-field"><label className="sc-label" htmlFor={id}>{label}</label>{children}{help && <p className="sc-help">{help}</p>}</div>;
}
function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`sc-input${props.className ? ` ${props.className}` : ""}`}/>;
}
function AuthLayout({ children, title, copy }: { children: React.ReactNode; title: string; copy: string }) {
  return <Frame context="حسابك في سيرياكار" narrow><p className="sc-kicker">مساحة مالك المركبة</p><h1 className="sc-title">{title}</h1><p className="sc-lead">{copy}</p>{children}</Frame>;
}
function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState(""); const [phoneInput, setPhoneInput] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [fieldErrors, setFieldErrors] = useState<Record<string,string>>({});
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setFieldErrors({});
    const phone = normalizePhone(phoneInput);
    if (!phone) { setFieldErrors({phone:"أدخل رقمًا سوريًا يبدأ بـ +963."}); return; }
    if ([...password].length < 8) { setFieldErrors({password:"يجب ألا تقل كلمة المرور عن 8 أحرف."}); return; }
    setBusy(true);
    try { const state = await accountApi.register({name:name.trim(), phone, password}); sessionStorage.setItem(phoneKey, state.phone || phone); router.push("/otp"); }
    catch (reason) {
      if (reason instanceof AccountApiError && reason.status === 500 && reason.detail.otp) {
        sessionStorage.setItem(phoneKey, reason.detail.otp.phone || phone);
        sessionStorage.setItem(otpErrorKey, genericError);
        router.push("/otp"); return;
      }
      if (reason instanceof AccountApiError && reason.status === 422 && reason.detail.fields) setFieldErrors(reason.detail.fields);
      setError(errorMessage(reason, genericError));
    } finally { setBusy(false); }
  }
  return <AuthLayout title="أنشئ حسابك" copy="سجّل بياناتك لتحتفظ بمركباتك في مكان واحد.">
    <form className="sc-panel sc-form" onSubmit={submit} noValidate>
      {error && <p className="sc-alert" role="alert">{error}</p>}
      <Field label="الاسم" id="reg-name"><TextInput id="reg-name" autoComplete="name" required value={name} onChange={e=>setName(e.target.value)} aria-invalid={!!fieldErrors.name}/>{fieldErrors.name&&<p className="sc-help" role="alert">{fieldErrors.name}</p>}</Field>
      <Field label="رقم الهاتف" id="reg-phone" help="استخدم رقمًا سوريًا مع مفتاح الدولة +963."><TextInput id="reg-phone" className="sc-ltr" inputMode="tel" autoComplete="tel" dir="ltr" placeholder="+963 9XX XXX XXX" required value={phoneInput} onChange={e=>setPhoneInput(e.target.value)} aria-invalid={!!fieldErrors.phone}/>{fieldErrors.phone && <p className="sc-help" role="alert">{fieldErrors.phone}</p>}</Field>
      <Field label="كلمة المرور" id="reg-password" help="8 أحرف على الأقل."><TextInput id="reg-password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e=>setPassword(e.target.value)} aria-invalid={!!fieldErrors.password}/>{fieldErrors.password && <p className="sc-help" role="alert">{fieldErrors.password}</p>}</Field>
      <button className="sc-btn" type="submit" disabled={busy}>{busy ? "جارٍ إنشاء الحساب…" : "إنشاء حساب"}</button>
    </form><p className="sc-auth-switch">لديك حساب؟ <Link href="/login">تسجيل الدخول</Link></p>
  </AuthLayout>;
}
function LoginPage() {
  const router = useRouter();
  const [phoneInput,setPhoneInput]=useState(""); const [password,setPassword]=useState(""); const [error,setError]=useState(""); const [busy,setBusy]=useState(false); const [inactivePhone,setInactivePhone]=useState("");
  useEffect(()=>{ const message=sessionStorage.getItem("syriacar.account.sessionError"); if(message){setError(message);sessionStorage.removeItem("syriacar.account.sessionError");} },[]);
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setInactivePhone("");
    const phone=normalizePhone(phoneInput); if(!phone){setError("أدخل رقمًا سوريًا يبدأ بـ +963.");return;}
    setBusy(true);
    try { await accountApi.login({phone,password}); router.replace("/account"); }
    catch(reason) {
      if(reason instanceof AccountApiError && reason.detail.code==="inactive") { setError("لم يكتمل تفعيل حسابك بعد.");setInactivePhone(phone);sessionStorage.setItem(phoneKey,phone); }
      else setError(errorMessage(reason));
    } finally {setBusy(false);}
  }
  return <AuthLayout title="مرحبًا بعودتك" copy="أدخل رقم الهاتف وكلمة المرور للمتابعة.">
    <form className="sc-panel sc-form" onSubmit={submit} noValidate>
      {error && <p className="sc-alert" role="alert">{error}</p>}
      <Field label="رقم الهاتف" id="login-phone"><TextInput id="login-phone" className="sc-ltr" dir="ltr" inputMode="tel" autoComplete="tel" placeholder="+963 9XX XXX XXX" value={phoneInput} onChange={e=>setPhoneInput(e.target.value)} required/></Field>
      <Field label="كلمة المرور" id="login-password"><TextInput id="login-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></Field>
      <button className="sc-btn" type="submit" disabled={busy}>{busy ? "جارٍ تسجيل الدخول…" : "دخول"}</button>
      {inactivePhone && <button className="sc-btn secondary" type="button" onClick={()=>goOtp(router,inactivePhone)}>إكمال التحقق</button>}
    </form><p className="sc-auth-switch">ليس لديك حساب؟ <Link href="/register">إنشاء حساب</Link></p>
  </AuthLayout>;
}
function OtpPage() {
  const router=useRouter(); const [phone,setPhone]=useState(""); const [digits,setDigits]=useState(Array(6).fill("")); const [state,setState]=useState<OtpState|null>(null);
  const [error,setError]=useState(""); const [busy,setBusy]=useState(false); const [now,setNow]=useState(Date.now()); const refs=useRef<Array<HTMLInputElement|null>>([]); const refreshedExpiry=useRef("");
  const refresh=useCallback(async (target:string, quiet=false) => {
    try { const latest=await accountApi.otpState(target);setState(latest);if(!quiet)setError(""); }
    catch(reason){ if(!quiet)setError(errorMessage(reason)); }
  },[]);
  useEffect(()=>{ const stored=sessionStorage.getItem(phoneKey); if(!stored){router.replace("/register");return;}setPhone(stored);const pendingError=sessionStorage.getItem(otpErrorKey);if(pendingError){setError(pendingError);sessionStorage.removeItem(otpErrorKey);}void refresh(stored,true); },[refresh,router]);
  useEffect(()=>{ const ticker=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(ticker); },[]);
  useEffect(()=>{ if(!phone)return;const poll=window.setInterval(()=>void refresh(phone,true),15000);return()=>window.clearInterval(poll); },[phone,refresh]);
  const expires=state ? new Date(state.expiresAt).getTime() : 0;
  const remaining=Math.max(0,Math.ceil((expires-now)/1000));
  const resendAt=state ? new Date(state.resendAt).getTime() : 0;
  const canResend=!!state && state.canResend && (remaining===0 || expires<=now) && now>=resendAt;
  useEffect(()=>{if(state&&remaining===0&&refreshedExpiry.current!==state.expiresAt){refreshedExpiry.current=state.expiresAt;void refresh(phone,true);}},[remaining,state,phone,refresh]);
  const sendStatus=state?.sendStatus;
  const deliveryStatus=state?.deliveryStatus?.toLowerCase();
  const deliveryConfirmed=deliveryStatus==="delivered"||deliveryStatus==="read";
  const deliveryFailed=deliveryStatus==="failed";
  const deliveryUnknown=deliveryStatus==="unknown";
  const sendCopy=deliveryConfirmed ? "تم تأكيد وصول رمز التحقق." :
    deliveryFailed||sendStatus==="failed" ? "تعذّر إرسال رمز التحقق. يمكنك إعادة الإرسال عند إتاحة الزر." :
    deliveryUnknown||sendStatus==="unknown" ? "تعذّر تأكيد الإرسال." :
    sendStatus==="api_accepted" ? "قُبل طلب الإرسال. لم يتأكد وصول الرسالة بعد." :
    sendStatus==="pending" ? "جارٍ إرسال رمز التحقق…" : "";
  function changeDigit(index:number,value:string) {
    const digit=westernDigits(value).replace(/\D/g,"").slice(-1);setDigits(current=>{const next=[...current];next[index]=digit;return next;});
    if(digit&&index<5)refs.current[index+1]?.focus();
  }
  async function verify(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const code=digits.join("");if(code.length!==6){setError("أدخل رمز التحقق المؤلف من ستة أرقام.");return;}
    setBusy(true);setError("");
    try { await accountApi.verify({phone,code});sessionStorage.removeItem(phoneKey);router.replace("/account"); }
    catch(reason){setError(reason instanceof AccountApiError && reason.detail.code==="otp_invalid" ? "الرمز غير صحيح أو لم يعد صالحًا. اطلب رمزًا جديدًا." : errorMessage(reason));if(reason instanceof AccountApiError && reason.detail.otp)setState(reason.detail.otp);else void refresh(phone,true);setDigits(Array(6).fill(""));refs.current[0]?.focus();}
    finally{setBusy(false);}
  }
  async function resend() {
    if(!canResend||busy)return;setBusy(true);setError("");setDigits(Array(6).fill(""));
    try{const next=await accountApi.resend(phone);setState(next);}
    catch(reason){setError(reason instanceof AccountApiError&&reason.status===500?genericError:errorMessage(reason));if(reason instanceof AccountApiError && reason.detail.otp)setState(reason.detail.otp);else void refresh(phone,true);}
    finally{setBusy(false);}
  }
  const mm=String(Math.floor(remaining/60)).padStart(2,"0"),ss=String(remaining%60).padStart(2,"0");
  return <AuthLayout title="تحقق من رقمك" copy="أدخل رمز التحقق المكوّن من ستة أرقام.">
    <section className="sc-panel">
      <p className="sc-help">رقم الهاتف: <b className="sc-ltr" style={{display:"inline-block"}}>{phone}</b></p>
      {sendCopy&&<p className={`sc-alert${deliveryConfirmed||(sendStatus==="api_accepted"&&!deliveryFailed)?" success":""}`} role="status" style={{marginTop:14}}>{sendCopy}</p>}
      {error&&<p className="sc-alert" role="alert" style={{marginTop:14}}>{error}</p>}
      {!state&&<button className="sc-btn secondary" type="button" onClick={()=>void refresh(phone)} disabled={!phone}>إعادة تحميل حالة التحقق</button>}
      <form className="sc-form" onSubmit={verify} style={{marginTop:18}}>
        <div className="sc-otp-boxes" role="group" aria-label="رمز التحقق المكوّن من ستة أرقام">
          {digits.map((digit,index)=><input key={index} ref={el=>{refs.current[index]=el;}} className="sc-otp-digit" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete={index===0?"one-time-code":"off"} aria-label={`الخانة ${index+1}`} value={digit} onChange={e=>changeDigit(index,e.target.value)} onKeyDown={e=>{if(e.key==="Backspace"&&!digits[index]&&index>0)refs.current[index-1]?.focus();}}/> )}
        </div>
        <div className="sc-inline"><span className="sc-help">الوقت المتبقي</span><span className="sc-time" aria-live="off">{remaining?`${mm}:${ss}`:"انتهت الصلاحية"}</span></div>
        <button className="sc-btn" type="submit" disabled={busy||digits.join("").length!==6}>{busy?"جارٍ التحقق…":"تحقق من الرمز"}</button>
      </form>
      <hr className="sc-rule"/>
      <div className="sc-inline"><p className="sc-help">لم يصلك الرمز؟</p><button className="sc-btn secondary" type="button" onClick={()=>void resend()} disabled={!canResend||busy}>{busy?"جارٍ الإرسال…":"إعادة إرسال الرمز"}</button></div>
    </section>
  </AuthLayout>;
}
function AccountHome({profile}:ScreenProps) {
  return <><p className="sc-kicker">أهلًا {profile?.name}</p><h1 className="sc-title">مساحتك ومركباتك</h1><p className="sc-lead">إدارة بياناتك ومركباتك المسجلة في مكان واحد.</p>
    <div className="sc-summary"><Link href="/account/vehicles"><strong>مركباتي</strong><span>عرض المركبات وإضافة مركبة جديدة</span></Link><Link href="/account/profile"><strong>الملف الشخصي</strong><span>محافظة السكن وإعدادات الحساب</span></Link></div>
  </>;
}
function ProfilePage({profile}:ScreenProps) {
  const router=useRouter();const [references,setReferences]=useState<AccountReferences|null>(null);const [governorate,setGovernorate]=useState(profile?.homeGovernorateId||"");const [message,setMessage]=useState("");const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [confirm,setConfirm]=useState(false);
  const deleteDialogRef=useRef<HTMLDialogElement|null>(null);const deleteTriggerRef=useRef<HTMLButtonElement|null>(null);const cancelDeleteRef=useRef<HTMLButtonElement|null>(null);
  const loadReferences=useCallback(async()=>{setError("");try{setReferences(await accountApi.references());}catch{setError(genericError);}},[]);
  useEffect(()=>{void loadReferences();},[loadReferences]);
  useEffect(()=>{
    const dialog=deleteDialogRef.current;
    if(confirm&&dialog&&!dialog.open){dialog.showModal();cancelDeleteRef.current?.focus();}
    else if(!confirm&&dialog?.open){dialog.close();deleteTriggerRef.current?.focus();}
  },[confirm]);
  async function save(){setBusy(true);setError("");setMessage("");try{await accountApi.saveProfile(governorate||null);setMessage("تم حفظ التغييرات.");}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  async function logout(){setBusy(true);try{await accountApi.logout();router.replace("/login");}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  async function removeAccount(){setBusy(true);setError("");try{await accountApi.deleteAccount();sessionStorage.removeItem(phoneKey);router.replace("/register");}catch(e){setError(errorMessage(e));setBusy(false);}}
  return <><p className="sc-kicker">إعداداتك</p><h1 className="sc-title">الملف الشخصي</h1><p className="sc-lead">بيانات حسابك ومكان إقامتك.</p>
    <section className="sc-panel sc-form">
      {error&&<p className="sc-alert" role="alert">{error}</p>}{message&&<p className="sc-alert success" role="status">{message}</p>}
      {!references&&<button className="sc-btn secondary" type="button" onClick={()=>void loadReferences()}>إعادة تحميل المحافظات</button>}
      <div className="sc-grid"><Field label="الاسم" id="profile-name"><TextInput id="profile-name" value={profile?.name||""} readOnly aria-readonly="true"/></Field><Field label="رقم الهاتف" id="profile-phone"><TextInput id="profile-phone" className="sc-ltr" dir="ltr" value={profile?.phone||""} readOnly aria-readonly="true"/></Field></div>
      <Field label="محافظة السكن" id="profile-governorate"><select id="profile-governorate" className="sc-select" value={governorate} onChange={e=>setGovernorate(e.target.value)}><option value="">اختر المحافظة (اختياري)</option>{references?.governorates.map(item=><option key={item.id} value={item.id}>{item.nameAr}</option>)}</select></Field>
      <div className="sc-actions"><button className="sc-btn" type="button" onClick={()=>void save()} disabled={busy||!references}>{busy?"جارٍ الحفظ…":"حفظ التغييرات"}</button><button className="sc-btn secondary" type="button" onClick={()=>void logout()} disabled={busy}>تسجيل الخروج</button></div>
      <hr className="sc-rule"/><div><h2 style={{fontSize:18,margin:"0 0 5px"}}>حذف الحساب</h2><p className="sc-help">حذف نهائي لا يمكن التراجع عنه.</p><button ref={deleteTriggerRef} className="sc-btn danger" type="button" onClick={()=>setConfirm(true)} disabled={busy}>حذف الحساب</button></div>
    </section>
    <dialog ref={deleteDialogRef} className="sc-dialog" role="alertdialog" aria-labelledby="delete-title" aria-describedby="delete-copy" onCancel={event=>{event.preventDefault();setConfirm(false);}}>
      <h2 id="delete-title">تأكيد حذف الحساب</h2><p id="delete-copy">سيُحذف حسابك نهائيًا. لا يمكن استعادة الحساب بعد المتابعة.</p>
      {error&&<p className="sc-alert" role="alert">{error}</p>}
      <div className="sc-actions"><button className="sc-btn danger" type="button" onClick={()=>void removeAccount()} disabled={busy}>{busy?"جارٍ الحذف…":"نعم، احذف الحساب"}</button><button ref={cancelDeleteRef} className="sc-btn secondary" type="button" onClick={()=>{setConfirm(false);setError("");}} disabled={busy}>إلغاء</button></div>
    </dialog>
  </>;
}
function VehiclesPage() {
  const [vehicles,setVehicles]=useState<Vehicle[]|null>(null);const [error,setError]=useState("");
  const load=useCallback(async()=>{setError("");try{setVehicles(await accountApi.vehicles());}catch(e){setError(errorMessage(e));}},[]);
  useEffect(()=>{void load();},[load]);
  return <><div className="sc-page-head"><div><p className="sc-kicker">مركباتك المسجلة</p><h1 className="sc-title">مركباتي</h1></div><Link href="/account/vehicles/new" className="sc-btn">إضافة مركبة</Link></div>
    {error&&<div className="sc-panel"><p className="sc-alert" role="alert">{error}</p><button className="sc-btn secondary" onClick={()=>void load()}>إعادة المحاولة</button></div>}
    {vehicles===null&&!error&&<div className="sc-loading" aria-label="جارٍ تحميل المركبات"><div className="sc-skeleton large"/><div className="sc-skeleton large"/></div>}
    {vehicles?.length===0&&<div className="sc-empty"><h2>لا توجد مركبات بعد</h2><p>أضف مركبتك الأولى لتظهر هنا.</p><Link href="/account/vehicles/new" className="sc-btn">إضافة مركبة</Link></div>}
    {!!vehicles?.length&&<div className="sc-vehicle-list">{vehicles.map(vehicle=><article className="sc-vehicle" key={vehicle.id}>
      <div className="sc-inline"><h2>{vehicle.brandGroupName} · {vehicle.brandName}</h2><Link href={`/account/vehicles/${encodeURIComponent(vehicle.id)}/edit`} className="sc-btn secondary">تعديل</Link></div>
      <div className="sc-vehicle-meta"><span>{vehicle.year}</span><span>{vehicle.fuelTypeName}</span><span>{vehicle.vehicleCategory==="car"?"سيارة":"شاحنة"}</span>{vehicle.plateNumber&&<span>اللوحة: {vehicle.plateNumber}</span>}{vehicle.color&&<span>اللون: {vehicle.color}</span>}{vehicle.notes&&<span>علامات مميزة: {vehicle.notes}</span>}</div>
      {vehicle.rejected&&<span className="sc-rejected"><svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.2 18 16H2L10 2.2Z" fill="none" stroke="currentColor" strokeWidth="1.7"/><path d="M10 7v4.2m0 2.2v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>مرفوض</span>}
    </article>)}</div>}
  </>;
}
const blankVehicle:VehicleInput={brandGroupId:"",brandId:"",year:new Date().getFullYear(),fuelTypeId:"",vehicleCategory:"car",plateNumber:null,color:null,notes:null};
function VehicleFormPage({vehicleId}:{vehicleId?:string}) {
  const router=useRouter();const [refs,setRefs]=useState<AccountReferences|null>(null);const [item,setItem]=useState<VehicleInput>(blankVehicle);const [error,setError]=useState("");const [fieldErrors,setFieldErrors]=useState<Record<string,string>>({});const [busy,setBusy]=useState(false);const [loading,setLoading]=useState(!!vehicleId);
  const brands=useMemo(()=>refs?.brands.filter(brand=>brand.brandGroupId===item.brandGroupId)||[],[refs,item.brandGroupId]);
  const load=useCallback(async()=>{setLoading(true);setError("");try{const [references,vehicle]=await Promise.all([accountApi.references(),vehicleId?accountApi.vehicle(vehicleId):Promise.resolve(null)]);setRefs(references);if(vehicle)setItem({brandGroupId:vehicle.brandGroupId,brandId:vehicle.brandId,year:vehicle.year,fuelTypeId:vehicle.fuelTypeId,vehicleCategory:vehicle.vehicleCategory,plateNumber:vehicle.plateNumber,color:vehicle.color,notes:vehicle.notes});}catch(reason){setError(errorMessage(reason));}finally{setLoading(false);}},[vehicleId]);
  useEffect(()=>{void load();},[load]);
  function update<K extends keyof VehicleInput>(key:K,value:VehicleInput[K]){setItem(current=>({...current,[key]:value}));}
  async function submit(event:React.FormEvent<HTMLFormElement>){event.preventDefault();setError("");setFieldErrors({});
    const currentYear=new Date().getFullYear();if(!item.brandGroupId||!item.brandId||!item.fuelTypeId){setError("أكمل الحقول الإلزامية.");return;}if(!Number.isInteger(item.year)||item.year<1970||item.year>currentYear){setFieldErrors({year:`اختر سنة بين 1970 و${currentYear}.`});return;}
    if(!brands.some(brand=>brand.id===item.brandId)){setFieldErrors({brandId:"اختر ماركة من المجموعة المحددة."});return;}
    const payload:VehicleInput={...item,plateNumber:item.plateNumber?.trim()||null,color:item.color?.trim()||null,notes:item.notes?.trim()||null,year:Number(item.year)};
    setBusy(true);try{if(vehicleId)await accountApi.editVehicle(vehicleId,payload);else await accountApi.addVehicle(payload);router.push("/account/vehicles");}catch(e){if(e instanceof AccountApiError&&e.detail.fields)setFieldErrors(e.detail.fields);setError(errorMessage(e));}finally{setBusy(false);}
  }
  if(loading)return <><p className="sc-kicker">مركباتك</p><h1 className="sc-title">جارٍ تحميل المركبة</h1><div className="sc-loading"><div className="sc-skeleton large"/></div></>;
  return <><p className="sc-kicker">مركباتك</p><h1 className="sc-title">{vehicleId?"تعديل المركبة":"إضافة مركبة"}</h1><p className="sc-lead">أدخل بيانات المركبة الأساسية.</p>
    <form className="sc-panel sc-form" onSubmit={submit} noValidate>
      {error&&<><p className="sc-alert" role="alert">{error}</p>{!refs&&<button className="sc-btn secondary" type="button" onClick={()=>void load()}>إعادة المحاولة</button>}</>}
      <div className="sc-grid">
        <Field label="مجموعة الماركة" id="vehicle-group"><select id="vehicle-group" className="sc-select" required value={item.brandGroupId} onChange={e=>{update("brandGroupId",e.target.value);update("brandId","");}}><option value="">اختر المجموعة</option>{refs?.brandGroups.map(value=><option key={value.id} value={value.id}>{value.nameAr}</option>)}</select>{fieldErrors.brandGroupId&&<p className="sc-help" role="alert">{fieldErrors.brandGroupId}</p>}</Field>
        <Field label="الماركة" id="vehicle-brand"><select id="vehicle-brand" className="sc-select" required disabled={!item.brandGroupId} value={item.brandId} onChange={e=>update("brandId",e.target.value)}><option value="">اختر الماركة</option>{brands.map(value=><option key={value.id} value={value.id}>{value.nameAr}</option>)}</select>{fieldErrors.brandId&&<p className="sc-help" role="alert">{fieldErrors.brandId}</p>}</Field>
        <div className="sc-field"><label className="sc-label" htmlFor="vehicle-year">سنة الصنع</label><p className="sc-help">(1970–1999) كلاسيكية · (2000–2011) متوسطة · (2012–الآن) حديثة</p><TextInput id="vehicle-year" type="number" min={1970} max={new Date().getFullYear()} required value={item.year} onChange={e=>update("year",Number(e.target.value))} aria-invalid={!!fieldErrors.year}/>{fieldErrors.year&&<p className="sc-help" role="alert">{fieldErrors.year}</p>}</div>
        <Field label="نظام الطاقة" id="vehicle-fuel"><select id="vehicle-fuel" className="sc-select" required value={item.fuelTypeId} onChange={e=>update("fuelTypeId",e.target.value)}><option value="">اختر نظام الطاقة</option>{refs?.fuelTypes.map(value=><option key={value.id} value={value.id}>{value.nameAr}</option>)}</select>{fieldErrors.fuelTypeId&&<p className="sc-help" role="alert">{fieldErrors.fuelTypeId}</p>}</Field>
        <Field label="فئة المركبة" id="vehicle-category"><select id="vehicle-category" className="sc-select" required value={item.vehicleCategory} onChange={e=>update("vehicleCategory",e.target.value as VehicleInput["vehicleCategory"])}><option value="car">سيارة</option><option value="truck">شاحنة</option></select></Field>
        <Field label="رقم اللوحة (اختياري)" id="vehicle-plate"><TextInput id="vehicle-plate" value={item.plateNumber||""} onChange={e=>update("plateNumber",e.target.value||null)}/>{fieldErrors.plateNumber&&<p className="sc-help" role="alert">{fieldErrors.plateNumber}</p>}</Field>
        <Field label="اللون (اختياري)" id="vehicle-color"><TextInput id="vehicle-color" value={item.color||""} onChange={e=>update("color",e.target.value||null)}/></Field>
      </div>
      <Field label="علامات مميزة (اختياري)" id="vehicle-notes"><textarea id="vehicle-notes" className="sc-textarea" value={item.notes||""} onChange={e=>update("notes",e.target.value||null)}/></Field>
      <div className="sc-actions"><button className="sc-btn" type="submit" disabled={busy||!refs}>{busy?"جارٍ الحفظ…":"حفظ المركبة"}</button><Link className="sc-btn secondary" href="/account/vehicles">إلغاء</Link></div>
    </form>
  </>;
}
export default function AccountApp() {
  const pathname=usePathname();
  if(pathname==="/register")return <RegisterPage/>;
  if(pathname==="/login")return <LoginPage/>;
  if(pathname==="/otp")return <OtpPage/>;
  if(pathname==="/account/profile")return <Protected context="الملف الشخصي">{profile=><ProfilePage profile={profile}/>}</Protected>;
  if(pathname==="/account/vehicles/new")return <Protected context="إضافة مركبة">{()=> <VehicleFormPage/>}</Protected>;
  const edit=pathname.match(/^\/account\/vehicles\/([^/]+)\/edit$/);
  if(edit)return <Protected context="تعديل المركبة">{()=> <VehicleFormPage vehicleId={decodeURIComponent(edit[1])}/>}</Protected>;
  if(pathname==="/account/vehicles")return <Protected context="مركباتي">{()=> <VehiclesPage/>}</Protected>;
  return <Protected context="الرئيسية">{profile=><AccountHome profile={profile}/>}</Protected>;
}