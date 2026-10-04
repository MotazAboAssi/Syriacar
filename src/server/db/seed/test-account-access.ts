import "server-only";
import { AccountError } from "../../../modules/account/validation.ts";
import { manualScenarios } from "./manual-scenario-data.ts";
import { providerFixtures } from "./provider-fixture-data.ts";
import { providerLoginFixtures } from "./provider-login-fixture-data.ts";
import { assertManualSeedSafety } from "./manual-seed-safety.ts";

const identities = new Set([
  ...manualScenarios.flatMap(row => [row.id, row.phone]),
  ...providerFixtures.flatMap(row => [row.provider.id, row.provider.phone]),
  ...providerLoginFixtures.flatMap(row => [row.id, row.phone]),
]);
/** Runtime fence as well as CLI protection: copied test rows cannot authenticate in production. */
export function requireTestAccountEnvironment(identity: string | null) {
  if (!identity || !identities.has(identity)) return;
  try { assertManualSeedSafety(true); }
  catch { throw new AccountError(403, "حسابات الاختبار متاحة في بيئة التطوير المعتمدة فقط."); }
}