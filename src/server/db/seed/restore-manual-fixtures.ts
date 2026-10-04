import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDatabase } from "../client.ts";
import * as s from "../schema.ts";
import { assertManualSeedSafety } from "./manual-seed-safety.ts";
import { manualScenarios } from "./manual-scenario-data.ts";
import type { ProviderFixtureConnection } from "./provider-fixtures.ts";

/** Explicit restoration only. Ordinary seed retains its existing preserve-edits behavior. */
export async function restoreManualFixtures(options: { confirmDevelopment: boolean }, connection?: ProviderFixtureConnection) {
  assertManualSeedSafety(options.confirmDevelopment);
  return (connection ?? getDatabase()).transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(77012026)`);
    let vehiclesRestored = 0;
    for (const scenario of manualScenarios) {
      const [user] = await tx.select().from(s.users).where(eq(s.users.id, scenario.id)).for("update");
      if (!user || user.phone !== scenario.phone || user.name !== scenario.name || !user.isActive || user.isDeleted)
        throw new Error("Manual fixture identity mismatch; restoration refuses unrelated accounts");
      if (user.homeGovernorateId !== scenario.homeGovernorateId)
        await tx.update(s.users).set({ homeGovernorateId: scenario.homeGovernorateId }).where(eq(s.users.id, scenario.id));
      if (scenario.vehicle) {
        const [vehicle] = await tx.select().from(s.vehicles).where(eq(s.vehicles.id, scenario.vehicle.id)).for("update");
        if (!vehicle || vehicle.userId !== scenario.id || vehicle.notes !== scenario.vehicle.notes)
          throw new Error("Manual vehicle identity mismatch; restoration refuses unrelated vehicles");
        const { id, ...fields } = scenario.vehicle;
        await tx.update(s.vehicles).set(fields).where(eq(s.vehicles.id, id));
        vehiclesRestored++;
      }
    }
    return { accounts: manualScenarios.length, vehiclesRestored, otherVehiclesPreserved: true };
  });
}