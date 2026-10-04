import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import * as s from "../../src/server/db/schema.ts";
import { defaultWorkDays } from "../../src/server/db/schema/types.ts";
import { securityRateLimits as rates } from "../../src/server/db/security-rate-limits.ts";
import { inspectionHandlers } from "../../src/modules/guest-inspection/http.ts";
import { towingHandlers } from "../../src/modules/guest-towing/http.ts";
import { guestScopes, globalIdentity, guestTransaction } from "../../src/modules/guest-security/rate-limits.ts";
import { rateLimitHash } from "../../src/modules/account/security.ts";
import { AccountLimits } from "../../src/modules/account/rate-limits.ts";
import { withRateScratch } from "./rate-limit-scratch.mjs";

export const quotaSecret = "guest-scratch-fixture-only";
export const runtime = { now: () => new Date("2026-10-04T09:00:00Z"), quotaSecret };
export const request = (kind, body, path = "requests", extras = {}) => new Request(
  "https://guest-verification.example/api/guest-" + kind + "/" + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...extras }, body: JSON.stringify(body),
  });
export async function result(response) {
  const r = await response;
  return { status: r.status, data: await r.json(), headers: r.headers };
}
export const hash = (scope, identity) => rateLimitHash(scope, identity, { secret: quotaSecret });
export const bucket = async (db, scope, identity) => (await db.select().from(rates)
  .where(and(eq(rates.scope, scope), eq(rates.keyHash, hash(scope, identity)))))[0];
export async function counts(db) {
  return {
    parents: (await db.select().from(s.serviceRequests)).length,
    notifications: (await db.select().from(s.notifications)).length,
  };
}
export async function setCount(db, scope, identity, count) {
  // Create legitimate state via shared admission, then position a boundary in scratch only.
  const keyIdentity = scope === guestScopes.parentGlobal ? globalIdentity : identity;
  const limit = scope === guestScopes.parentGlobal ? 20 : scope === guestScopes.parentPhone ? 10 : 40;
  await guestTransaction(db, tx => new AccountLimits().admit(tx,
    [{ scope, identity: keyIdentity, limit, seconds: 3600 }], { secret: quotaSecret }));
  await db.execute(sql`UPDATE ${rates} SET count=${count}
    WHERE scope=${scope} AND key_hash=${hash(scope, keyIdentity)}`);
}

/** Real committed private business fixtures; never synthetic writes in public. */
export async function withGuestScratch(check) {
  await withRateScratch(async base => {
    const { db } = base;
    const gov = randomUUID(), otherGov = randomUUID(), region = randomUUID(), emptyRegion = randomUUID(), ops = randomUUID();
    await db.insert(s.governorates).values([
      { id: gov, nameAr: "quota verification", isActive: true },
      { id: otherGov, nameAr: "quota verification other", isActive: true },
    ]);
    await db.insert(s.regions).values([
      { id: region, governorateId: gov, nameAr: "quota verification", isActive: true },
      { id: emptyRegion, governorateId: gov, nameAr: "quota empty", isActive: true },
    ]);
    await db.insert(s.opsUsers).values({ id: ops, name: "quota fixture", username: "quota-" + ops,
      passwordHash: "fixture-only-not-a-credential", role: "operations", createdAt: runtime.now() });
    const ids = { inspection: randomUUID(), towing: randomUUID(), partial: randomUUID() };
    await db.insert(s.providers).values(Object.entries(ids).map(([kind, id], i) => ({
      id, businessName: "quota " + kind, phone: "+1999999000" + i, whatsappNumber: "+1999999100" + i,
      passwordHash: "fixture-only-not-a-credential", serviceType: kind === "inspection" ? "inspection" : "towing",
      status: "active", governorateId: gov, regionId: region, workDays: defaultWorkDays,
      createdAt: runtime.now(), createdBy: ops,
    })));
    await db.insert(s.providerCoverage).values([
      { id: randomUUID(), providerId: ids.towing, governorateId: gov },
      { id: randomUUID(), providerId: ids.towing, governorateId: otherGov },
      { id: randomUUID(), providerId: ids.partial, governorateId: gov },
    ]);
    let next = 100000000;
    const phone = () => "+963" + next++;
    const inspection = (p = phone(), matched = true) => ({
      governorateId: gov, regionId: matched ? region : emptyRegion,
      providerId: matched ? ids.inspection : null, guestName: "Quota fixture", guestPhone: p, acceptedTerms: true,
    });
    const towing = (p = phone()) => ({ originGovernorateId: gov, destGovernorateId: otherGov,
      providerId: ids.towing, guestName: "Quota fixture", guestPhone: p, acceptedTerms: true });
    const api = { inspection: inspectionHandlers(() => db, runtime), towing: towingHandlers(() => db, runtime) };
    const create = (kind, body, extras) => result(api[kind].create(request(kind, body, "requests", extras)));
    await check({ ...base, gov, otherGov, region, emptyRegion, ids, ops, phone, inspection, towing, api, create, runtime });
  });
}