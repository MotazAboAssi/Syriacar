# Syriacar — application and database foundation

Single Next.js application, TypeScript, PostgreSQL via `pg`, and Drizzle ORM.
The imported GitHub repository and frozen documents in `attached_assets/` remain
the source-control and product baseline. The first guest inspection confirmation
slice is implemented; other application workflows remain deferred.

## Local development / Replit

- Node.js 24, npm 11 (npm lockfile is committed).
- Fresh checkout: `npm ci`.
- Replit supplies the existing managed `DATABASE_URL`. For another development
  environment, set it securely or copy `.env.example` to ignored `.env.local`.
  Never commit actual credentials or use `NEXT_PUBLIC_` for database settings.
- `npm run dev` binds `0.0.0.0:5000`.
- `npm run typecheck`; `npm run build`.
- `npm run start` serves the production build on port 5000.
- `npm test` runs static contracts, rollback-isolated real-PostgreSQL guest
  inspection tests, and HTTP smoke tests against the running app, using the Replit
  development domain when available, otherwise `http://127.0.0.1:5000`. It requires
  the development database/reference rows and uses the `react-server` condition.
- `npm run test:browser` runs the Build 4 Chromium interaction regressions.
  It requires the running app, development database, and Chromium installed on
  `PATH` (Replit's supplied Chromium is detected automatically). `playwright-core`
  is a development-only dependency; no browser download or runtime dependency is
  added to the application.

## Boundaries

```text
src/app/             Next.js layouts, page, manifest, API transport
src/shared/ui/       Shared presentation components
src/server/config/   Server database configuration
src/server/db/       Lazy pooled PostgreSQL + Drizzle schema, explicit seed, verification
src/server/health/   Read-only infrastructure health probe
src/modules/         Authorized vertical slices (guest-inspection only)
```

Database clients are server-only. A bounded pool is reused across hot reloads.
Connection/query timeouts are five seconds. TLS follows the connection URL's
provider settings; certificate verification must not be disabled.

## Health contract

`GET /api/health` performs `SELECT 1` through the application's Drizzle connection.
HTTP 200: `{"status":"ok","application":"ok","database":"connected"}`.
HTTP 503: status `degraded`, application `ok`, database `unconfigured` or
`unavailable`. Responses are uncached and expose no credentials or error details.
The HTML shell can load without DB credentials, but the health endpoint fails
explicitly rather than silently reporting success.

## Database foundation (DBMS v2.2)

`drizzle.config.ts` uses the same validated `DATABASE_URL` and Next's environment
loader for `.env.local`. The 24 approved business tables are exported from
`src/server/db/schema.ts`, with focused definitions in `src/server/db/schema/`.
`drizzle/` contains the generated, DDL-only migration and its snapshot/journal.

- `npm run db:generate` generates migration files from Drizzle (does not apply).
- `npm run db:migrate` explicitly applies pending migrations to the configured
  **development** database. It is not a startup or publish hook.
- `npm run db:verify` compares PostgreSQL's live catalogs against Drizzle:
  tables, columns, types, nullability, defaults, PKs, FKs, unique constraints,
  checks, enums, index definitions, and FK index coverage. It then exercises
  accepted/rejected rows in a transaction that is completely rolled back.
  Behavioral verification permits existing reference rows, requires empty
  non-reference tables, and refuses to operate on existing business data.
  All test records are uncommitted and
  must leave the application tables unchanged.
- The Node 24 verification CLI uses the same application client/pool, with
  the `react-server` condition for the existing `server-only` boundary.
  It releases that pool after completion. No second application client exists.

Types/defaults follow the frozen specification: UUIDs and timestamps do not
acquire unspecified defaults, JSON remains JSON, coordinates remain unbounded
DECIMAL/numeric, and TIMESTAMP remains PostgreSQL timestamp without time zone.
Drizzle encodes those timestamp values as UTC, and application pool sessions
explicitly use UTC. `work_days` has the explicit schedule default from §5.

Database checks cover user anonymization/inactive deletion, OTP bounded send
count/array length, closure-date consistency, inspection/towing locality and
registered-inspection vehicle presence, vehicle year range, and the provider
edit-field allowlist. Phone uniqueness permits multiple anonymized NULLs.
No cascading deletion, plaintext OTP columns, scalar schedule fields,
notification matching status, sessions, or extra business tables are added.
The `drizzle.__drizzle_migrations` table is infrastructure metadata, not an
additional application entity.

### Explicit application-only rules (not implemented in this build)

DBMS v2.2 assigns governorate/region membership, brand/group membership,
E.164 normalization/validation, user-type identity consistency, capability
restrictions for towing, schedule JSON validation, OTP hash generation and
metadata sanitization, and active-challenge uniqueness to the application.
Active OTP uniqueness requires transactional phone/purpose locking, not an
invalid time-dependent partial unique index. Provider/request locality FKs
validate existence; they deliberately do not invent composite FKs or triggers
for the application-only membership checks.

Request-level matching rollup, retry handling, anonymization transactions,
and cleanup/reset jobs also remain outside this database-only build. A valid
hash-only database column does not itself generate or sanitize an OTP.

### Approved initial reference seed

Build 3's owner-approved list in
`attached_assets/Pasted-Build-3-Implement-the-approved-initial-reference-data-s_1791064142979.txt`
supersedes older/example reference values. The initial manifest lives only under
`src/server/db/seed/`; it is not exported by the schema or imported by application
features. Those features must read the Operations-managed database tables.

- `npm run db:seed` manually seeds the configured **development** database:
  14 governorates, 76 regions, 9 brand groups, 49 brands, 5 fuel types, and
  5 tow types. It checks the existing schema first, then inserts all six
  categories in one transaction. It is disabled when `NODE_ENV=production`.
  It is never run automatically during startup, migration, build, or publishing.
- UUIDv5 identities use frozen seed-only keys and scoped initial positions,
  never mutable display names. Do not rewrite these keys, reorder the manifest,
  or regenerate the namespace after applying it. Repeat runs insert no
  duplicates. Only stable-PK conflicts are skipped; a different unique-key
  conflict fails and rolls back the entire seed.
- Existing IDs are **never updated** by the seed: renamed, deactivated,
  reordered, reparented, and code-edited rows are preserved. Additional managed
  rows are also preserved. A manual rerun can reinsert missing initial IDs;
  it is an initial-data tool, not a synchronization/repair job.
- All initial records are active. Labels are stored verbatim, including
  diacritics, parentheses, slashes, and the two separate `قدسيا` region rows.
- Approved group labels, in order: كوري، ياباني، صيني، إيراني، ألماني، فرنسي،
  إيطالي، سويدي / بريطاني، أمريكي.
- Ordering is 1-based for groups, fuel types, and tow types; brand ordering is
  1-based **within each group**. The owner explicitly approved keeping the schema
  unchanged: governorates and regions have no persisted custom display order.
  Their seed input order is not a database/query ordering guarantee. O-04
  governorate/region reordering therefore requires a separately approved future
  DBMS change; no sort-by-UUID workaround or invented column is used.
- Fuel codes: `petrol`, `diesel`, `cng`, `hybrid`, `electric`. Tow codes:
  `hydraulic`, `ordinary`, `winch`, `closed`, `two_wheel`. Existing applicable
  DBMS codes are retained; new machine keys are not additional display values.
- `npm run db:verify-seed` is an **initial-state acceptance check**, not a
  restriction on future Operations records. It verifies exact IDs/counts/labels,
  supported ordering and parent relationships, empty non-reference tables, and
  the unchanged live schema. Rolled-back transactions prove that seed reruns
  preserve managed edits/additions and that a uniqueness conflict rolls back
  earlier inserts. All verification changes are rolled back.
- `npm test` independently compares the manifest with the owner's supplied
  lists, in addition to the existing schema and application smoke tests.

Reference editing stays within the existing SRS/UI/UX permissions: Operations
manages groups/brands and the four reference lists. This build adds no Operations
UI, authentication, permission enforcement, runtime hard-coded options, immutable
triggers, or extra entities.

### Other bootstrap remains deferred

No Super Admin, message templates, `contact_phone`, credentials, or business rows
are seeded. Reference seeding does not require an admin/bootstrap mechanism, so
none is introduced. A future, separately approved admin bootstrap must receive
explicit identity and credentials from runtime/environment secrets, fail safely
when they are absent, use **Argon2id**, and never print or store plaintext
passwords. Neither `superadmin` nor `sysadmin` is chosen.

The public support/team phone is still unapproved. The separately supplied OTP
gateway number must **never** be substituted into `system_config.contact_phone`.
The five message templates also remain deferred because their required
`updated_by` FK needs the actual Super Admin account.

## Guest inspection vertical slice

- UI route: `/inspection/guest`; linked from the existing RTL home shell.
- `GET /api/guest-inspection/localities`: active governorates and optionally
  dependent active regions (`governorateId` query parameter).
- `GET /api/guest-inspection/providers`: required `governorateId` and `regionId`.
  Checks their active parent relationship and returns only active/open inspection
  providers in that exact locality. Capabilities are informational for guests.
  Open status uses only `work_days`, inclusive same-day intervals in
  `Asia/Damascus`, and today's closure override (SRS §5.9.3).
- `POST /api/guest-inspection/requests`: JSON `governorateId`, `regionId`,
  `providerId` (explicit `null` for no provider), `guestName`, `guestPhone`
  (E.164), and `acceptedTerms: true`. Only explicit confirmation calls this.
  The server revalidates locality and current provider availability inside the
  transaction, holds share locks on existing locality/provider rows, generates
  explicit UUIDs/timestamps, and atomically inserts the request and notification.
- A selected eligible provider creates one `service_requests` row with
  `matching_status=matched` and one `notifications` row linked to it. No available
  provider creates one `no_match` request and zero notifications. Client-forced
  no-match, changed availability, and invalid selections are rejected; 409 means
  refresh choices and reconfirm. Match history is not subsequently reclassified.
- This is first confirmation only, not an additional-provider/history workflow.
  The unchanged non-unique notification parent FK still supports one-to-many;
  a real-PG test verifies two notices can share one parent.
- No authentication/OTP, vehicle requirements for guests, GPS, map/distance
  criteria, real provider seeds, WhatsApp deep links/delivery, Web Push, or
  Operations/provider screens are added. `delivery: "not_implemented"` is explicit
  in successful API responses; a notification row does not mean a message sent.
- The owner approved the no-match message without the contact suffix while
  `system_config.contact_phone` is absent. When configured, the phone is read
  from that row, never a source constant or the OTP gateway number.
- Successful results return only the request/notification IDs, status, public
  provider identity/contact, support phone if configured, and delivery limitation.
  API responses are uncached; errors withhold raw DB details. JSON bodies have an
  8 KiB transport bound. No guest identity, hashes, or credentials are logged.
- Client reads are cancelable, changed locality invalidates previous choices,
  confirmation is disabled while writing, and a synchronous guard prevents
  duplicate clicks. No automatic POST retries: unknown network outcomes are
  shown as unknown, not fake success. Render, refresh, and cancellation do not
  create records.
- Test fixtures—including reference/actor/provider rows and requests—exist only
  in outer transactions that always roll back, even on assertion failure. The
  seeded reference rows and original application counts are checked unchanged.
  The foundation `db:verify` command remains an empty-non-reference acceptance
  check; run it before real use of the request flow, not against business data.

### Browser regression coverage — Build 4 hardening

`tests/browser/guest-inspection.test.mjs` contains nine focused browser cases:
dependent region replacement; selected-region parent preservation; provider and
no-provider transitions; matched confirmation including consent/cancel/payload;
stale provider rejection; forged cross-governorate region rejection; deactivated
locality rejection; mobile no-match success without an absent support phone; and
discarding delayed old-locality results.

The browser loads the actual Next.js page. Browser-only request interception
binds the same server-only inspection HTTP handlers to the uncommitted fixture
transaction. These are real PostgreSQL results, not canned response data.
All API requests are intercepted fail-closed: no request can fall back to live
application writes. No production route, testing bypass, schema, or product
behavior is changed. The shared fixture is in
`tests/fixtures/guest-inspection.mjs`; fixture API work is serialized for the
transaction-pinned pg client. Before/after checks preserve all 24 table counts,
all six reference-table contents, and the original support configuration.

Complete verification:

```sh
npm test
npm run test:browser
npm run db:verify
npm run db:verify-seed
npm run typecheck
npm run build
```

As above, the foundation database assertions require empty non-reference tables.
Do not remove genuine business data to satisfy that acceptance check.

## PWA scope

The shell has Arabic RTL, responsive layout, viewport/safe-area support, and a
web manifest with an SVG icon. This is PWA groundwork, not a complete offline
or installability implementation. No service worker, push, caching strategy,
maps, authentication, integrations, or other business screens are included.