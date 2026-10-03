import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { applicationRowCounts } from "../catalog.ts";
import { getDatabase } from "../client.ts";
import * as s from "../schema.ts";
import { referenceSeed, referenceTableNames } from "./reference-data.ts";
import { seedReferenceData } from "./seed.ts";

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

async function readReferences(connection: Database | Transaction = getDatabase()) {
  return {
    governorates: (await connection.select().from(s.governorates)).sort(byId),
    regions: (await connection.select().from(s.regions)).sort(byId),
    brand_groups: (await connection.select().from(s.brandGroups)).sort(byId),
    brands: (await connection.select().from(s.brands)).sort(byId),
    fuel_types: (await connection.select().from(s.fuelTypes)).sort(byId),
    tow_types: (await connection.select().from(s.towTypes)).sort(byId),
  };
}

/** Initial-state acceptance check; not a restriction on future Operations data. */
export async function verifyInitialReferenceData() {
  const db = getDatabase();
  const beforeCounts = await applicationRowCounts();
  assert.ok(beforeCounts.filter((t) => !referenceTableNames.includes(t.table_name))
    .every((t) => t.row_count === 0), "Initial verification requires no non-reference data");
  const original = await readReferences();
  for (const name of Object.keys(referenceSeed) as (keyof typeof referenceSeed)[]) {
    assert.deepEqual(original[name], [...referenceSeed[name]].sort(byId),
      `${name}: exact initial IDs, count, names, relationships, active flags, and supported ordering`);
  }

  async function rolledBack(check: (tx: Transaction) => Promise<void>) {
    const rollback = new Error("ROLLBACK_REFERENCE_VERIFICATION");
    try {
      await db.transaction(async (tx) => {
        await check(tx);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  // Prove a rerun preserves renamed/deactivated/reordered/reparented records
  // and additional managed rows. No UI permissions or admin account are added.
  await rolledBack(async (tx) => {
    const changed = { nameAr: "تحقق مؤقت فقط", isActive: false };
    await tx.update(s.governorates).set(changed).where(eq(s.governorates.id, referenceSeed.governorates[0].id));
    await tx.update(s.regions).set({ ...changed, governorateId: referenceSeed.governorates[1].id })
      .where(eq(s.regions.id, referenceSeed.regions[0].id));
    await tx.update(s.brandGroups).set({ ...changed, displayOrder: 99 })
      .where(eq(s.brandGroups.id, referenceSeed.brand_groups[0].id));
    await tx.update(s.brands).set({ ...changed, displayOrder: 99, brandGroupId: referenceSeed.brand_groups[1].id })
      .where(eq(s.brands.id, referenceSeed.brands[0].id));
    await tx.update(s.fuelTypes).set({ ...changed, displayOrder: 99, code: `verify_${randomUUID()}` })
      .where(eq(s.fuelTypes.id, referenceSeed.fuel_types[0].id));
    await tx.update(s.towTypes).set({ ...changed, displayOrder: 99, code: `verify_${randomUUID()}` })
      .where(eq(s.towTypes.id, referenceSeed.tow_types[0].id));

    const governorate = randomUUID(), group = randomUUID();
    await tx.insert(s.governorates).values({ id: governorate, ...changed });
    await tx.insert(s.regions).values({ id: randomUUID(), governorateId: governorate, ...changed });
    await tx.insert(s.brandGroups).values({ id: group, displayOrder: 100, ...changed });
    await tx.insert(s.brands).values({ id: randomUUID(), brandGroupId: group, displayOrder: 100, ...changed });
    await tx.insert(s.fuelTypes).values({ id: randomUUID(), code: `verify_${randomUUID()}`, displayOrder: 100, ...changed });
    await tx.insert(s.towTypes).values({ id: randomUUID(), code: `verify_${randomUUID()}`, displayOrder: 100, ...changed });
    const managed = await readReferences(tx);
    const rerun = await seedReferenceData(tx);
    assert.ok(Object.values(rerun).every((r) => r.inserted === 0), "Rerun must not duplicate renamed IDs");
    assert.deepEqual(await readReferences(tx), managed, "Seed must not overwrite Operations-managed data");
  });

  // A conflict other than the stable PK must fail, not silently skip a seed row.
  // The earlier brand insertion must also roll back when the later fuel fails.
  await rolledBack(async (tx) => {
    await tx.delete(s.brands).where(eq(s.brands.id, referenceSeed.brands[0].id));
    await tx.update(s.fuelTypes).set({ id: randomUUID() })
      .where(eq(s.fuelTypes.id, referenceSeed.fuel_types[0].id));
    const beforeFailure = await readReferences(tx);
    await assert.rejects(() => seedReferenceData(tx), (error: unknown) => {
      type Failure = { code?: string; constraint?: string; cause?: Failure };
      let failure = error as Failure;
      while (failure.cause) failure = failure.cause;
      return failure.code === "23505" && failure.constraint === "fuel_types_code_unique";
    });
    assert.deepEqual(await readReferences(tx), beforeFailure, "Failed seed must be atomic");
  });

  assert.deepEqual(await readReferences(), original, "Verification must restore all initial reference values");
  assert.deepEqual(await applicationRowCounts(), beforeCounts, "Verification must not persist any fixtures");
  return {
    counts: Object.fromEntries(Object.entries(original).map(([name, rows]) => [name, rows.length])),
    exactValuesAndSupportedOrdering: true,
    regionGovernorateAndBrandGroupRelationships: true,
    operationsEditsAndAdditionalRowsPreserved: true,
    uniquenessConflictRollsBackEntireSeed: true,
    allVerificationChangesRolledBack: true,
    nonReferenceRows: 0,
  };
}