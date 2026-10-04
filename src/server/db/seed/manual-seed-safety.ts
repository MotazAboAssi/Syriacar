import "server-only";
import { createHash } from "node:crypto";
import { readDatabaseConfig } from "../../config/database.ts";

// Non-secret binding to this project's approved DEVELOPMENT endpoint/database.
// Never derive this allowlist from the target supplied at seed execution time.
export const developmentTargetFingerprint = "ca6f98cdf3fe12ebbd30bf104db6d24e1d49419db4926674e094a1c8648596d8";

export function targetFingerprint(connectionString: string) {
  const u = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(u.protocol)) throw new Error("Invalid database target");
  return createHash("sha256").update(JSON.stringify([
    u.hostname, u.port || "5432", decodeURIComponent(u.pathname),
  ])).digest("hex");
}

export function assertManualSeedEnvironment(env: NodeJS.ProcessEnv, confirmed: boolean) {
  if (!confirmed) throw new Error("Manual seed requires explicit development confirmation");
  if (!["development", "test"].includes(env.NODE_ENV ?? "")) throw new Error("Manual seed requires development/test NODE_ENV");
  if (env.REPLIT_DEPLOYMENT !== undefined && env.REPLIT_DEPLOYMENT !== "0") {
    throw new Error("Manual seed is forbidden in a published deployment");
  }
  // REPLIT_ENVIRONMENT describes platform infrastructure, not app publication:
  // even this development workspace carries a production infrastructure value.
  // The documented REPLIT_DEPLOYMENT flag + NODE_ENV + pinned DB are the gates.
}

export function assertManualSeedSafety(confirmed: boolean) {
  // Check mode BEFORE accessing even database configuration, let alone connecting.
  assertManualSeedEnvironment(process.env, confirmed);
  if (targetFingerprint(readDatabaseConfig().connectionString) !== developmentTargetFingerprint) {
    throw new Error("Manual seed target is not the approved development database");
  }
}