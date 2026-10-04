import nextEnv from "@next/env";
import { closeDatabase } from "../client.ts";
import { verifyCatalog } from "../catalog.ts";
import { seedReferenceData } from "./seed.ts";
import { seedManualScenarios } from "./manual-scenarios.ts";
import { assertManualSeedSafety } from "./manual-seed-safety.ts";

nextEnv.loadEnvConfig(process.cwd(), true);

try {
  const args = process.argv.slice(2);
  const manual = args.includes("--manual-scenarios");
  if (args.some(arg => !["--manual-scenarios", "--confirm-development"].includes(arg)) ||
    (!manual && args.length)) throw new Error("Unknown or incomplete seed options");
  if (manual) assertManualSeedSafety(args.includes("--confirm-development"));
  if (process.env.NODE_ENV === "production") {
    throw new Error("Manual reference seed is disabled in production mode");
  }
  await verifyCatalog();
  console.log(JSON.stringify({ status: "passed", ...(manual ? {
    manualScenarios: await seedManualScenarios({ confirmDevelopment: args.includes("--confirm-development") }),
  } : { referenceSeed: await seedReferenceData() }) }, null, 2));
} catch {
  console.error("Seed failed; no partial seed committed. Manual accounts require --manual-scenarios --confirm-development, development/test mode, and the approved development database. Check reference availability and identity conflicts; sensitive database details withheld.");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}