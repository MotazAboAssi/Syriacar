import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { getDatabase, closeDatabase } from "../../src/server/db/client.ts";
import * as s from "../../src/server/db/schema.ts";
import { securityRateLimits } from "../../src/server/db/security-rate-limits.ts";
import { accountHandlers } from "../../src/modules/account/http.ts";
import { AccountLimits } from "../../src/modules/account/rate-limits.ts";
import { req, parsed, password, outcome } from "../fixtures/account.mjs";

after(closeDatabase);
test("real independent PG transactions: one verification succeeds; registration race never activates replacement", async () => {
  // Committed private tables are necessary for visibility between connections.
  // No public rows are written or copied, and no migration is executed.
  const db = getDatabase(), name = "registration_concurrency_" + randomUUID().replaceAll("-", "");
  const symbol = PgTable.Symbol.Schema, tables = [s.users, s.otpVerificationChallenges, securityRateLimits];
  const original = tables.map(table => table[symbol]);
  const publicDigest = async () => (await db.execute(sql`
    SELECT (SELECT md5(COALESCE(json_agg(r ORDER BY id)::text, '[]')) FROM public.users r) AS users,
      (SELECT md5(COALESCE(json_agg(r ORDER BY id)::text, '[]')) FROM public.otp_verification_challenges r) AS otp
  `)).rows[0];
  const before = await publicDigest();
  let created = false;
  try {
    await db.execute(sql.raw(`CREATE SCHEMA "${name}"`)); created = true;
    for (const table of ["users", "otp_verification_challenges", "security_rate_limits"])
      await db.execute(sql.raw(`CREATE TABLE "${name}"."${table}" (LIKE public."${table}" INCLUDING ALL)`));
    tables.forEach(table => { table[symbol] = name; });
    const sent = new Map(); let code = 700000;
    const runtime = { secret: "concurrency-fixture-only", code: () => String(++code),
      sender: async (phone, value) => { sent.set(phone, value); return outcome(); } };
    const a = accountHandlers(() => db, runtime, new AccountLimits());
    const b = accountHandlers(() => db, runtime, new AccountLimits());
    const register = async (api, phone, userName, chosen = password) =>
      parsed(await api.register(req("register", "POST", { phone, name: userName, password: chosen })));
    const verify = (api, phone, r, value = sent.get(phone)) => api.verify(req("otp", "POST",
      { phone, code: value, attemptId: r.data.attemptId }, r.cookie));
    const p = "+963" + String(100000000 + Math.floor(Math.random() * 800000000));
    const registered = await register(a, p, "Concurrent A");
    assert.equal(registered.status, 201);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => verify(i % 2 ? a : b, p, registered)));
    assert.equal(results.filter(response => response.status === 200).length, 1);
    assert.equal(results.filter(response => response.status === 422).length, 7);
    assert.equal((await db.select().from(s.users).where(eq(s.users.phone, p)))[0].isActive, true);
    for (let i = 1; i <= 3; i++) {
      const phone = "+963" + String(Number(p.slice(4)) + i);
      const first = await register(a, phone, "Race A"), codeA = sent.get(phone);
      const [activation, replacement] = await Promise.all([
        verify(a, phone, first, codeA), register(b, phone, "Race B", "replacement-password"),
      ]);
      const user = (await db.select().from(s.users).where(eq(s.users.phone, phone)))[0];
      if (activation.status === 200) {
        assert.equal(replacement.status, 409); assert.equal(user.name, "Race A");
      } else {
        assert.equal(activation.status, 422); assert.equal(replacement.status, 201);
        assert.equal(user.isActive, false); assert.equal(user.name, "Race B");
        assert.equal((await verify(b, phone, replacement)).status, 200);
      }
    }
  } finally {
    tables.forEach((table, i) => { table[symbol] = original[i]; });
    if (created) await db.execute(sql.raw(`DROP SCHEMA "${name}" CASCADE`));
  }
  assert.deepEqual(await publicDigest(), before, "Public users and OTP records must remain unchanged");
});