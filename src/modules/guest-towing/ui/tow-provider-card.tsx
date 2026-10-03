import type { TowingProvider } from "../contracts";

type TowProviderCardProps = {
  provider: TowingProvider;
  onNotify: (provider: TowingProvider) => void;
  disabled?: boolean;
};

export default function TowProviderCard({ provider, onNotify, disabled = false }: TowProviderCardProps) {
  return (
    <article className="tow-provider-card" data-provider-id={provider.id}>
      <div className="tow-provider-head">
        <div>
          <h3>{provider.businessName}</h3>
          <a className="tow-provider-phone" href={`tel:${provider.phone}`} dir="ltr">{provider.phone}</a>
        </div>
      </div>
      <dl className="tow-provider-details">
        <div>
          <dt>المحافظات التي يغطيها</dt>
          <dd>{provider.coverage.length ? provider.coverage.map((item) => item.name).join("، ") : "لم تُحدَّد المحافظات."}</dd>
        </div>
        <div>
          <dt>نوع السطحة</dt>
          <dd>{provider.towType || "لم يُحدَّد نوع السطحة."}</dd>
        </div>
      </dl>
      <button className="tow-button tow-button-primary tow-provider-action" type="button" onClick={() => onNotify(provider)} disabled={disabled}>
        أبلغ المزود
      </button>
    </article>
  );
}