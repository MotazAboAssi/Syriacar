# مزودو الاختبار اليدوي — تطوير فقط

## التشغيل

من Shell في **قاعدة تطوير المشروع الحالية**:

```sh
NODE_ENV=development npm run db:seed -- --provider-fixtures --confirm-development
```

هذا امتداد للـCLI الموجود، وليس seed أو startup hook مستقلًا. بلا flags يبقى `npm run db:seed` seed المراجع فقط. لا يمكن دمج أوضاع seed في أمر واحد.

المراجع والمركبات الموجودة تُقرأ فقط. يجب أن توجد مركبة حساب `+963900007701` أو `+963900007702` متوافقة مع هيونداي / كوري / modern / بنزين / car، وحسابها نشط وغير محذوف، ومركبتها غير مرفوضة. إذا كانت البيانات اليدوية غير موجودة، شغّل وضع الحسابات الموجود أولًا:

```sh
NODE_ENV=development npm run db:seed -- --manual-scenarios --confirm-development
```

لا يُصلح seed مركبات أو مراجع معدّلة/غير نشطة تلقائيًا. الأسماء أدناه والـUUIDs ثابتة.

## fixtures والنتائج

كلها `active`، وبساعات **00:00–23:59 يوميًا، بتوقيت Asia/Damascus**، بما فيه الجمعة. هذا ليس 24/7: طبقًا للمنطق الموجود تُغلق بعد **23:59:00 وحتى منتصف الليل**؛ نفّذ الاختبارات خارج تلك الدقيقة. لا تغيير لقاعدة الساعات أو الساعة الفعلية.

| الاسم | هاتف العرض | WhatsApp | الغرض |
|---|---|---|---|
| تجريبي فقط — فحص مناسب على الخريطة | +12025550111 | +12025550121 | مطابق للأبعاد الخمسة للمركبة، دمشق / مدينة دمشق، إحداثيات صحيحة؛ مناسب وعلى الخريطة |
| تجريبي فقط — فحص مناسب في القائمة | +12025550112 | +12025550122 | نفس الأبعاد والمحلية، latitude/longitude كلاهما NULL؛ مناسب وlist-only بلا marker |
| تجريبي فقط — فحص غير متوافق بالوقود | +12025550113 | +12025550123 | نفس الأبعاد الأخرى والمحلية، لكن كهرباء بدل بنزين؛ غير مناسب للمركبة في registered inspection |
| تجريبي فقط — سطحة A على الخريطة | +12025550114 | +12025550124 | تغطي دمشق وريف دمشق، إحداثيات صحيحة |
| تجريبي فقط — سطحة A ثانية | +12025550115 | +12025550125 | تغطي دمشق وريف دمشق، مقرها دوما في ريف دمشق، إحداثيات صحيحة |
| تجريبي فقط — سطحة B تغطي دمشق فقط | +12025550116 | +12025550126 | لا تغطي ريف دمشق، فتكون B لمسار دمشق–ريف دمشق، إحداثيات صحيحة |

الأرقام من نطاق NANP `555-01xx` الوهمي للمثال، وليست بيانات مزودين حقيقيين. **لا تفتح WhatsApp ولا ترسل رسائل لهذه الأرقام.** النظام الحالي يسجل request/notification ويجهّز الرابط فقط؛ لا إرسال من seed أو اختبارات fixtures.

السجل `تجريبي — منشئ مزودي الاختبار المعطّل` في Operations هو metadata إلزامي للحقل `created_by`: `is_active=false`، وليس حساب إدارة قابلًا للاستخدام. كلمات المرور للمنشئ والمزودين عشوائية، Argon2، وتُرمى بعد hashing؛ لا بيانات دخول لها ولا dashboard جديد.

## خطوات الاستطلاع

كلمة مرور الحسابات التجريبية الموجودة: `TEST_ONLY_Syriacar_2026!`

1. **فحص مناسب وخريطة/list-only:** استخدم حساب `+963900007702`، ومركبته هيونداي 2018 (pending_verification)، `/inspection`، اختر **دمشق / مدينة دمشق**. المناسبان هما مزودا الفحص الأول والثاني. الأول marker؛ الثاني قائمة فقط. إذا فشلت الخريطة يطبّق fallback الموجود وتظهر النتائج في القائمة، دون تغيير المطابقة. إشعار أي من المناسبين ⇒ `matched` وnotification. يمكن استخدام حساب `+963900007701` فقط إن كانت المركبة المختارة ما زالت تطابق الأبعاد المذكورة؛ تغيّرت بيانات مركبته الأصلية أثناء اختبار القبول ولم نُعد ضبطها.
2. **الفحص غير المتوافق:** الحساب نفسه والمحلية نفسها. المزود الكهربائي غير مناسب؛ لا يمكن إشعاره كـSection A. عدم التوافق بسبب fuel فقط، لا الإحداثيات أو قاعدة جديدة.
3. **no_match محفوظ:** حساب `+963900007704`، هيونداي 1990 / classic / ديزل / truck / verified، والمحلية نفسها. لا مزود مناسب من هذه fixtures؛ تأكيد عدم وجود مطابق ⇒ `no_match` بلا notification.
4. **سطحة A/B:** حساب `+963900007705`، `/towing`. الانطلاق **دمشق** يأتي من home governorate؛ اختر الوصول **ريف دمشق**. يظهر مزودان A، وثالث B. الطلب مرتبط بالمستخدم ولا يحتاج مركبة.
5. **طلب واحد وإشعارات متعددة:** في المسار نفسه، أشعِر B أولًا ⇒ request واحد، notification واحد، `no_match`. من **نفس شاشة النتائج/نفس الطلب** أشعِر A الأول ⇒ request نفسه، notification ثانٍ، `matched`. أشعِر A الثاني، ثم B مجددًا ⇒ parent نفسه وأربعة notifications، والحالة تبقى `matched`. بدء تدفق جديد/إعادة تحميل الشاشة ليس continuation مضمونًا؛ لا تستخدمه لاختبار parent واحد.
6. **B-only:** حساب السطحة نفسه، مسار **دمشق → حلب**. مزودو السطحة الثلاثة جميعهم B، وإشعار أي منهم ⇒ `no_match`. لا مزود fixture يغطي حلب.
7. **Guest inspection:** `/inspection/guest`، **دمشق / مدينة دمشق**، اسم وهمي ورقم مثال مثل `+12025550199`. لا اختيار مركبة: المنطق الموجود يعتمد على المحلية/التوفر، لذلك يظهر المزودون الثلاثة، بما فيهم الكهربائي، ويستطيع الضيف إشعاره ⇒ `matched`. **لا تنقل عدم توافق مركبة registered إلى Guest.**
8. **Guest towing:** `/towing/guest`، اسم وهمي ورقم مثال `+12025550198`، والمسار نفسه. استخدم التتابع B → A → A الثاني → B في نفس التدفق؛ request guest واحد وأربعة notifications، `no_match` ثم `matched` بلا downgrade. دمشق → حلب هو B-only أيضًا.

الأعداد A=2/B=1 والفحص المناسب=2 تصف **هذه fixtures**. قد تظهر مزودات تطوير أخرى إن أضافها صاحب المشروع لاحقًا؛ لا يحذفها seed ولا يغيّرها. رقم فريق الدعم الموجود في system_config لا يُعدّل؛ لا تراسله أثناء اختبار no_match.

## إعادة التشغيل والإزالة الآمنة

- التنفيذ كله داخل transaction مع advisory lock؛ فشل متأخر في رقم/ID أو coverage يزيل **إضافات تلك المحاولة فقط**.
- لا upsert/update/delete في seed. التشغيل مرتين لا يكرّر providers/coverage/capabilities/creator أو يعيد hashing/timestamps للسجلات الموجودة.
- يحافظ على graph المزود الموجود كاملةً، بما فيها تعديل status/coordinates/coverage/capabilities أو حذف child row يدويًا؛ لا backfill. لذلك re-run ليس reset لتعديلات المستكشف.
- اختلاف الاسم/رقم الهاتف/WhatsApp/service_type/created_by أو تصادم ID مع سجل غير معروف يوقف العملية بدل إعادة إسناد أو تعديل السجل.

**الأمر التالي يحذف مزودي fixtures الستة وcoverage/capabilities التابعة لهم فقط**، ولا حسابات المستخدمين أو المركبات أو المراجع أو أي provider آخر. لا تشغّله إلا إذا أردت إزالة بيانات الاختبار:

```sh
NODE_ENV=development npm run db:seed -- --remove-provider-fixtures --confirm-development
```

الإزالة transactional وidempotent، وتتحقق من هوية كل مزود قبل الحذف. **ترفض العملية كاملةً** إن كان لأي fixture إشعار/طلب مرتبط عبر notifications، أو edit request، أو push subscription. لا تُحذف history لتجاوز هذا المنع. يبقى منشئ Operations المعطّل عمدًا لحماية أي history أخرى مرتبطة به.

إن لم توجد تلك الروابط، يمكن إزالة fixtures ثم تشغيل seed لإرجاع حالتها الأولية دون لمس الحسابات والمركبات. إذا وُجد history، احتفظ بالfixtures؛ لا تستخدم TRUNCATE أو حذف notifications/service_requests. seed ليس وسيلة لإعادة ضبط حسابات البشر أو بياناتهم.

## حماية الإنتاج والتحقق

- `NODE_ENV=production` أو وضع NODE_ENV مجهول أو غياب opt-in ⇒ رفض.
- runtime النشر `REPLIT_DEPLOYMENT` ⇒ رفض حتى مع NODE_ENV=development.
- target fingerprint المثبّت لقاعدة التطوير الحالية ⇒ أي قاعدة مختلفة مرفوضة قبل الاتصال.
- لا تشغيل في build/start/publish، ولا OTP/Whapi أو push sends أو provider dashboard أو تغييرات في business rules/schema/migration.
- **لا تختَر نسخ بيانات التطوير إلى Production عند النشر**؛ ذلك قد ينسخ fixtures خارج CLI. حارس seed لا يمنع النقل اليدوي للبيانات.

الاختبارات الجديدة: `tests/provider-fixtures.test.mjs`. تعمل في schema مؤقت مع rollback وتختبر fixtures مع منطق الخدمات الأصلي؛ لا تضيف طلبات اختبار إلى الجداول الحقيقية.

فحص المتصفح اليدوي بعد seeding، مع Next APIs الحقيقية، والسماح بـlogin فقط ومنع إنشاء طلبات/إشعارات:

```sh
node --conditions=react-server tests/manual-provider-fixtures-browser.mjs
```

## نتائج التسليم

| الفحص | النتيجة |
|---|---|
| `npm test` | 155/155، بلا skipped؛ منها 22 اختبارًا جديدًا لـProvider Fixtures |
| `npm run test:browser` | 52/52، بلا skipped، باستخدام Chromium الحقيقي |
| فحص fixtures عبر المتصفح وNext APIs الحقيقية | 6/6 حالات، منها map/list-only وGuest وA/B وB-only |
| `npm run typecheck` | ناجح |
| `npm run build` | ناجح |
| `npm run db:verify-isolated` | ناجح؛ 243 behavioral assertions وكل الكتابات المعزولة rolled back |
| `db:verify` و`db:verify-seed` المباشران | رفض آمن متوقع: يشترطان قاعدة أولية بلا non-reference data. لم تُحذف البيانات لتجاوز الحارس؛ المعادل المعزول أعلاه نفّذ الفحصين الأصليين |

catalog الحقيقي بعد الإنشاء: **24 tables، 165 columns، 11 enums، 24 primary keys، 40 foreign keys، 9 unique constraints، 7 checks، 73 indexes**؛ دون تغيير. المراجع الـ**158** (14 محافظات، 76 مناطق، 9 مجموعات، 49 ماركات، 5 وقود، 5 أنواع سطحات) وقيمها وترتيبها وعلاقاتها بقيت كما هي.

تشغيل CLI الفعلي في التطوير مرتين: الأولى أضافت 6 providers، و8 coverage، و15 capability junction rows، ومنشئًا معطلًا واحدًا. الثانية أضافت صفرًا، وحافظت على نفس جميع السجلات/الـIDs/password hashes/timestamps. مقارنة كل السجلات السابقة في الجداول الـ24 أثبتت أن seed لم يغيّر أيًا منها ولم يضف users/vehicles/OTP/requests/notifications. فحص login في المتصفح جدّد نشاط **الحسابات التجريبية فقط** بمنطق الجلسات العادي.

استلزم توافق regression عزل fixture السطحة القديمة داخل schema مؤقت: Section B يشمل كل مزود مفتوح حتى خارج مسار الاختبار، لذا لا يمكن افتراض قاعدة تطوير بلا مزودين بعد إضافة fixtures. لم تُخفّف assertions أو تُفلتر قواعد Production؛ وحدها بنية الاختبار صارت مستقلة عن بيانات التطوير. كما ثُبّت انتظار اكتمال auth/hydration في browser harness قبل تحريك ساعة الاختبار.

### ملفات المشروع المضافة/المعدلة (12)

- `src/server/db/seed/seed-cli.ts` — إضافة الأوضاع إلى CLI الموجود.
- `src/server/db/seed/provider-fixture-data.ts` — البيانات والـIDs الثابتة.
- `src/server/db/seed/provider-fixture-ownership.ts` — قفل المعاملة وفحص الهوية.
- `src/server/db/seed/provider-fixtures.ts` — seed insert-only.
- `src/server/db/seed/provider-fixture-reset.ts` — الإزالة الاختيارية المحمية.
- `tests/provider-fixtures.test.mjs` — 22 اختبارًا جديدًا.
- `tests/manual-provider-fixtures-browser.mjs` — 6 حالات live UI/API.
- `tests/fixtures/manual-seed-isolation.mjs` — helper العزل والـsnapshots.
- `tests/fixtures/guest-inspection.mjs` — قبول connection خاصة بالاختبار.
- `tests/fixtures/guest-towing.mjs` — عزل بيانات اختبارات السطحة.
- `tests/browser/account-harness.mjs` — انتظار readiness وحماية selector أثناء hydration.
- `docs/manual-provider-test-fixtures.md` — هذه الوثيقة.

لا تغييرات في business modules أو app routes/UI أو schema أو migration أو `seed.ts`/`reference-data.ts` أو packages. **لم يتم commit أو push إلى GitHub.** لم تُشغّل إزالة fixtures في قاعدة التطبيق؛ اختُبرت فقط داخل rollback.