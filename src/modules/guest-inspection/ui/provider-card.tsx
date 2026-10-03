import type { InspectionProvider } from "../contracts";

const enumLabels: Record<string, string> = {
  classic: "كلاسيكية", mid: "متوسطة", modern: "حديثة", car: "سيارة", truck: "شاحنة",
};

export function phoneDisplay(value: string) {
  return <span className="guest-ltr" dir="ltr">{value}</span>;
}

function humanValues(values: unknown, labels: Record<string, string> = {}) {
  if (!Array.isArray(values) || values.length === 0) return "غير محدد";
  const readable = values.filter((value) => typeof value === "string" || typeof value === "number")
    .map((value) => labels[String(value)] ?? String(value));
  return readable.length ? readable.join("، ") : "غير محدد";
}

function specializationsText(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) return humanValues(value);
  if (value && typeof value === "object") {
    const values = Object.values(value).filter((item) => typeof item === "string" && item.trim());
    return values.length ? values.join("، ") : "غير محدد";
  }
  return "غير محدد";
}

export default function ProviderCard({ provider, selected, onSelect }: {
  provider: InspectionProvider; selected: boolean; onSelect: () => void;
}) {
  return (
    <label className={`provider-option${selected ? " is-selected" : ""}`}>
      <input type="radio" name="provider" value={provider.id} checked={selected} onChange={onSelect}
        aria-label={`اختيار ${provider.businessName}`} />
      <span className="provider-card">
        <span className="provider-card-head">
          <span>
            <strong className="provider-name">{provider.businessName}</strong>
            <span className="provider-region">{provider.regionName}</span>
          </span>
          <span className="provider-select-mark" aria-hidden="true">{selected ? "✓" : ""}</span>
        </span>
        <span className="provider-phone">{phoneDisplay(provider.phone)}</span>
        <span className="provider-details">
          <span><b>مجموعات الماركات</b><span>{humanValues(provider.brandGroups)}</span></span>
          <span><b>الماركات</b><span>{humanValues(provider.brands)}</span></span>
          <span><b>فئات السنوات</b><span>{humanValues(provider.yearCategories, enumLabels)}</span></span>
          <span><b>أنظمة الطاقة</b><span>{humanValues(provider.fuelTypes)}</span></span>
          <span><b>فئة المركبة</b><span>{humanValues(provider.vehicleCategories, enumLabels)}</span></span>
          <span><b>التخصصات</b><span>{specializationsText(provider.specializations)}</span></span>
          <span><b>ساعات العمل</b><span dir="ltr">{provider.hours.start} – {provider.hours.end}</span></span>
        </span>
      </span>
    </label>
  );
}