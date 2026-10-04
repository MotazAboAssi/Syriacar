import type { ReactNode } from "react";
import { ProviderShell } from "../../../modules/provider-management/ui/ProviderUI";

export default function ProviderProtectedLayout({ children }: { children: ReactNode }) {
  return <ProviderShell>{children}</ProviderShell>;
}