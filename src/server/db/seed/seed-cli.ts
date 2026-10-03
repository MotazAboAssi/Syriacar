import nextEnv from "@next/env";
import { closeDatabase } from "../client.ts";
import { verifyCatalog } from "../catalog.ts";
import { seedReferenceData } from "./seed.ts";

nextEnv.loadEnvConfig(process.cwd());

try {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Manual reference seed is disabled in production mode");
  }
  await verifyCatalog();
  console.log(JSON.stringify({ status: "passed", referenceSeed: await seedReferenceData() }, null, 2));
} catch {
  console.error("Reference seed failed; no partial seed committed. Check development configuration, schema, and unique-key conflicts. Sensitive database details withheld.");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}