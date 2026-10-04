import "server-only";
import { sql } from "drizzle-orm";
import * as s from "../schema.ts";
import { providerFixtureOwner, type providerFixtures } from "./provider-fixture-data.ts";
import type { ProviderFixtureConnection } from "./provider-fixtures.ts";

export async function lockProviderFixtures(tx: ProviderFixtureConnection) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(77022026)`);
}
export function assertProviderOwnerIdentity(rows: typeof s.opsUsers.$inferSelect[]) {
  const owner = rows[0];
  if (rows.length !== 1 || owner.id !== providerFixtureOwner.id || owner.username !== providerFixtureOwner.username ||
    owner.name !== providerFixtureOwner.name || owner.role !== "operations" || owner.isActive) {
    throw new Error("Provider fixture creator identity collision; no existing Operations row will be changed");
  }
}
export function assertProviderFixtureIdentity(rows: typeof s.providers.$inferSelect[], fixture: typeof providerFixtures[number]) {
  const row = rows[0], p = fixture.provider;
  if (rows.length !== 1 || row.id !== p.id || row.businessName !== p.businessName || row.phone !== p.phone ||
    row.whatsappNumber !== p.whatsappNumber || row.serviceType !== p.serviceType || row.createdBy !== p.createdBy) {
    throw new Error("Provider fixture identity collision; no existing provider will be changed");
  }
}