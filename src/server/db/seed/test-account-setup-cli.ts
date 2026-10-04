import nextEnv from "@next/env";
import { closeDatabase } from "../client.ts";
import { assertManualSeedSafety } from "./manual-seed-safety.ts";
import { seedManualScenarios } from "./manual-scenarios.ts";
import { seedProviderLoginFixtures } from "./provider-login-fixtures.ts";
import { restoreManualFixtures } from "./restore-manual-fixtures.ts";
nextEnv.loadEnvConfig(process.cwd(), true);
try {
  if (process.argv.slice(2).join(" ") !== "--confirm-development") throw new Error("Explicit confirmation required");
  assertManualSeedSafety(true);
  await seedManualScenarios({ confirmDevelopment: true });
  const restored = await restoreManualFixtures({ confirmDevelopment: true });
  console.log(JSON.stringify({ restored, manual: await seedManualScenarios({ confirmDevelopment: true }),
    provider: await seedProviderLoginFixtures({ confirmDevelopment: true }) }, null, 2));
} catch {
  console.error("Development account preparation refused; check approved target, explicit confirmation and fixture identity. Sensitive details withheld.");
  process.exitCode = 1;
} finally { await closeDatabase(); }