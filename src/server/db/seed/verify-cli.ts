import assert from "node:assert/strict";
import nextEnv from "@next/env";
import { verifyCatalog } from "../catalog.ts";
import { closeDatabase } from "../client.ts";
import { verifyInitialReferenceData } from "./verify.ts";

nextEnv.loadEnvConfig(process.cwd());

try {
  const catalog = await verifyCatalog();
  const initialReferences = await verifyInitialReferenceData();
  console.log(JSON.stringify({ status: "passed", catalog, initialReferences }, null, 2));
} catch (error) {
  console.error("Initial reference verification failed:", error instanceof assert.AssertionError
    ? error.message : "Database operation failed; sensitive details withheld.");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}