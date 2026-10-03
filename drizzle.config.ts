import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";
import { readDatabaseConfig } from "./src/server/config/database";

loadEnvConfig(process.cwd());

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: readDatabaseConfig().connectionString },
});