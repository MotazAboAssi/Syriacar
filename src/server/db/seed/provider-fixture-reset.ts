import "server-only";
import { eq, inArray } from "drizzle-orm";
import { getDatabase } from "../client.ts";
import * as s from "../schema.ts";
import { assertManualSeedSafety } from "./manual-seed-safety.ts";
import { providerFixtures, providerFixtureOwner } from "./provider-fixture-data.ts";
import { lockProviderFixtures, assertProviderFixtureIdentity, assertProviderOwnerIdentity } from "./provider-fixture-ownership.ts";
import type { ProviderFixtureConnection } from "./provider-fixtures.ts";

/** Explicit optional cleanup. No requests/notices/history/users are ever removed. */
export async function removeProviderFixtures(options: { confirmDevelopment: boolean }, connection?: ProviderFixtureConnection) {
  assertManualSeedSafety(options.confirmDevelopment);
  return (connection ?? getDatabase()).transaction(async tx => {
    await lockProviderFixtures(tx);
    const ids = providerFixtures.map(f => f.provider.id);
    const rows = await tx.select().from(s.providers).where(inArray(s.providers.id, ids)).for("update");
    if (!rows.length) return { removed: 0, creatorRetained: true };
    const owners = await tx.select().from(s.opsUsers).where(eq(s.opsUsers.id, providerFixtureOwner.id)).for("share");
    assertProviderOwnerIdentity(owners);
    for (const row of rows) assertProviderFixtureIdentity([row], providerFixtures.find(f => f.provider.id === row.id)!);
    const present = rows.map(r => r.id);
    for (const table of [s.notifications, s.providerEditRequests, s.providerPushSubscriptions]) {
      const linked = await tx.select({ id: table.id }).from(table).where(inArray(table.providerId, present)).for("share");
      if (linked.length) throw new Error("Provider fixtures have linked history/subscriptions; removal refused without deleting history");
    }
    // Child tables have no outgoing history links. Exact verified provider IDs only.
    for (const table of [s.providerCoverage, s.providerBrands, s.providerBrandGroups,
      s.providerYearCategories, s.providerFuelTypes, s.providerVehicleCategories]) {
      await tx.delete(table).where(inArray(table.providerId, present));
    }
    await tx.delete(s.providers).where(inArray(s.providers.id, present));
    // Keep the disabled creator: never risk removing a row referenced by Ops history.
    return { removed: rows.length, creatorRetained: true };
  });
}