import nextEnv from "@next/env";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as s from "../../src/server/db/schema.ts";
import { securityRateLimits } from "../../src/server/db/security-rate-limits.ts";
import { readDatabaseConfig } from "../../src/server/config/database.ts";
import { accountHandlers } from "../../src/modules/account/http.ts";
import { RegistrationPreparation } from "../../src/modules/account/registration-preparation.ts";
import { hashPassword } from "../../src/modules/account/security.ts";
import { req, parsed, outcome, password } from "./account.mjs";

nextEnv.loadEnvConfig(process.cwd());
const [schema, phone, label, hold] = process.argv.slice(2);
if (!/^rate_fixture_[a-f0-9]{32}$/.test(schema)) throw new Error("Private fixture required");
for (const table of [...Object.values(s), securityRateLimits].filter(t => is(t, PgTable))) {
  table[PgTable.Symbol.Schema] = schema;
}
const pool = new Pool({ connectionString: readDatabaseConfig().connectionString, max: 2,
  application_name: label, options: `-c search_path=${schema},public -c timezone=UTC -c statement_timeout=5000` });
const db = drizzle(pool);
let hashes = 0, release;
const released = new Promise(resolve => { release = resolve; });
const runtime = {
  secret: "registration-preparation-fixture", code: () => "123456",
  registrationPreparation: new RegistrationPreparation({ concurrency: 1 }),
  registrationHash: async value => {
    hashes++; process.send({ event: "hash" });
    if (hold === "hold") await released;
    return hashPassword(value);
  },
  sender: async () => outcome(),
};
process.on("message", async message => {
  if (message === "release") return release();
  if (message !== "start") return;
  try {
    const result = await parsed(await accountHandlers(() => db, runtime).register(
      req("register", "POST", { phone, password, name: label })));
    process.send({ event: "done", status: result.status, hashes });
  } catch { process.send({ event: "error" }); process.exitCode = 1; }
  finally { await pool.end(); process.disconnect(); }
});
process.send({ event: "ready" });