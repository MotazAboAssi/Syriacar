import type { ReactNode } from "react";
import type { TowingProvider } from "../contracts";
import TowProviderCard from "./tow-provider-card";

type TowProviderSectionProps = {
  section: "A" | "B";
  title: string;
  providers: TowingProvider[];
  onNotify: (provider: TowingProvider) => void;
  empty?: ReactNode;
  disabled?: boolean;
};

export default function TowProviderSection({ section, title, providers, onNotify, empty, disabled }: TowProviderSectionProps) {
  return (
    <section className="tow-result-section" data-section={section} aria-labelledby={`tow-section-${section}`}>
      <div className="tow-result-heading">
        <h2 id={`tow-section-${section}`}>{title}</h2>
        <p>{providers.length ? `${providers.length} مزود` : "لا يوجد مزودون"}</p>
      </div>
      {providers.length > 0 ? (
        <div className="tow-provider-list">
          {providers.map((provider) => (
            <TowProviderCard key={provider.id} provider={provider} onNotify={onNotify} disabled={disabled} />
          ))}
        </div>
      ) : empty}
    </section>
  );
}