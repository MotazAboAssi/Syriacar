# Syriacar — Final UI/UX Implementation Specification for Replit

**Version:** 1.3
**Basis:** reconciled SRS Syriacar v1.4 + approved product-owner decisions + DBMS v2.2
**Target:** Replit implementation of the frontend/UI only
**Language:** Arabic only
**Direction:** RTL
**Platform:** Web PWA, Mobile-First
**Launch scope:** صحنايا، ريف دمشق

**Final reconciliation — 2026-10-03:** documentation only. القواعد أدناه متسقة مع SRS/DBMS؛ لا تنفيذ ضمن هذه المصالحة. OTP تلقائي hash-only مع مراقبة نتائج الإرسال بلا دعم شفهي؛ المحلية اليدوية إلزامية للفحص، وwork_days مصدر ساعات العمل الوحيد.

### سجل التغييرات من v1.2 إلى v1.3

| # | الشاشة/القسم | التغيير |
|---|---|---|
| 1 | U-14 — Tow Results | إضافة قاعدة ترتيب القسم الأول: مقر الانطلاق أولاً ← مقر الوصول ← عشوائي |
| 2 | U-14 — Tow Results | إضافة رسالة no_match في القسم الأول الفارغ مع `contact_phone` |
| 3 | U-12 — No Matching Inspection | تحديث: الرسالة تتضمن رقم الفريق من `system_config.contact_phone` |
| 4 | P-03 — Provider Availability | إضافة ملاحظة: reset تلقائي لـ`today_closed` عند 00:00 Asia/Damascus |
| 5 | §14 Acceptance Criteria | إضافة AC-24 وAC-25 |

---

### سجل التغييرات من v1.1 إلى v1.2

| # | الشاشة/القسم | التغيير |
|---|---|---|
| 1 | O-06b — تعذّر إرسال OTP | مصالحة نهائية: العرض من outcomes المحفوظة بعد محاولتين، لا الوقت وحده |
| 2 | O-06b — تعذّر إرسال OTP | قراءة فقط؛ إزالة إجراء الاتصال اليدوي وحقوله |
| 3 | S-04 — CSV Export | توضيح مصدر عمود المحافظة: join مختلف لـinspection vs towing |

---

### سجل التغييرات من v1.0 إلى v1.1

| # | الشاشة/القسم | التغيير |
|---|---|---|
| 1 | O-02 — Providers | إضافة حقل «رقم واتساب» (`whatsapp_number`) إلزامي في نموذج إنشاء/تعديل المزود |
| 2 | O-02 — Providers | إخفاء حقول capabilities (brands/year_categories/fuel_types/vehicle_categories) عند service_type=towing |
| 3 | O-06 — Notification Timeline | O-06b: مراقبة تعذّر إرسال OTP، لا قناة OTP بديلة |
| 4 | U-11, U-15, U-16 | توضيح: wa.me يستخدم `providers.whatsapp_number` لا `phone` |
| 5 | §7 Data → UI Rules (Providers) | إضافة: whatsapp_number لا يُعرَض للمستخدم النهائي |
| 6 | §13 Data adapters | إضافة `whatsapp_number` في providers adapter |

---

## 0. تنفيذ هذه الوثيقة

ابنِ واجهات Syriacar وفق هذه الوثيقة حرفيًا.

### قواعد إلزامية

- لا تضف أي وظيفة غير مذكورة هنا أو في SRS.
- لا تنشئ حجزًا، دفعًا، تتبعًا، تقييمات، دردشة، عروضًا، تسعيرًا، أو AI.
- لا تغيّر DB schema أو business rules.
- لا تجعل WhatsApp إرسالًا آليًا للمزود؛ المستخدم نفسه يضغط Send في WhatsApp.
- WhatsApp API يستخدم للـOTP فقط.
- Push للمزود اختياري ولا يعتمد عليه أي workflow أساسي.
- لا تجعل GPS أو الخريطة نقطة فشل للرحلة؛ يجب وجود fallback اليدوي المحدد.
- لا تعرض الحقول التقنية للمستخدم النهائي.
- لا تعرض `pending_verification` للمستخدم.
- لا تجعل `year_category` حقلاً قابلاً للتحرير.
- نتائج السطحة List فقط؛ لا تضف Map.
- نتائج الفحص: Map أساسي، List فقط كـfallback عند تعذر/تأخر الخريطة.
- Light Mode فقط في MVP.
- لا Infinite Scroll في جداول Operations/Super Admin؛ استخدم Pagination.

---

# 1. Design Principles

| المبدأ | التطبيق |
|---|---|
| الخدمة أولاً | الضيف يستطيع الفحص والسطحة دون تسجيل. |
| اكتشاف ثم تواصل | النهاية الوظيفية = مزود مناسب/متاح → «أبلغ المزود» → WhatsApp/رقم الهاتف. |
| لا حجز | لا تستخدم copy أو visual states توحي بأن الخدمة تم قبولها أو حجزها. |
| Fallback أولاً | رفض GPS أو فشل/بطء الخريطة يؤدي إلى الاختيار اليدوي/القائمة النصية. |
| الثقة عبر معلومات المزود | بطاقة المزود تعرض بيانات الخدمة والملاءمة بدل الاعتماد على الاسم فقط. |
| Mobile-first | CTA كبيرة، محتوى مختصر، Forms قصيرة، بدون عناصر زخرفية ثقيلة. |
| الوضوح بين الحالة واللون | كل status = نص + icon + color؛ اللون ليس الدلالة الوحيدة. |

---

# 2. Design System

## 2.1 Foundation

**Tailwind CSS + shadcn/ui** — Component-first. RTL-first. Mobile-first.

## 2.2 Typography

**Font:** IBM Plex Arabic

| Token | Size | Weight |
|---|---:|---:|
| body | 14–16px | 400 |
| body-medium | 14–16px | 500 |
| label | 14px | 500 |
| button | 14–16px | 600 |
| card-title | 16–18px | 600 |
| section-title | 18–20px | 600 |
| page-title | 22–24px | 700 |
| KPI | 24–32px | 700 |

Body text must be ≥14px.

## 2.3 Colors

```text
primary        #166534
primary-hover  #14532D
secondary      #334155
background     #F8FAFC
surface        #FFFFFF
text           #0F172A
muted          #475569
border         #CBD5E1
success        #15803D
error          #B91C1C
warning        #A16207
info           #0369A1
```

### Semantic state tokens

| الحالة | Text | Icon |
|---|---|---|
| مناسب لمركبتك | ✓ مناسب لمركبتك | Check |
| غير مطابق | غير مطابق | X / Status icon |
| مفتوح الآن | مفتوح الآن | Clock/Check |
| مغلق | مغلق | Clock/X |
| موثّد | موثّق | Check |
| Pending | منتظر | Clock |
| Rejected | مرفوض | X |

## 2.4 Spacing

`4 / 8 / 12 / 16 / 24 / 32 / 40 / 48px`

- Screen padding mobile: 16px.
- Gap between fields: 16px.
- Section gap: 24–32px.

## 2.5 Radius

```text
input      8px
button     8px
card       12px
dialog     16px
badge      999px
```

## 2.6 Shadows
- Card: subtle. Dialog/Sheet: medium. No decorative/heavy shadows.

## 2.7 Icons
**Lucide Icons**. Use icon + text for important states.

## 2.8 Breakpoints

```text
<640px   Mobile
640px    Large mobile
768px    Tablet
1024px   Desktop
1280px   Large desktop
```

Minimum supported width = 320px.

## 2.9 Accessibility

- `dir="rtl"` globally.
- Touch target ≥44×44px.
- Body ≥14px.
- Visible keyboard focus.
- Labels associated with controls.
- Do not rely on color alone.
- Phone numbers and technical strings use isolated LTR containers where needed.

## 2.10 Dark Mode
**Not implemented in MVP.**

---

# 3. Information Architecture

## 3.1 Public / Guest

```text
Home
├── فحص مركبة
└── سطحة
```

## 3.2 Registered User

```text
الرئيسية
مركباتي
الملف
```

## 3.3 Provider

```text
الإشعارات
إدارة المزود
```

Inside «إدارة المزود»:
```text
توفر المزود
موقع المركز
قدرات الفحص  ← تظهر للفحص فقط
طلبات تعديل البيانات
```

## 3.4 Operations

Desktop/tablet: Side Navigation.

```text
المزودون
الماركات
القوائم
قوالب الرسائل
الإشعارات  ← يشمل تعذّر إرسال OTP (O-06b)
التنبيهات
المركبات
Audit Log
```

Mobile: collapsible Drawer.

## 3.5 Super Admin

```text
مؤشرات الأداء
موظفو Operations
التقارير
رقم التواصل
```

---

# 4. Global UI Rules

## Header

Public/User: Syriacar brand + current context + account action.
Provider: Syriacar + Provider context + notification + management access.
Operations/Super Admin: Dashboard role name + current section + side navigation/Drawer.

## Buttons

Primary action is a single dominant CTA.

Examples:
- إنشاء حساب / دخول / أبلغ المزود / أرسل موقعي / حفظ
- Verified/Rejected actions in Operations
- تصدير CSV
- O-06b read-only؛ لا CTA لمعالجة OTP يدوياً

Destructive actions use confirmation.

## Forms

- RTL labels.
- Required marker only where required.
- Validation shown beside/under field.
- No technical error strings.

## Loading
Skeletons for content loading. Disable initiating action while mutation is in progress.

## Error
Short Arabic message + retry/fallback where SRS defines one.

## API Error Messages

| HTTP Code | السيناريو            | الرسالة العربية                              | Action          |
|-----------|----------------------|----------------------------------------------|-----------------|
| 401       | جلسة منتهية         | انتهت جلستك. الرجاء تسجيل الدخول مجدداً.   | Redirect login  |
| 403       | لا صلاحية           | غير مصرح لك بهذا الإجراء.                   | لا action       |
| 404       | مورد غير موجود      | لا توجد بيانات.                              | لا action       |
| 409       | تعارض (هاتف مكرر)   | الرقم مسجَّل مسبقاً.                        | لا action       |
| 422       | بيانات غير صالحة    | رسالة الحقل المُخطئ من الـbackend           | Highlight field |
| 429       | rate limit OTP       | يرجى الانتظار دقيقتين قبل إعادة الإرسال.   | Disable resend  |
| 500       | خطأ خادم            | حدث خطأ. حاول مجدداً.                       | Retry button    |

---

# 5. Screen Specifications

## U-01 — Home / Landing

**Role:** Guest + Registered User

```text
Header
↓
عنوان قصير
↓
[ فحص مركبة ]
[ سطحة ]
```

No search, offers, ratings, bookings, or other cards.

---

## U-02 — Registration

**Source:** FR-ACC-001–007b

Fields: الاسم — رقم الهاتف (+963 only) — كلمة المرور — إنشاء حساب

Success → OTP.

---

## U-03 — OTP Verification

**Source:** FR-ACC-002–007b

```text
رقم الهاتف → 6 digit OTP → مؤقت 10 دقائق → إعادة الإرسال
```

Rules: 6 digits. Valid 10 minutes from current code's send attempt. Max 5 verification attempts. Resend enabled after expiry/verification invalidation and at least 2 minutes since last send attempt; new challenge invalidates old one. Account remains inactive until correct OTP.

Automatic send: first attempt + one retry after failure/unknown result and 5 seconds, at most two attempts, per SRS REQ-WA-006–009. Retry generates a new code/hash and invalidates the old code; backend supplies current expiry without exposing code/hash. User message distinguishes «قُبل طلب الإرسال» from confirmed delivery; API acceptance alone never becomes «تم التوصيل». Failure: «تعذّر إرسال رمز التحقق. ستتم إعادة المحاولة تلقائياً.» ثم بعد الاستنفاد «تعذّر إرسال رمز التحقق. يمكنك إعادة الإرسال عند إتاحة الزر.» Unknown: «تعذّر تأكيد الإرسال.» No staff-verbal fallback. Cooldown/expiry is enforced by backend, not UI alone.

---

## U-04 — Login

```text
رقم الهاتف → كلمة المرور → [ دخول ]
```

Session expires after 30 days.

---

## U-05 — Profile / Settings

Show: الاسم — رقم الهاتف — محافظة السكن — حذف الحساب.
Home governorate: optional; pre-fills Tow origin.
Delete: Confirmation dialog → final delete. Irreversible.

---

## U-06 — My Vehicles

```text
عنوان → Vehicle cards → [ إضافة مركبة ]
```

Vehicle card: show identifying data; do not expose pending-verification status.

---

## U-07 — Add/Edit Vehicle

Fields: مجموعة الماركة — الماركة — سنة الصنع — نظام الطاقة — فئة المركبة — رقم اللوحة (optional) — اللون (optional) — علامات مميزة (optional) — حفظ

Year helper: `(1970–1999) كلاسيكية · (2000–2011) متوسطة · (2012–الآن) حديثة`

`year_category`: do not render as Select — derived from year.
VIN must not appear.

---

# Inspection Flow

## U-08 — Inspection Location

**Source:** FR-INS-001–005

```text
المحافظة → المنطقة التابعة لها → متابعة → نتائج المحلية المختارة
خيار GPS اختياري للعرض فقط؛ لا يُلغي اختيار المحلية
```

اختيار المحلية إلزامي دائماً؛ region قائمة تابعة للمحافظة وتُمسح عند تغييرها. خيار «استخدام موقعي» يدعم عرض الخريطة فقط ولا يستبدل الاختيار ولا reverse geocoding.

If map loading >5 seconds → Text Provider List for the same selected locality. GPS coordinates must not be persisted; selected inspection_governorate_id/inspection_region_id must be persisted on confirmed inspection requests.

---

## U-09 — Inspection Results

Primary mode: Map (OpenStreetMap / Leaflet).

Map: active/open inspection providers in selected governorate + region only; suitable marker (registered) also requires matching saved vehicle capabilities; guest sees all active/open in that locality equally. No distance/radius matching.

Fallback: text list — business name + region + phone.

Closed providers never appear.

---

## U-10 — Inspection Provider Card

Required content:
1. الاسم التجاري
2. المنطقة
3. مجموعات الماركات
4. الماركات
5. فئات السنوات
6. أنظمة الطاقة
7. فئة المركبة
8. التخصصات
9. ساعات العمل
10. أبلغ المزود

Mobile → Bottom Sheet. Desktop → Side Sheet/Panel. No booking CTA.

---

## U-11 — Notify Provider Confirmation

```text
ملخص العملية → بيانات/تنبيه التواصل → [ تأكيد ] [ إلغاء ]
```

Guest first enters name/phone then sees the confirmation/disclosure. Registered uses account identity and selected saved vehicle.

On confirm:
1. first notification creates `service_request` with inspection locality; later providers reuse the same request
2. create `notification` transactionally with its parent; no records on render/cancel
3. open `wa.me/{providers.whatsapp_number}?text={encoded_message}` ← **يستخدم whatsapp_number**
4. user sends message manually
5. show provider **phone** number (للاتصال الهاتفي)

Guest: show disclosure about name/phone being sent/stored.

---

## U-12 — No Matching Inspection Provider

Message: `لا يوجد مزود مطابق في نطاقك — يمكنك التواصل معنا على {system_config.contact_phone}`

الرقم يُقرأ من `system_config.contact_phone` — لا hardcode في الواجهة.
يُعرَض الرقم داخل LTR container (رقم هاتف).

Do not invent additional services.

Guest no-match: inspection → governorate/region → guest name/phone → confirmation → create no_match service_request with locality. No provider-selection step, notification, search expansion, or wa.me in this path. Registered: same locality + saved vehicle/account identity → confirmation → no_match request. Render/refresh alone never creates a request.

---

# Tow Flow

## U-13 — Tow Governorates

Fields: محافظة الانطلاق — محافظة الوصول — متابعة

Registered: origin prefilled from home governorate if available.
Guest: both empty.

---

## U-14 — Tow Results

**List only. No map.**

Section A: `مناسب لمشكلتك` — active/open towing providers covering both origin + destination.
**ترتيب القسم الأول:** مزود مقره = محافظة الانطلاق أولاً ← مقره = محافظة الوصول ثانياً ← الباقون عشوائياً. الترتيب لا يُعرَض كـlabel — هو ترتيب العرض فقط.
Fixed warning: `التغطية الدقيقة داخل المحافظة تُحدَّد بالاتصال مع المزود.`

**إن كان القسم الأول فارغاً:** تظهر رسالة داخله:
`لا يوجد مزود يغطي هذا المسار — يمكنك التواصل معنا على {system_config.contact_phone}`
الرقم داخل LTR container. القسم الثاني يبقى مرئياً.

Section B: `باقي المزودين` — active/open towing providers not covering both governorates; visible even if Section A is empty. Closed/non-active providers never appear in either section.

---

## U-15 — Tow Provider Card

Show: الاسم التجاري — المحافظات التي يغطيها — نوع السطحة — رقم الهاتف — أبلغ المزود

On «أبلغ المزود»: guest enters name/phone before confirmation; first confirmation creates service_request + notification transactionally then opens wa.me/{providers.whatsapp_number}. Later providers reuse the same request and identity. Any notified Section A provider → request matched; all notified Section B providers → no_match. Status exists only on request; no per-notification status, and later B notifications do not downgrade matched.

Mobile → Bottom Sheet. Desktop → Side Sheet/Panel.

---

## U-16 — Tow Notify Success / Send Location

```text
تم إرسال الإشعار
↓
رقم المزود (phone)
↓
[ أرسل موقعي ]
```

wa.me link for location: `wa.me/{providers.whatsapp_number}?text={encoded_location_message}` ← **يستخدم whatsapp_number**

Send location flow:
```text
GPS
├── Success → open WhatsApp with Google Maps link
└── Failure → Governorate → Region manual selection
```

After manual selection → open WhatsApp with governorate + region names in message; no geocoding. User presses Send in either branch. towing_location: `Syriacar — [الاسم] — سطحة — موقعي: [الموقع]`; location is Google Maps URL when GPS exists, otherwise `محافظة [اسم المحافظة]، منطقة [اسم المنطقة]`. Manual region belongs to selected governorate. It describes location sharing, not a change to origin/destination; no coordinate history.

Fixed towing warning: `التواصل يعتمد على استجابة المزود، والإشعار ليس حجزًا ولا ضمانًا.`

---

# Provider UI

## P-01 — Provider Login

Fields: phone + password. Session: 30 days.

---

## P-02 — Provider Notifications

List: reverse chronological. Each item: date/time + service type + user name + user phone.

Read-only: no edit, no delete. Empty state: neutral.

---

## P-03 — Provider Availability

Fields: per-day Work days entries (enabled + Start time + End time for each day) — «لا أعمل اليوم». Source is work_days only; no work_start/work_end operational fields. Enabled day requires one valid same-day interval; disabled day has null start/end.

Default: every day except Friday, 08:00–20:00.

`is_open` is derived; never render as editable.
Calculated from selected Damascus weekday's enabled/start/end + today's closure override. Preview and matching use the same rule.
`today_closed_date` never directly edited by provider.
**Reset تلقائي:** `today_closed` يعود إلى `false` تلقائياً عند 00:00 Asia/Damascus بواسطة scheduled job — لا يحتاج المزود لفعل شيء في اليوم التالي.

---

## P-04 — Provider Location

Action: `حدد موقعي الحالي`

```text
طلب GPS → معاينة الموقع → حفظ
```

Store: `location_lat + location_lng` (canonical). `location_url` optional.

---

## P-05 — Inspection Capabilities

**تظهر لمزود الفحص فقط — تُخفى لمزود السطحة.**

Editable groups:
- مجموعات الماركات
- الماركات
- فئات السنوات
- أنظمة الطاقة
- فئات المركبات

Save applies immediately to matching.

---

## P-06 — Specializations Input

Free-entry chips/tags. No fixed catalog. No predefined list.

---

## P-07 — Provider Edit Requests

Current editable targets: الاسم التجاري — رقم الهاتف — المحافظات المغطاة (للسطحة)

```text
طلب جديد → نوع الحقل → القيمة المطلوبة → إرسال → pending → approved / rejected
```

Never show raw JSON syntax.

---

## P-08 — Provider Push

Optional. When supported: browser notification. When unsupported: no error state. Push click: open related notification record.

---

location_url: داخلي فقط — لا يُعرَض في أي شاشة
مستخدم أو مزود. يُعرَض في O-02 فقط كأيقونة
«عرض الموقع» تفتح الرابط في tab جديد (للاستخدام
الداخلي لـOperations أثناء مراجعة بيانات المزود).


# Operations UI

## O-01 — Operations Login

`username + password → login`

---

## O-02 — Providers

### List
Data Table with filtering. No password_hash/UUIDs.

في جدول قائمة المزودين: أضف عمود «الموقع» يحتوي
أيقونة link تفتح location_url في tab جديد.
تظهر الأيقونة فقط إن كان location_url NOT NULL.

### Actions
- create
- edit
- status management

### Provider create/edit form

Sections:

**1. البيانات العامة**
- الاسم التجاري (إلزامي)
- رقم الهاتف (إلزامي؛ E.164؛ للدخول)
- **رقم واتساب (إلزامي؛ E.164؛ للإشعارات)** ← **جديد**
- كلمة المرور (إلزامي — عند الإنشاء)

**2. نوع الخدمة**
- inspection / towing (إلزامي)

**3. المحافظة والمنطقة**
- المحافظة (إلزامي)
- المنطقة (إلزامي)

**4. الموقع**
- GPS / location_lat + location_lng (اختياري)

**5. جدول العمل**
- work_days: enabled + وقت البدء والنهاية لكل يوم؛ نفس عقد P-03، بلا حقول ساعات عامة منفصلة (إلزامي)

**6. القدرات — تظهر فقط عند service_type = inspection**
- مجموعات الماركات
- الماركات
- فئات السنوات
- أنظمة الطاقة
- فئات المركبات

> **قاعدة:** عند service_type = towing، يُخفى القسم 6 بالكامل. لا تُعرَض حقول capabilities لمزود السطحة.

**7. التغطية — تظهر فقط عند service_type = towing**
- المحافظات المغطاة (multi-select)

**8. نوع السطحة — يظهر فقط عند service_type = towing**
- من قائمة tow_types

---

## O-03 — Brand Groups / Brands

Hierarchy: Brand Groups → Brands.
Operations: create/edit groups, add/edit brands, reorder, activate/deactivate.

---

## O-04 — Reference Lists

Managed: governorates — regions — fuel types — tow types.
Actions: add, deactivate, reorder.

---

## O-05 — Message Templates

Fields: key — Arabic template — updated timestamp.
Bootstrap keys: inspection_registered, inspection_guest, towing_registered, towing_guest, towing_location.

---

## O-06 — Notification Timeline

```text
Filters → Timeline (newest first) → Notification details → Follow-up
```

Filters: service type — date — follow-up status.
Follow-up values: pending / service_completed / provider_no_response / issue.
Additional fields: note + operator + time.

---

## O-06b — تعذّر إرسال OTP (ضمن قسم الإشعارات)

**السياق:** بعد استنفاد محاولتي الإرسال تُعرض failed/unknown outcomes المحفوظة أو provider failed للمحاولة الحالية. صلاحية challenge ليست حالة إرسال؛ لا استنتاج فشل من عدم استخدام OTP.

### الموضع
Badge/section منفصل داخل O-06 يظهر فقط عند وجود سجلات تستوفي الفلتر أدناه؛ للقراءة فقط.

### المحتوى
```text
[ ! ] تعذّر إرسال OTP (N)
↓
جدول/قائمة:
- رقم الهاتف (LTR container)
- وقت الطلب (created_at)
- نتيجة الإرسال / السبب المنقَّح
```

### القواعد
- **الكود لا يُعرَض أبداً** — أمان.
- الفلتر: `consumed_at IS NULL AND expires_at > NOW() AND send_attempt_count = 2 AND retry_at IS NULL AND (send_status IN ('failed','unknown') OR delivery_status = 'failed')`.
- لا كود أو hash أو message body، ولا إجراء اتصال/استرجاع/إرسال يدوي. لا OTP شفهي بعد المحاولتين أو في أي حالة.
- api_accepted/pending لا يظهران وحدهما كفشل؛ unknown = «تعذّر تأكيد الإرسال»، لا «فشل التوصيل». delivered/read دليل الوصول فقط من status موثوق.
- الاستهلاك/الانتهاء أو تصحيح النتيجة يزيل السجل؛ retry تلقائي محدود ومؤقت ومحفوظ في backend، ثم إعادة الإرسال من المستخدم حسب U-03.
- رقم الهاتف يُعرَض في LTR container.
- Badge العدد يختفي عند حل جميع السجلات.
- Empty state: `لا توجد محاولات إرسال OTP متعثرة`.
- الصلاحية: operations + super_admin.

---

## O-07 — Duplicate Request Alert

Trigger: registered user with 3+ same-type requests on same calendar day. Guests excluded.

Alert card/table: user identifier + request count + providers notified.
Computed — not stored. Must not block user.

---

## O-08 — Audit Log

Read-only table. Columns: employee + timestamp + action + entity + old value + new value. No Delete CTA.

---

## O-09 — Vehicle Verification

List filtered to `pending_verification`. Show vehicle data. Actions: Verified / Rejected.
`pending_verification` not shown to registered user.

---

# Super Admin UI

## S-01 — Super Admin Login

Authentication follows admin login pattern.

---

## S-02 — Operations Users

Table: name + username + role + active status.
Actions: create + edit + block.
Roles: operations / super_admin.
RBAC fixed in code — no dynamic permissions editor.

---

## S-03 — KPI Dashboard

Only these KPI families:
1. Total service requests — daily
2. Total service requests — weekly
3. Total service requests — monthly
4. No-match request percentage
5. Guest vs registered percentage
6. `service_completed` percentage among followed-up notifications

No additional business KPIs.

---

## S-04 — CSV Export

Single CTA: `تصدير CSV`

States: loading + success + error.

Do not build a column-picker. Backend contract:

| العمود | المصدر |
|---|---|
| id | service_requests.id |
| نوع الخدمة | service_requests.service_type |
| الحالة | service_requests.matching_status |
| تاريخ الإنشاء | service_requests.created_at |
| المحافظة | للفحص: `notifications.provider_id → providers.governorate_id → governorates.name_ar`؛ للسطحة: `service_requests.origin_governorate_id → governorates.name_ar` |
| رقم الهاتف | users.phone أو service_requests.guest_phone |
| اسم المزود | providers.business_name (via first notification JOIN) |

First notification is earliest created_at, with id as tie-breaker; same first notification supplies inspection governorate/provider name. no_match inspection without notifications has blank provider name/governorate in this existing provider-based export; stored inspection locality is not substituted into it. Preserve the approved seven columns.

---

## S-05 — System Contact Phone

**Source:** FR-SAD-005؛ Super Admin فقط. مدخل «رقم التواصل» داخل LTR container + حفظ. المصدر system_config.key=contact_phone؛ E.164 إلزامي، يُحدَّث value/updated_by/updated_at ويُسجَّل audit إداري. States: loading/loaded/saving/success/validation error/server error. operations لا يرى رابط التعديل ولا يملك صلاحية backend. لا CRUD للمفاتيح أو نظام إعدادات عام.

---

# 6. Component States

## Button
default / hover / active / disabled / loading / focus

## Input
empty / filled / focused / invalid / disabled / read-only

## Select
closed / open / selected / invalid / disabled

## Provider Card
open provider / suitable provider / non-suitable provider / selected / compact-mobile

## Status Badge
suitable / unsuitable / open / closed / pending / verified / rejected

## Map
loading skeleton / loaded / timeout → text fallback / location denied → manual selection / provider pin selected

## Bottom Sheet
closed / open / loading / content

## Dialog
open / confirm / cancel / mutation loading / error

## Toast
success / error / info

## Empty State
Neutral text and no invented action. Use `لا توجد بيانات` when no exact SRS copy exists.

---

# 7. Data → UI Rules

## Users
Show: name + phone + home governorate.
Never show: password_hash + internal IDs.

## Vehicles
Show: brand group + brand + year + fuel type + vehicle category + plate (if present) + color (if present) + notes (if present).
Do not show: VIN + internal verification pending status + UUID.

## Providers
Show where required: business name + phone + service type + governorate/region + location + work schedule + specializations + tow type + capabilities/coverage.
Do not show: password_hash + internal IDs + created_by + **whatsapp_number (not shown to end users — used only for wa.me link construction)**.

## Notifications
Provider view: date/time + service type + user name + user phone.
Operations: notification/service context + follow-up data + operator context.

## Reference data
Show human labels, never raw IDs: governorates + regions + brand groups + brands + fuel types + tow types.

## Operations Users
Super Admin view: name + username + role + active status.

## Audit Log
Operations: employee + time + action + entity + old/new values.

## Provider Edit Requests
Provider + Operations: field name as Arabic label + requested value as human-readable + status + reviewed at.
Never show raw JSON syntax.

## Message Templates
Operations: key + Arabic template + updated at.

## Service Requests / OTP
Inspection locality is required and region must belong to governorate; towing has NULL inspection locality. Request-level matching_status only; notifications have no matching status. Guest no-match has no notification. Operations sees sanitized send outcomes, never code_hash, code, full provider payload, or message body.

---

# 8. Routing / Flow Rules

## Guest inspection
Home → فحص مركبة → Governorate/Region → Results → Provider Card → Guest Name/Phone → Confirm Notify → WhatsApp (wa.me/whatsapp_number) → Provider Phone

No match branch: Governorate/Region → Guest Name/Phone → Confirmation → no_match request; no provider selection or WhatsApp.

## Registered inspection
Home → فحص مركبة → Governorate/Region → Select Saved Vehicle → Results → Suitable Provider → Provider Card → Confirm Notify → WhatsApp (wa.me/whatsapp_number) → Provider Phone

No match branch: selected locality/vehicle + account identity → confirmation → no_match request; no provider selection.

## Guest towing
Home → سطحة → Origin → Destination → Results → Provider Card → Guest Name/Phone → Confirm Notify → WhatsApp (wa.me/whatsapp_number) → Send Location

## Registered towing
Home → سطحة → Origin (prefilled if home_governorate) → Destination → Results → Provider Card → Notify → WhatsApp (wa.me/whatsapp_number) → Send Location

## Provider
Provider Login → Notifications or → Provider Management

## Operations
Operations Login → Dashboard sections → Lists / Providers / Notifications (incl. O-06b) / Vehicles / Audit

## Super Admin
Super Admin Login → Operations Users / KPIs / CSV Export / Contact Phone (S-05)

---

# 9. Performance / Connectivity Rules

- First-content experience designed for 3G.
- Keep initial bundle small.
- Lazy-load map resources.
- Skeletons instead of blocking spinners.
- Do not preload Leaflet before inspection flow.
- Map timeout >5s → text provider list.
- GPS failure never blocks manual selection.
- Push failure never blocks provider notification history.
- WhatsApp API failure does not disable platform; affects OTP delivery only.

---

# 10. Security / Privacy UI Rules

- Password fields use password input semantics.
- OTP never exposed by server to any UI or staff, nor recoverable; only the user's typed input appears in U-03. Hash-only persists; outbound body is transient and excluded from logs/audit.
- **whatsapp_number never displayed to end users — used only for internal wa.me link construction.**
- No API tokens in frontend UI/config.
- Do not expose raw internal IDs.
- Do not persist/display user live GPS as platform history.
- User account deletion is destructive and final.
- After deletion, user-facing personal data anonymized per SRS.

---

# 11. PWA Rules

- Installable to Home Screen.
- No app-store requirement.
- Responsive at ≥320px.
- App shell renders without immediate API response.
- Core UI understandable during slow network.

---

# 12. Forbidden UI / Features

```text
Booking / appointments
Payment / price / checkout
Driver/provider tracking
Ratings / reviews
In-app chat
AI diagnosis
Native mobile app flows
Provider acceptance/rejection of customer requests
Automatic WhatsApp sending to provider
External SMS for notifications
Email notification system
Persistent ops_alerts entity/UI workflow
Dynamic permissions editor
Tow map
Customer notification inbox
```

---

# 13. Implementation Structure for Replit

## UI layers

```text
App Shell
├── Public/User Shell
├── Provider Shell
├── Operations Shell
└── Super Admin Shell
```

## Reusable components

```text
Button / Input / Select / OTPInput / StatusBadge
ProviderCard / ProviderCapabilityList / ProviderCoverageList
MapView / ProviderListFallback
BottomSheet / SideSheet / ConfirmDialog
Toast / Skeleton / EmptyState
DataTable / Pagination / Filters
Timeline / KPI Card / KPI Chart
OtpSendFailureSection  ← O-06b (read-only)
```

## Data adapters

Use typed adapters for:
- users
- vehicles
- providers (يشمل whatsapp_number — **لا يُعرَض في UI — يُستخدَم فقط لبناء wa.me**)
- service_requests (inspection_governorate_id/inspection_region_id + parent matching_status)
- notifications
- provider_push_subscriptions
- otp_verification_challenges (sanitized send_status/delivery_status/send_attempt_count for O-06b; no code/hash/body in adapter)
- provider_coverage
- provider capabilities
- reference lists
- ops_users
- audit_log
- provider_edit_requests
- message_templates
- system_config (contact_phone only; editable in S-05 by Super Admin)

---

# 14. Acceptance Criteria

A Replit implementation is considered UI-complete only when:

1. All public/user/provider/Operations/Super Admin screens exist.
2. All required loading/error/empty/success states exist.
3. RTL correct across all forms, tables, sheets, navigation, dialogs.
4. Mobile works at 320px.
5. Touch targets ≥44×44px.
6. Inspection: mandatory governorate/region, then map results + fallback list for same locality; GPS never replaces selection.
7. Towing: list-only results.
8. Provider cards: Bottom Sheet (mobile), Side Sheet (desktop).
9. Registered user: saved-vehicle flow for inspection.
10. Registered user: home-governorate prefill for towing.
11. Guest identity handled per SRS request flow.
12. `year_category` derived, not manually selected.
13. `pending_verification` not shown to normal users.
14. Provider notifications read-only.
15. Operations: pagination not infinite scroll.
16. Duplicate alert computed and non-blocking.
17. Super Admin: only defined KPI families + CSV export + minimal contact_phone screen (besides defined user management).
18. No forbidden feature visible or reachable.
19. **O-02: حقل «رقم واتساب» موجود وإلزامي في نموذج إنشاء/تعديل المزود.**
20. **O-02: حقول capabilities مخفية عند service_type=towing.**
21. **O-06b: read-only failures after two attempts from persisted outcomes; no code/hash/body/verbal support/recovery or staff resend. api_accepted/pending do not imply failure or delivery.**
22. **wa.me في U-11/U-15/U-16 يستخدم providers.whatsapp_number لا phone.**
23. **location_url** يُعرَض في O-02 فقط كـlink خارجي.
    لا يظهر في أي شاشة مستخدم أو مزود.
24. **U-12 وU-14:** رسالة no_match تتضمن رقم الفريق مقروءاً من `system_config.contact_phone` — لا رقم مُضمَّن في الكود.
25. **U-14:** ترتيب القسم الأول يتبع قاعدة: مقر الانطلاق أولاً ← مقر الوصول ← عشوائي.
26. **Guest inspection no-match:** locality → name/phone → confirmation → no_match request; no provider selection/notification/search expansion; no request on render.
27. **Inspection persistence:** both locality IDs required for inspection, NULL for towing; region validated against governorate; no reverse geocoding or stored GPS.
28. **Towing:** both sections active/open; any notified A → request matched, all B → no_match; multiple notifications reuse one request; no per-notification match status.
29. **U-16:** GPS URL or governorate+region text in towing_location; both branches open WhatsApp for manual Send.
30. **P-03:** per-day work_days is sole schedule authority, including closed-day override; no scalar schedule fields.
31. **U-02/U-03/U-05:** inactive until correct OTP; delete anonymizes name/phone to NULL while keeping non-deleted integrity.
32. **S-05:** contact_phone only, E.164, Super Admin-only frontend/backend; no general settings system.
---

# 15. Source Baseline

## Primary
- SRS Syriacar v1.4.
- DBMS v2.2 (reconciled).
- Approved UI/UX decision set.

## Relevant SRS areas
- §1–§2: scope/platform/roles
- §4: external interfaces (REQ-WAU يستخدم whatsapp_number)
- §5.1–§5.10: all functional requirements
- §6: NFR
- §8: data requirements

---

# 16. Final Instruction to Replit

**Build Syriacar as a production-quality Arabic RTL Mobile-First PWA UI following this specification. Do not reinterpret product scope. Do not add product decisions. Where a visual pattern is specified, implement it consistently. Where the document says a behavior is "not implemented", do not expose it in navigation, cards, buttons, empty states, or settings.**

**The goal is not a generic car-services marketplace UI. The goal is the exact Syriacar MVP: discover a verified provider → notify the selected provider via whatsapp_number → show the provider phone → communication continues outside the platform.**
