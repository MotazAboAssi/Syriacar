import nextEnv from "@next/env";
import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { withInspectionFixture } from "./guest-inspection.mjs";
import { accountHandlers } from "../../src/modules/account/http.ts";
import { AccountLimits } from "../../src/modules/account/rate-limits.ts";
import { getDatabase } from "../../src/server/db/client.ts";
import * as s from "../../src/server/db/schema.ts";
import { codeHash } from "../../src/modules/account/security.ts";
import { registrationCookieName } from "../../src/modules/account/registration-flow.ts";

nextEnv.loadEnvConfig(process.cwd());
export const origin = "https://account-verification.example";
export const password = "verification-password";
export const outcome = (kind = "api_accepted", id = "mock-message") => ({
  api_outcome: kind, http_status: kind === "api_accepted" ? 200 : null,
  provider_sent: kind === "api_accepted" ? true : null,
  provider_message_id: kind === "api_accepted" ? id : null,
  provider_status: null, status_at: null, error_code: kind === "api_accepted" ? null : "test_failure",
  error_reason: null,
});
export function req(path, method = "GET", input, cookie, extras = {}) {
  return new Request(origin + "/api/account/" + path, {
    method, headers: { Origin: origin, ...(input === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}), "X-Forwarded-For": "192.0.2.1", ...extras },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
export async function parsed(response) {
  return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie()[0]?.split(";")[0], headers: response.headers };
}
/** Actual PG + actual handlers; all changes roll back. Codes exist only in the mock's RAM. */
export async function withAccountFixture(check) {
  await withInspectionFixture(async (fixture) => {
    const { tx } = fixture;
    let time = new Date(), nextPhone = randomInt(100000000, 900000000), counter = 100000;
    const sends = [], plans = [], sleeps = [];
    const limits = new AccountLimits();
    const runtime = {
      now: () => new Date(time), secret: "verification-only-not-an-environment-secret",
      callbackSecret: "verification-only-callback",
      code: () => String(++counter),
      sleep: async (ms) => { sleeps.push(ms); time = new Date(time.getTime() + ms); },
      sender: async (phone, code) => {
        sends.push({ phone, code });
        return plans.length ? plans.shift() : outcome("api_accepted", "mock-" + sends.length);
      },
    };
    const api = accountHandlers(() => tx, runtime, limits);
    const flows = new Map();
    for (const name of ["register", "resend", "login"]) {
      const handler = api[name];
      api[name] = async request => {
        const response = await handler(request), data = await response.clone().json();
        const state = data.otp ?? data;
        const cookie = response.headers.getSetCookie().find(value => value.startsWith(registrationCookieName + "="));
        if (cookie && state.attemptId) flows.set(state.phone, { attemptId: state.attemptId, cookie: cookie.split(";")[0] });
        return response;
      };
    }
    const f = {
      ...fixture, api, runtime, limits, sends, plans, sleeps,
      flows,
      flowReq: (path, method = "GET", input) => {
        const number = input?.phone ?? new URL(origin + "/" + path).searchParams.get("phone");
        const flow = flows.get(number);
        return req(method === "GET" ? path + "&attemptId=" + encodeURIComponent(flow?.attemptId ?? "") : path,
          method, input ? { ...input, attemptId: flow?.attemptId } : undefined, flow?.cookie);
      },
      phone: () => "+963" + nextPhone++, now: runtime.now,
      advance: (ms) => { time = new Date(time.getTime() + ms); },
      challenge: async (phone) => (await tx.select().from(s.otpVerificationChallenges)
        .where(eq(s.otpVerificationChallenges.phone, phone))).sort((a, b) => b.createdAt - a.createdAt)[0],
      user: async (phone) => (await tx.select().from(s.users).where(eq(s.users.phone, phone)))[0],
      register: async (phone, extra = {}) => {
        const result = await parsed(await api.register(req("register", "POST", { name: "مالك تحقق", phone, password, ...extra })));
        time = new Date(time.getTime() + 1); return result;
      },
      activate: async (phone) => parsed(await api.verify(f.flowReq("otp", "POST", { phone, code: sends.at(-1).code }))),
      vehicleInput: { brandGroupId: fixture.group.id, brandId: fixture.brand.id, year: 2005, fuelTypeId: fixture.fuel.id,
        vehicleCategory: "car", plateNumber: "TEST-ONLY", color: "لون تحقق", notes: "علامة تحقق" },
      replaceCode: async (phone, code) => {
        const row = await f.challenge(phone);
        await tx.update(s.otpVerificationChallenges).set({ codeHash: codeHash(code, row.id, runtime) })
          .where(eq(s.otpVerificationChallenges.id, row.id));
      },
    };
    await check(f);
  });
}
export async function accountSnapshot() {
  const db = getDatabase(), snapshot = {};
  for (const [name, table] of Object.entries({ users: s.users, otp: s.otpVerificationChallenges,
    vehicles: s.vehicles, requests: s.serviceRequests, notifications: s.notifications })) {
    snapshot[name] = (await db.select().from(table)).sort((a, b) => a.id.localeCompare(b.id));
  }
  return snapshot;
}