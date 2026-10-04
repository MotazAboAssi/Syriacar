import "server-only";
import { eq, or } from "drizzle-orm";
import { getDatabase } from "../client.ts";
import * as s from "../schema.ts";
import { hashPassword } from "../../../modules/account/security.ts";
import { assertManualSeedSafety } from "./manual-seed-safety.ts";
import { manualLocality, manualTestPassword } from "./manual-scenario-data.ts";
import { providerFixtures, providerFixtureOwner } from "./provider-fixture-data.ts";
import { lockProviderFixtures, assertProviderFixtureIdentity, assertProviderOwnerIdentity } from "./provider-fixture-ownership.ts";
import { providerLoginFixtures, providerLoginNoticeId, providerLoginRequestId } from "./provider-login-fixture-data.ts";
import type { ProviderFixtureConnection } from "./provider-fixtures.ts";

/** Explicit test-preparation CLI only. No startup/API entry point or Operations writes. */
export async function seedProviderLoginFixtures(options: { confirmDevelopment: boolean }, connection?: ProviderFixtureConnection) {
  assertManualSeedSafety(options.confirmDevelopment);
  return (connection ?? getDatabase()).transaction(async tx => {
    await lockProviderFixtures(tx);
    const owners = await tx.select().from(s.opsUsers).where(eq(s.opsUsers.id, providerFixtureOwner.id)).for("share");
    assertProviderOwnerIdentity(owners); // Existing inactive FK parent only; never create an Operations account.
    const hash = await hashPassword(manualTestPassword), time = new Date();
    let inserted = 0, reused = 0;
    for (const fixture of providerLoginFixtures) {
      const rows = await tx.select().from(s.providers).where(or(eq(s.providers.id, fixture.id),
        eq(s.providers.phone, fixture.phone))).for("update");
      if (fixture.key === "active") {
        assertProviderFixtureIdentity(rows, providerFixtures[0]);
        if (rows[0].status !== "active") throw new Error("Existing Active matching fixture changed; setup refuses to change its status");
        await tx.update(s.providers).set({ phone: fixture.phone, passwordHash: hash }).where(eq(s.providers.id, fixture.id));
        reused++;
      } else {
        if (rows.length && (rows.length !== 1 || rows[0].id !== fixture.id || rows[0].phone !== fixture.phone ||
          rows[0].businessName !== fixture.businessName || rows[0].createdBy !== providerFixtureOwner.id ||
          rows[0].serviceType !== "inspection")) throw new Error("Provider login fixture identity collision");
        if (rows.length) {
          await tx.update(s.providers).set({ status: fixture.status, passwordHash: hash }).where(eq(s.providers.id, fixture.id));
          reused++;
        } else {
          await tx.insert(s.providers).values({ id: fixture.id, businessName: fixture.businessName, phone: fixture.phone,
            whatsappNumber: fixture.key === "pending" ? "+12025550132" : "+12025550133", serviceType: "inspection",
            status: fixture.status, passwordHash: hash, ...manualLocality, createdBy: providerFixtureOwner.id, createdAt: time });
          inserted++;
        }
      }
    }
    const active = providerLoginFixtures[0];
    const [request] = await tx.select().from(s.serviceRequests).where(eq(s.serviceRequests.id, providerLoginRequestId)).for("share");
    if (request && (request.userType !== "guest" || request.guestPhone !== "+963900009901" ||
      request.guestName !== "تجريبي فقط — عميل إشعار المزود" || request.serviceType !== "inspection" ||
      request.inspectionGovernorateId !== manualLocality.governorateId || request.inspectionRegionId !== manualLocality.regionId))
      throw new Error("Notification fixture request identity collision");
    if (!request) await tx.insert(s.serviceRequests).values({ id: providerLoginRequestId, userType: "guest",
      guestName: "تجريبي فقط — عميل إشعار المزود", guestPhone: "+963900009901", serviceType: "inspection",
      inspectionGovernorateId: manualLocality.governorateId, inspectionRegionId: manualLocality.regionId,
      matchingStatus: "matched", createdAt: time });
    const [notice] = await tx.select().from(s.notifications).where(eq(s.notifications.id, providerLoginNoticeId)).for("share");
    if (notice && (notice.providerId !== active.id || notice.serviceRequestId !== providerLoginRequestId ||
      notice.userType !== "guest" || notice.serviceType !== "inspection" ||
      notice.guestPhone !== "+963900009901" || notice.guestName !== "تجريبي فقط — عميل إشعار المزود"))
      throw new Error("Notification fixture identity collision");
    if (!notice) await tx.insert(s.notifications).values({ id: providerLoginNoticeId, providerId: active.id,
      serviceRequestId: providerLoginRequestId, userType: "guest", serviceType: "inspection",
      guestName: "تجريبي فقط — عميل إشعار المزود", guestPhone: "+963900009901", createdAt: time });
    return { providers: { inserted, reused }, accounts: providerLoginFixtures.map(({ phone, status }) => ({ phone, status })),
      requestsInserted: request ? 0 : 1, notificationsInserted: notice ? 0 : 1, notificationId: providerLoginNoticeId,
      operationsChanged: false, matchingGraphsChanged: false };
  });
}