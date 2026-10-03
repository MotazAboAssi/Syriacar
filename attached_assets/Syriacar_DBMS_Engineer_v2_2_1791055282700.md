# Syriacar — DBMS Engineer / ERD Design Notes v2.2

**Date:** 2026-10-03
**Source of requirements:** `SRS_Syriacar_v1.4.md`
**Gap resolution source:** Cross-document Compliance Review v2.2 — 2026-10-03
**Scope:** Conceptual + Logical schema and ERD. DBMS: PostgreSQL 15+ (Replit Neon).

---

## 1. Executive summary of changes from v2.1

| # | التغيير | السبب |
|---|---|---|
| 1 | تحديث `Source of requirements` من `v1.2` إلى `v1.4` | مزامنة مع الإصدار الفعلي الحالي للـSRS |
| 2 | إضافة schema كاملة لجدول **`system_config`** (كيان جديد #24) | FR-INS-015 + FR-TOW-006: رقم الفريق يُقرأ من DB لا hardcode |
| 3 | إضافة حقلَي **`handled_at`** و**`handled_by`** إلى `otp_verification_challenges` | FR-OPS-013b + UIUX O-06b: زر «تم الاتصال» يكتب إليهما |
| 4 | توثيق schema **`message_templates`** كاملةً (بدلاً من «Unchanged from v2.0») | إزالة الإحالة لنسخة غير مرفقة |
| 5 | تحديث Entity inventory من 23 إلى **24 كياناً** | إضافة `system_config` |
| 6 | إضافة `system_config` إلى §4 Relationships + §6 Constraints + §12 Bootstrap | اتساق داخلي |
| 7 | إضافة فهرس `otp_verification_challenges(handled_at)` إلى §8 | دعم استعلام O-06b |

---

## 2. Entity inventory (24 entities)

1. users
2. otp_verification_challenges ← **تحديث: إضافة handled_at + handled_by**
3. vehicles
4. providers
5. provider_coverage
6. provider_brands
7. provider_brand_groups
8. provider_year_categories
9. provider_fuel_types
10. provider_vehicle_categories
11. provider_push_subscriptions
12. service_requests
13. notifications
14. fuel_types
15. tow_types
16. brand_groups
17. brands
18. governorates
19. regions
20. ops_users
21. audit_log
22. provider_edit_requests
23. message_templates ← **تحديث: schema كاملة موثَّقة**
24. **system_config** ← **جديد**

---

## 3. Logical schema

### users
| Field | Type | Required | Key / Constraint |
|---|---|---|---|
| id | UUID | Yes | PK |
| name | VARCHAR | Yes | → NULL on delete |
| phone | VARCHAR | Yes | UNIQUE; E.164 (+963…); → NULL on delete |
| password_hash | VARCHAR | Yes | |
| home_governorate_id | UUID | No | FK → governorates |
| is_active | BOOLEAN | Yes | DEFAULT true |
| is_deleted | BOOLEAN | Yes | DEFAULT false |
| created_at | TIMESTAMP | Yes | UTC |
| last_active_at | TIMESTAMP | Yes | UTC |

---

### otp_verification_challenges
| Field | Type | Required | Key / Constraint |
|---|---|---|---|
| id | UUID | Yes | PK |
| phone | VARCHAR | Yes | E.164 |
| purpose | VARCHAR | Yes | 'registration'; extensible |
| code_hash | VARCHAR | Yes | hash only — no plaintext |
| expires_at | TIMESTAMP | Yes | UTC |
| consumed_at | TIMESTAMP | No | NULL = not yet consumed |
| attempt_count | SMALLINT | Yes | DEFAULT 0 |
| max_attempts | SMALLINT | Yes | DEFAULT 5 |
| created_at | TIMESTAMP | Yes | UTC |
| last_sent_at | TIMESTAMP | Yes | UTC |
| **handled_at** | **TIMESTAMP** | **No** | **UTC — يُملأ عند ضغط «تم الاتصال» في O-06b** |
| **handled_by** | **UUID** | **No** | **FK → ops_users — من نفّذ الاتصال** |

Logical uniqueness rule: at most one active (consumed_at IS NULL AND expires_at > NOW) per (phone, purpose).

O-06b display filter:
```sql
consumed_at IS NULL
AND expires_at > NOW()
AND last_sent_at < NOW() - INTERVAL '5 seconds'
AND handled_at IS NULL
```
زر «تم الاتصال» يُنفِّذ: `UPDATE SET handled_at = NOW(), handled_by = :ops_user_id`. لا يُغيِّر code_hash. السجل يختفي من القائمة بعد التحديث.

---

### vehicles
| Field | Type | Required | Key / Constraint |
|---|---|---|---|
| id | UUID | Yes | PK |
| user_id | UUID | Yes | FK → users |
| brand_group_id | UUID | Yes | FK → brand_groups |
| brand_id | UUID | Yes | FK → brands; must belong to brand_group_id (app-enforced) |
| year | SMALLINT | Yes | 1970–current year |
| year_category | ENUM('classic','mid','modern') | Yes | derived from year; computed at input |
| fuel_type_id | UUID | Yes | FK → fuel_types |
| vehicle_category | ENUM('car','truck') | Yes | |
| plate_number | VARCHAR | No | → NULL on user delete |
| color | VARCHAR | No | → NULL on user delete |
| notes | TEXT | No | → NULL on user delete |
| verification_status | ENUM('pending_verification','verified','rejected') | Yes | DEFAULT pending_verification |
| created_at | TIMESTAMP | Yes | UTC |

---

### providers
| Field | Type | Required | Key / Constraint |
|---|---|---|---|
| id | UUID | Yes | PK |
| business_name | VARCHAR | Yes | |
| phone | VARCHAR | Yes | UNIQUE; E.164 |
| whatsapp_number | VARCHAR(20) | Yes | UNIQUE; E.164; NOT NULL — لرابط wa.me |
| password_hash | VARCHAR | Yes | |
| service_type | ENUM('inspection','towing') | Yes | |
| status | ENUM('pending','active','disabled') | Yes | DEFAULT pending |
| governorate_id | UUID | Yes | FK → governorates |
| region_id | UUID | Yes | FK → regions |
| location_lat | DECIMAL | No | structured canonical coordinates |
| location_lng | DECIMAL | No | |
| location_url | VARCHAR | No | optional display/deep-link — internal use only (O-02) |
| work_days | JSON | Yes | schema defined in §5 |
| work_start | TIME | Yes | daily default start |
| work_end | TIME | Yes | daily default end |
| today_closed | BOOLEAN | Yes | DEFAULT false |
| today_closed_date | DATE | No | NULL unless «لا أعمل اليوم» pressed |
| specializations | JSON | No | free-form MVP |
| tow_type_id | UUID | No | FK → tow_types; towing only |
| created_at | TIMESTAMP | Yes | UTC |
| created_by | UUID | Yes | FK → ops_users |

Constraints:
- `today_closed=true` ↔ `today_closed_date IS NOT NULL` (app-level + CHECK where supported)
- `whatsapp_number` format: E.164 (+963…); validated at app level; never displayed to end users
- `service_type='towing'` → capability junctions left empty; enforced at UIUX level (O-02 hides those fields)
- `today_closed` reset: scheduled job daily at 00:00 Asia/Damascus (app-level, node-cron or equivalent)

---

### provider_coverage
| Field | Type | Required |
|---|---|---|
| id | UUID | Yes — PK |
| provider_id | UUID | Yes — FK → providers |
| governorate_id | UUID | Yes — FK → governorates |

UNIQUE(provider_id, governorate_id). Authoritative current state; pending changes stored in provider_edit_requests.requested_value.

---

### provider_push_subscriptions
| Field | Type | Required | Key / Constraint |
|---|---|---|---|
| id | UUID | Yes | PK |
| provider_id | UUID | Yes | FK → providers |
| endpoint | VARCHAR | Yes | UNIQUE |
| p256dh | VARCHAR | Yes | |
| auth | VARCHAR | Yes | |
| created_at | TIMESTAMP | Yes | UTC |
| last_seen_at | TIMESTAMP | Yes | UTC |
| expires_at | TIMESTAMP | No | |
| is_active | BOOLEAN | Yes | DEFAULT true |

VAPID keys stored as environment variables (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY) — not in DB.

---

### Provider capability junctions
All use composite PK:
- `provider_brands(provider_id, brand_id)`
- `provider_brand_groups(provider_id, brand_group_id)`
- `provider_year_categories(provider_id, year_category ENUM('classic','mid','modern'))`
- `provider_fuel_types(provider_id, fuel_type_id FK→fuel_types)`
- `provider_vehicle_categories(provider_id, vehicle_category ENUM('car','truck'))`

**Note:** For `service_type='towing'` providers, these junctions are left empty. UIUX hides capability input fields in O-02 when service_type=towing. No DB constraint enforced in MVP; app-level only.

---

### service_requests
| Field | Type | Required | Key / Constraint |
|---|---|---|---|
| id | UUID | Yes | PK |
| service_type | ENUM('inspection','towing') | Yes | |
| user_type | ENUM('registered','guest') | Yes | |
| user_id | UUID | No | FK → users; NOT NULL if registered |
| guest_name | VARCHAR | No | NOT NULL if guest |
| guest_phone | VARCHAR | No | NOT NULL if guest; E.164 |
| vehicle_id | UUID | No | FK → vehicles |
| origin_governorate_id | UUID | No | FK → governorates; towing |
| dest_governorate_id | UUID | No | FK → governorates; towing |
| matching_status | ENUM('matched','no_match') | Yes | DEFAULT matched |
| created_at | TIMESTAMP | Yes | UTC |

Conditional integrity (app-level):
- registered → user_id NN, guest fields NULL
- guest → user_id NULL, guest fields NN
- inspection + registered → vehicle_id NN, origin/dest NULL
- towing → origin NN, dest NN

---

### notifications
| Field | Type | Required | Key / Constraint |
|---|---|---|---|
| id | UUID | Yes | PK |
| service_request_id | UUID | Yes | FK → service_requests |
| provider_id | UUID | Yes | FK → providers |
| service_type | ENUM('inspection','towing') | Yes | mirrors service_request |
| user_type | ENUM('registered','guest') | Yes | |
| user_id | UUID | No | FK → users |
| guest_name | VARCHAR | No | |
| guest_phone | VARCHAR | No | |
| vehicle_id | UUID | No | FK → vehicles |
| origin_governorate_id | UUID | No | FK → governorates |
| dest_governorate_id | UUID | No | FK → governorates |
| followup_status | ENUM('pending','service_completed','provider_no_response','issue') | Yes | DEFAULT 'pending' |
| followup_notes | TEXT | No | |
| followup_by | UUID | No | FK → ops_users |
| followup_at | TIMESTAMP | No | UTC |
| created_at | TIMESTAMP | Yes | UTC |

---

### fuel_types
| Field | Type | Required |
|---|---|---|
| id | UUID | Yes — PK |
| code | VARCHAR | Yes — UNIQUE |
| name_ar | VARCHAR | Yes |
| display_order | SMALLINT | Yes |
| is_active | BOOLEAN | Yes — DEFAULT true |

---

### tow_types
| Field | Type | Required |
|---|---|---|
| id | UUID | Yes — PK |
| code | VARCHAR | Yes — UNIQUE |
| name_ar | VARCHAR | Yes |
| display_order | SMALLINT | Yes |
| is_active | BOOLEAN | Yes — DEFAULT true |

---

### brand_groups
| Field | Type | Required |
|---|---|---|
| id | UUID | Yes — PK |
| name_ar | VARCHAR | Yes |
| display_order | SMALLINT | Yes |
| is_active | BOOLEAN | Yes |

---

### brands
| Field | Type | Required |
|---|---|---|
| id | UUID | Yes — PK |
| brand_group_id | UUID | Yes — FK → brand_groups |
| name_ar | VARCHAR | Yes |
| display_order | SMALLINT | Yes |
| is_active | BOOLEAN | Yes |

---

### governorates
| Field | Type | Required |
|---|---|---|
| id | UUID | Yes — PK |
| name_ar | VARCHAR | Yes |
| is_active | BOOLEAN | Yes |

---

### regions
| Field | Type | Required |
|---|---|---|
| id | UUID | Yes — PK |
| governorate_id | UUID | Yes — FK → governorates |
| name_ar | VARCHAR | Yes |
| is_active | BOOLEAN | Yes |

---

### ops_users
| Field | Type | Required | Note |
|---|---|---|---|
| id | UUID | Yes | PK |
| name | VARCHAR | Yes | |
| username | VARCHAR | Yes | UNIQUE |
| password_hash | VARCHAR | Yes | |
| role | ENUM('operations','super_admin') | Yes | |
| is_active | BOOLEAN | Yes | DEFAULT true |
| created_at | TIMESTAMP | Yes | UTC |

---

### audit_log
| Field | Type | Required |
|---|---|---|
| id | UUID | Yes — PK |
| ops_user_id | UUID | Yes — FK → ops_users |
| action | VARCHAR | Yes |
| entity_type | VARCHAR | Yes |
| entity_id | UUID | Yes |
| old_value | JSON | No |
| new_value | JSON | No |
| created_at | TIMESTAMP | Yes — UTC |

**Retention policy: 12 months** — ⚠️ قرار مؤقت؛ مراجعة مطلوبة قبل الإطلاق في الإنتاج أو بعد 6 أشهر تشغيل.

---

### provider_edit_requests
| Field | Type | Required | Note |
|---|---|---|---|
| id | UUID | Yes | PK |
| provider_id | UUID | Yes | FK → providers |
| field_name | VARCHAR | Yes | allowlist: business_name, phone, coverage |
| requested_value | JSON | Yes | |
| status | ENUM('pending','approved','rejected') | Yes | DEFAULT pending |
| reviewed_by | UUID | No | FK → ops_users |
| reviewed_at | TIMESTAMP | No | UTC |
| created_at | TIMESTAMP | Yes | UTC |

Coverage edit format: `{"governorate_ids": ["uuid1","uuid2"]}`.
Approval is transactional: validate → apply to provider_coverage → mark approved → record reviewer.

---

### message_templates
| Field | Type | Required | Note |
|---|---|---|---|
| id | UUID | Yes | PK |
| key | VARCHAR | Yes | UNIQUE — مفتاح القالب |
| template_ar | TEXT | Yes | نص القالب بالعربية |
| updated_by | UUID | Yes | FK → ops_users |
| updated_at | TIMESTAMP | Yes | UTC |

Required bootstrap keys: `inspection_registered`, `inspection_guest`, `towing_registered`, `towing_guest`, `towing_location`.
Initial `updated_by` = Super Admin id (inserted in bootstrap step 2).

---

### system_config ← **جديد**
| Field | Type | Required | Note |
|---|---|---|---|
| key | VARCHAR | Yes | PK — مفتاح الإعداد |
| value | VARCHAR | Yes | القيمة — مثال: `+963998548589` |
| updated_by | UUID | Yes | FK → ops_users |
| updated_at | TIMESTAMP | Yes | UTC |

Bootstrap row: `key = 'contact_phone'`, value = رقم الفريق (E.164).
Purpose: رقم الفريق المُعرَّض في رسائل no_match (FR-INS-015, FR-TOW-006). يُقرأ بالمفتاح `contact_phone` — لا hardcode في الكود.
Managed by: Super Admin (يملك صلاحية تعديل هذا الجدول).

---

## 4. Relationships (complete)

```
users (1) ──── (0..N) vehicles
users (1) ──── (0..N) service_requests
users (1) ──── (0..N) otp_verification_challenges [by phone, not user_id]

service_requests (1) ──── (0..N) notifications

providers (1) ──── (0..N) notifications
providers (1) ──── (0..N) provider_coverage
providers (1) ──── (0..N) provider_brands
providers (1) ──── (0..N) provider_brand_groups
providers (1) ──── (0..N) provider_year_categories
providers (1) ──── (0..N) provider_fuel_types
providers (1) ──── (0..N) provider_vehicle_categories
providers (1) ──── (0..N) provider_push_subscriptions
providers (1) ──── (0..N) provider_edit_requests

brand_groups (1) ──── (1..N) brands
governorates (1) ──── (0..N) regions
ops_users (1) ──── (0..N) audit_log
ops_users (1) ──── (0..N) providers [created_by]
ops_users (1) ──── (0..N) system_config [updated_by]
ops_users (1) ──── (0..N) message_templates [updated_by]
ops_users (1) ──── (0..N) otp_verification_challenges [handled_by]

fuel_types (1) ──── (0..N) vehicles [fuel_type_id]
fuel_types (1) ──── (0..N) provider_fuel_types
tow_types (1) ──── (0..N) providers [tow_type_id]
```

Explicit FK list (all in ERD):
- users.home_governorate_id → governorates.id
- vehicles.user_id → users.id
- vehicles.brand_group_id → brand_groups.id
- vehicles.brand_id → brands.id
- vehicles.fuel_type_id → fuel_types.id
- providers.governorate_id → governorates.id
- providers.region_id → regions.id
- providers.created_by → ops_users.id
- providers.tow_type_id → tow_types.id
- provider_fuel_types.fuel_type_id → fuel_types.id
- provider_coverage.provider_id → providers.id
- provider_coverage.governorate_id → governorates.id
- provider_push_subscriptions.provider_id → providers.id
- service_requests.user_id → users.id
- service_requests.vehicle_id → vehicles.id
- service_requests.origin_governorate_id → governorates.id
- service_requests.dest_governorate_id → governorates.id
- notifications.service_request_id → service_requests.id
- notifications.provider_id → providers.id
- notifications.user_id → users.id
- notifications.vehicle_id → vehicles.id
- notifications.origin_governorate_id → governorates.id
- notifications.dest_governorate_id → governorates.id
- notifications.followup_by → ops_users.id
- brands.brand_group_id → brand_groups.id
- regions.governorate_id → governorates.id
- provider_edit_requests.provider_id → providers.id
- provider_edit_requests.reviewed_by → ops_users.id
- message_templates.updated_by → ops_users.id
- audit_log.ops_user_id → ops_users.id
- system_config.updated_by → ops_users.id
- otp_verification_challenges.handled_by → ops_users.id
- otp_verification_challenges: no FK to users (phone-based, user may not exist yet)

---

## 5. work_days JSON schema

```json
{
  "sat": {"enabled": true,  "start": "08:00", "end": "20:00"},
  "sun": {"enabled": true,  "start": "08:00", "end": "20:00"},
  "mon": {"enabled": true,  "start": "08:00", "end": "20:00"},
  "tue": {"enabled": true,  "start": "08:00", "end": "20:00"},
  "wed": {"enabled": true,  "start": "08:00", "end": "20:00"},
  "thu": {"enabled": true,  "start": "08:00", "end": "20:00"},
  "fri": {"enabled": false, "start": null,    "end": null}
}
```

Keys: sat sun mon tue wed thu fri. Values: enabled BOOLEAN, start/end HH:MM or null.

---

## 6. Constraints and UNIQUE

| Table | Constraint |
|---|---|
| users | UNIQUE(phone) |
| providers | UNIQUE(phone) |
| providers | UNIQUE(whatsapp_number) |
| ops_users | UNIQUE(username) |
| message_templates | UNIQUE(key) |
| **system_config** | **PK(key) — مفتاح أساسي نصي** |
| fuel_types | UNIQUE(code) |
| tow_types | UNIQUE(code) |
| provider_push_subscriptions | UNIQUE(endpoint) |
| provider_coverage | UNIQUE(provider_id, governorate_id) |
| provider_brands | PK(provider_id, brand_id) |
| provider_brand_groups | PK(provider_id, brand_group_id) |
| provider_year_categories | PK(provider_id, year_category) |
| provider_fuel_types | PK(provider_id, fuel_type_id) |
| provider_vehicle_categories | PK(provider_id, vehicle_category) |

---

## 7. Enum catalog

| Field | Values |
|---|---|
| vehicles.year_category | classic, mid, modern |
| vehicles.vehicle_category | car, truck |
| vehicles.verification_status | pending_verification, verified, rejected |
| providers.service_type | inspection, towing |
| providers.status | pending, active, disabled |
| service_requests.service_type | inspection, towing |
| service_requests.user_type | registered, guest |
| service_requests.matching_status | matched, no_match |
| notifications.service_type | inspection, towing |
| notifications.user_type | registered, guest |
| notifications.followup_status | pending, service_completed, provider_no_response, issue |
| ops_users.role | operations, super_admin |
| provider_edit_requests.status | pending, approved, rejected |
| provider_year_categories.year_category | classic, mid, modern |
| provider_vehicle_categories.vehicle_category | car, truck |
| fuel_types: values managed by Operations (bootstrap: petrol, diesel, hybrid, electric) |
| tow_types: values managed by Operations (bootstrap: ordinary, hydraulic, closed) |

---

## 8. Recommended index targets (logical)

- All FK columns
- users(phone), providers(phone), providers(whatsapp_number)
- providers(status, service_type, governorate_id, region_id)
- vehicles(user_id, fuel_type_id, year_category, vehicle_category, verification_status)
- service_requests(user_id, service_type, created_at)
- service_requests(user_type, matching_status, created_at) — KPI queries
- notifications(provider_id, created_at)
- notifications(service_request_id)
- notifications(followup_status, created_at)
- provider_coverage(governorate_id, provider_id)
- provider_edit_requests(provider_id, status, created_at)
- audit_log(ops_user_id, created_at)
- otp_verification_challenges(phone, purpose, expires_at)
- **otp_verification_challenges(handled_at)** ← جديد — دعم استعلام O-06b
- provider_push_subscriptions(provider_id, is_active)

---

## 9. Retention policy

| Entity | Policy |
|---|---|
| service_requests | 1 year → delete or aggregate |
| notifications | 1 year → delete or aggregate |
| audit_log | **12 months** ← قرار مؤقت — مراجعة قبل الإنتاج |
| otp_verification_challenges | delete after consumed or expired (short-term) |
| provider_push_subscriptions | delete/revoke when is_active=false or expires_at passed |
| system_config | لا حذف — جدول إعدادات دائم |
| message_templates | لا حذف — جدول قوالب دائم |

---

ملاحظة تنفيذ: cleanup لـservice_requests / notifications / audit_log يُؤجَّل لما قبل الشهر الثاني عشر.
الآلية المُرشَّحة: GitHub Actions cron job شهري يستدعي protected internal endpoint.
لا جداول أو entities إضافية في MVP.

---

## 10. CSV Export contract (FR-SAD-004)

جدول المصدر: `service_requests`

| العمود المُصدَّر | الحقل |
|---|---|
| المعرّف | id |
| نوع الخدمة | service_type |
| الحالة | matching_status |
| تاريخ الإنشاء | created_at |
| المحافظة | للفحص: JOIN عبر `notifications.provider_id → providers.governorate_id → governorates.name_ar`؛ للسطحة: `service_requests.origin_governorate_id → governorates.name_ar` |
| رقم هاتف المستخدم/الضيف | user_id → users.phone OR guest_phone |
| اسم المزود المُبلَّغ | provider_id → providers.business_name (من أول notification مرتبط) |

ملاحظة: الربط بـnotifications للحصول على provider_name يتم عبر JOIN على service_request_id. Backend يحدد تفاصيل JOIN عند التنفيذ.

---

## 11. What the ERD deliberately does NOT contain

- No payments, booking, appointment, AI diagnosis, reviews, ratings, chat, GPS tracking-history.
- No ops_alerts in MVP (computed from service_requests).
- No separate specialization master table in MVP.
- No role/permission tables (fixed RBAC matrix in code).
- No extra business entities invented from market research.
- No DB CHECK constraint on capability junctions for towing providers in MVP (app-level only).
- Sessions table: JWT stateless — لا sessions table في MVP. الجلسات تُدار في HttpOnly Secure cookie على مستوى التطبيق. لا invalidation فوري مطلوب في MVP.
- Token blacklist: غير مطلوب في MVP.
- Data cleanup jobs: مؤجَّلة لما قبل الشهر الثاني عشر من الإنتاج — لا implementation في MVP.

---

## 12. Recommended implementation sequence

1. Bootstrap: governorates → regions → brand_groups → brands → fuel_types → tow_types.
2. Create Super Admin ops_users row (via migration/seed script — no registration screen).
3. Insert message_templates (5 keys) with updated_by = Super Admin id.
4. **Insert system_config row: `key='contact_phone'`, value = رقم الفريق (E.164).**
5. Implement: users, otp_verification_challenges (including handled_at, handled_by).
6. Implement: providers (including whatsapp_number), provider_push_subscriptions, capability junctions, provider_coverage.
7. Implement: vehicles.
8. Implement: service_requests, notifications.
9. Implement: provider_edit_requests, audit_log.
10. Apply UNIQUE constraints and recommended indexes.
11. Validate sample Syrian workflows against ERD before DDL generation.

---

## 13. Logical integrity rules summary

| القاعدة | المستوى |
|---|---|
| `user_type='registered'` ↔ `user_id NOT NULL`, guest fields NULL | App |
| `user_type='guest'` ↔ `user_id NULL`, guest fields NOT NULL | App |
| `service_type='inspection'` ↔ `vehicle_id NOT NULL` (للمسجَّل); origin/dest NULL | App |
| `service_type='towing'` ↔ `origin_governorate_id NOT NULL`, `dest_governorate_id NOT NULL` | App |
| `providers.service_type='towing'` ↔ capability junctions لا تُملأ | App + UIUX |
| `today_closed=true` ↔ `today_closed_date IS NOT NULL` | App + CHECK (where supported) |
| `today_closed=false` ↔ `today_closed_date IS NULL` | App |
| `providers.whatsapp_number` ↔ E.164; UNIQUE; NOT NULL | App + DB |
| `otp.handled_at IS NOT NULL` → سجل معالج، لا يظهر في O-06b | App |
| `system_config.key='contact_phone'` → قيمة إلزامية في bootstrap | Bootstrap |
| RBAC: deny-by-default — مُطبَّق في الكود لا في جداول permissions | Code |

---

*ERD v2.2 — Syriacar — مُحدَّث من Cross-document Compliance Review — جاهز للـDDL + Replit*
