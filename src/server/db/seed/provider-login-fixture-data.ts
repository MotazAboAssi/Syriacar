import { referenceId } from "./reference-data.ts";
import { providerFixtures } from "./provider-fixture-data.ts";

// Existing Active fixture is reused, not duplicated. WhatsApp number stays unchanged.
export const providerLoginFixtures = [
  { key: "active", id: providerFixtures[0].provider.id, phone: "+963900008801", status: "active" as const,
    businessName: providerFixtures[0].provider.businessName },
  { key: "pending", id: referenceId("dev-provider-login/pending"), phone: "+963900008802", status: "pending" as const,
    businessName: "تجريبي فقط — مزود بانتظار الاعتماد" },
  { key: "disabled", id: referenceId("dev-provider-login/disabled"), phone: "+963900008803", status: "disabled" as const,
    businessName: "تجريبي فقط — مزود معطل" },
];
export const providerLoginNoticeId = referenceId("dev-provider-login/notification/guest");
export const providerLoginRequestId = referenceId("dev-provider-login/request/guest");