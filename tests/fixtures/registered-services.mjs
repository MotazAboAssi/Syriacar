import { randomUUID, randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTowingFixture, noon } from "./guest-towing.mjs";
import { sessionCookie } from "../../src/modules/account/security.ts";
import { registeredHandlers } from "../../src/modules/registered-services/http.ts";
import { accountHandlers } from "../../src/modules/account/http.ts";
import { inspectionHandlers } from "../../src/modules/guest-inspection/http.ts";
import { towingHandlers } from "../../src/modules/guest-towing/http.ts";
import * as s from "../../src/server/db/schema.ts";

export const origin = "https://registered-verification.example";
export function req(path, method = "GET", input, cookie, extras = {}) {
  return new Request(origin + path, {
    method, headers: { Origin: origin, ...(input === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}), ...extras },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
export async function parsed(response) {
  response = await response;
  return { status: response.status, data: await response.json(), headers: response.headers };
}
/** Genuine PG handlers in rollback-only fixtures; no OTP/Whapi or live account. */
export async function withRegisteredFixture(check) {
  return withTowingFixture(async f => {
    const runtime = { now: () => noon, secret: "registered-verification-only-secret" };
    const a = randomUUID(), b = randomUUID(), va = randomUUID(), vb = randomUUID();
    let number = randomInt(100000000, 900000000);
    await f.tx.insert(s.users).values([a, b].map(id => ({
      id, name: id === a ? "مالك تحقق أ" : "مالك تحقق ب", phone: "+963" + number++,
      passwordHash: "test-only-not-a-credential", isActive: true, homeGovernorateId: f.gov,
      createdAt: noon, lastActiveAt: noon,
    })));
    await f.tx.insert(s.vehicles).values([[va, a], [vb, b]].map(([id, userId]) => ({
      id, userId, brandGroupId: f.group.id, brandId: f.brand.id, year: 1990, yearCategory: "classic",
      fuelTypeId: f.fuel.id, vehicleCategory: "truck", verificationStatus: "pending_verification",
      createdAt: noon,
    })));
    const [capable] = await f.tx.select().from(s.providers)
      .where(eq(s.providers.businessName, "verification only capable"));
    const [active] = await f.tx.select().from(s.providers)
      .where(eq(s.providers.businessName, "verification only active"));
    const [closed] = await f.tx.select().from(s.providers)
      .where(eq(s.providers.businessName, "verification only closedToday"));
    const cookieA = (await sessionCookie(a, runtime)).split(";")[0];
    const cookieB = (await sessionCookie(b, runtime)).split(";")[0];
    const api = registeredHandlers(() => f.tx, runtime);
    const inspection = {
      vehicleId: va, governorateId: f.gov, regionId: f.region, providerId: capable.id, acceptedTerms: true,
    };
    const towing = {
      originGovernorateId: f.gov, destGovernorateId: f.otherGov, providerId: f.ids.originA, acceptedTerms: true,
    };
    await check({ ...f, api, runtime, a, b, va, vb, capable, active, closed, cookieA, cookieB, inspection, towing,
      accountApi: accountHandlers(() => f.tx, runtime),
      inspectionApi: inspectionHandlers(() => f.tx, runtime),
      towingApi: towingHandlers(() => f.tx, runtime),
      inspect: (input = inspection, cookie = cookieA) => parsed(api.inspection(req("/api/inspection/requests", "POST", input, cookie))),
      tow: (input = towing, cookie = cookieA) => parsed(api.towing(req("/api/towing/requests", "POST", input, cookie))),
    });
  });
}