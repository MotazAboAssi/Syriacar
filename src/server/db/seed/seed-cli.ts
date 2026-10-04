import nextEnv from "@next/env";
import { closeDatabase } from "../client.ts";
import { verifyCatalog } from "../catalog.ts";
import { seedReferenceData } from "./seed.ts";
import { seedManualScenarios } from "./manual-scenarios.ts";
import { assertManualSeedSafety } from "./manual-seed-safety.ts";
import { seedProviderFixtures } from "./provider-fixtures.ts";
import { removeProviderFixtures } from "./provider-fixture-reset.ts";

nextEnv.loadEnvConfig(process.cwd(), true);

try {
  const args = process.argv.slice(2);
  const manual = args.includes("--manual-scenarios");
  const providers = args.includes("--provider-fixtures");
  const removeProviders = args.includes("--remove-provider-fixtures");
  const modes = [manual, providers, removeProviders].filter(Boolean).length;
  if (new Set(args).size !== args.length ||
    args.some(arg => !["--manual-scenarios", "--provider-fixtures", "--remove-provider-fixtures", "--confirm-development"].includes(arg)) ||
    modes > 1 || (!modes && args.length)) throw new Error("Unknown or incomplete seed options");
  if (modes) assertManualSeedSafety(args.includes("--confirm-development"));
  if (process.env.NODE_ENV === "production") {
    throw new Error("Manual reference seed is disabled in production mode");
  }
  await verifyCatalog();
  console.log(JSON.stringify({ status: "passed", ...(manual ? {
    manualScenarios: await seedManualScenarios({ confirmDevelopment: args.includes("--confirm-development") }),
  } : providers ? {
    providerFixtures: await seedProviderFixtures({ confirmDevelopment: args.includes("--confirm-development") }),
  } : removeProviders ? {
    providerFixturesRemoval: await removeProviderFixtures({ confirmDevelopment: args.includes("--confirm-development") }),
  } : { referenceSeed: await seedReferenceData() }) }, null, 2));
} catch {
  console.error("Seed failed; no partial seed committed. Fixture modes require explicit --confirm-development, development/test mode and the approved development database. Check references, identity conflicts or linked history blocking removal; sensitive database details withheld.");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}