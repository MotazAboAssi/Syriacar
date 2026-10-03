import { createHash } from "node:crypto";

// Initial seed input only. Application features must read the managed DB rows.
// Freeze these keys/positions once applied; Operations edits the database, not this file.
const namespace = Buffer.from("ac0c6f6b210b51fea9ed9de580552737", "hex");

/** RFC 9562 UUIDv5; identity does not depend on a mutable display name. */
export function referenceId(key: string) {
  const bytes = createHash("sha1").update(namespace).update(key, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const geography = [
  {
    key: "damascus", name: "دمشق",
    regions: ["مدينة دمشق", "المزة", "كفرسوسة", "الشعلان", "الميدان", "الصالحية", "دمر", "دمر البلد", "قدسيا", "القابون", "برزة"],
  },
  {
    key: "rural-damascus", name: "ريف دمشق",
    regions: ["دوما", "التل", "قدسيا", "الزبداني", "يبرود", "النبك", "قطنا", "داريا", "مركز ريف دمشق", "الشاغور/السيدة زينب"],
  },
  {
    key: "aleppo", name: "حلب",
    regions: ["مركز حلب", "جبل سمعان", "أعزاز", "الباب", "عفرين", "عين العرب (كوباني)", "منبج", "الجرابلوس", "السفيرة", "أتارب", "دير حافر"],
  },
  {
    key: "homs", name: "حمص",
    regions: ["مركز حمص", "القصير", "الرستن", "تدمُر", "مخرم الفوقا", "تلكلخ", "نَوى/تلبيسة"],
  },
  { key: "hama", name: "حماة", regions: ["مركز حماة", "محردة", "السقيلبية", "مصياف", "سلمية"] },
  { key: "latakia", name: "اللاذقية", regions: ["مركز اللاذقية", "الحفة", "جبلة", "القرداحة"] },
  { key: "tartus", name: "طرطوس", regions: ["مركز طرطوس", "بانياس", "صافيتا", "الدريكيش", "الشيخ بدر"] },
  { key: "idlib", name: "إدلب", regions: ["مركز إدلب", "أريحة", "المعرة (معرة النعمان)", "حارم", "جسر الشغور"] },
  { key: "daraa", name: "درعا", regions: ["مركز درعا", "الصنمين", "إزرع"] },
  { key: "suwayda", name: "السويداء", regions: ["مركز السويداء", "شهبا", "صلخد"] },
  { key: "quneitra", name: "القنيطرة", regions: ["مركز القنيطرة", "خان أرنبة"] },
  { key: "deir-ez-zor", name: "دير الزور", regions: ["مركز دير الزور", "الميادين", "البوكمال"] },
  { key: "raqqa", name: "الرقة", regions: ["مركز الرقة", "الثورة (الطبقة)", "تل أبيض"] },
  { key: "hasakah", name: "الحسكة", regions: ["مركز الحسكة", "القامشلي", "المالكية", "رأس العين"] },
] as const;

// Arabic group labels explicitly approved by the owner after the seed brief.
const grouping = [
  {
    key: "korean", name: "كوري",
    brands: ["هيونداي (Hyundai)", "كيا (Kia)", "دايو (Daewoo)", "سانغ يونغ / ك جي مابيلتي (SsangYong / KGM)"],
  },
  {
    key: "japanese", name: "ياباني",
    brands: ["تويوتا (Toyota)", "نيسان (Nissan)", "مازدا (Mazda)", "هوندا (Honda)", "ميتسوبيشي (Mitsubishi)", "سوزوكي (Suzuki)", "سوبارو (Subaru)", "لكزس (Lexus)", "إنفينيتي (Infiniti)"],
  },
  {
    key: "chinese", name: "صيني",
    brands: ["جيلي (Geely)", "شيري (Chery)", "شانجان (Changan)", "بي واي دي (BYD)", "هافال (Haval) / جريت وول (Great Wall)", "إم جي (MG)", "دونغ فينغ (Dongfeng)", "فاو (FAW)", "جاك (JAC)"],
  },
  { key: "iranian", name: "إيراني", brands: ["سايبا (Saipa)", "إيران خودرو / شام (IKCO / Sham)"] },
  {
    key: "german", name: "ألماني",
    brands: ["مرسيدس-بنز (Mercedes-Benz)", "بي إم دبليو (BMW)", "أودي (Audi)", "فولكس فاجن (Volkswagen)", "بورش (Porsche)", "أوبل (Opel)"],
  },
  { key: "french", name: "فرنسي", brands: ["بيجو (Peugeot)", "رينو (Renault)", "ستروين (Citroën)"] },
  {
    key: "italian", name: "إيطالي",
    brands: ["فيات (Fiat)", "ألفا روميو (Alfa Romeo)", "مازيراتي (Maserati)", "فيراري (Ferrari)", "لامبورغيني (Lamborghini)"],
  },
  { key: "swedish-british", name: "سويدي / بريطاني", brands: ["فولفو (Volvo)", "لاند روفر (Land Rover)", "جاكوار (Jaguar)", "ميني (MINI)"] },
  {
    key: "american", name: "أمريكي",
    brands: ["شيفروليه (Chevrolet)", "فورد (Ford)", "جي إم سي (GMC)", "دودج (Dodge)", "جيب (Jeep)", "كاديلاك (Cadillac)", "تيسلا (Tesla)"],
  },
] as const;

const fuels = [
  ["petrol", "بنزين"],
  ["diesel", "مازوت / ديزل"],
  ["cng", "غاز طبيعي / سي إن جي"],
  ["hybrid", "هايبرد / هجين"],
  ["electric", "كهرباء بالكامل"],
] as const;

const tows = [
  ["hydraulic", "سطحة هيدروليك (نزول كامل)"],
  ["ordinary", "سطحة العادية / الثابتة"],
  ["winch", "سطحة ونش / رافعة"],
  ["closed", "سطحة مغلقة"],
  ["two_wheel", "سحب دولابين / رافعة شوكية (شال)"],
] as const;

function codedRows(category: string, entries: readonly (readonly [string, string])[]) {
  return entries.map(([code, nameAr], index) => ({
    id: referenceId(`${category}/${code}`), code, nameAr, displayOrder: index + 1, isActive: true,
  }));
}

export const referenceSeed = {
  governorates: geography.map((g) => ({ id: referenceId(`governorate/${g.key}`), nameAr: g.name, isActive: true })),
  regions: geography.flatMap((g) => g.regions.map((nameAr, index) => ({
    id: referenceId(`region/${g.key}/${index + 1}`),
    governorateId: referenceId(`governorate/${g.key}`), nameAr, isActive: true,
  }))),
  brand_groups: grouping.map((g, index) => ({
    id: referenceId(`brand-group/${g.key}`), nameAr: g.name, displayOrder: index + 1, isActive: true,
  })),
  brands: grouping.flatMap((g) => g.brands.map((nameAr, index) => ({
    id: referenceId(`brand/${g.key}/${index + 1}`),
    brandGroupId: referenceId(`brand-group/${g.key}`), nameAr, displayOrder: index + 1, isActive: true,
  }))),
  fuel_types: codedRows("fuel", fuels),
  tow_types: codedRows("tow", tows),
};

export const referenceTableNames = Object.keys(referenceSeed);