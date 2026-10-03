# Syriacar — technical foundation

Single Next.js application, TypeScript, PostgreSQL via `pg`, and Drizzle ORM.
The imported GitHub repository and frozen documents in `attached_assets/` remain
the source-control and product baseline. No business features are implemented.

## Local development / Replit

- Node.js 24, npm 11 (npm lockfile is committed).
- Fresh checkout: `npm ci`.
- Replit supplies the existing managed `DATABASE_URL`. For another development
  environment, set it securely or copy `.env.example` to ignored `.env.local`.
  Never commit actual credentials or use `NEXT_PUBLIC_` for database settings.
- `npm run dev` binds `0.0.0.0:5000`.
- `npm run typecheck`; `npm run build`.
- `npm run start` serves the production build on port 5000.
- `npm test` runs HTTP smoke tests against the running app, using the Replit
  development domain when available, otherwise `http://127.0.0.1:5000`.

## Boundaries

```text
src/app/             Next.js layouts, page, manifest, API transport
src/shared/ui/       Shared presentation components
src/server/config/   Server database configuration
src/server/db/       Lazy pooled PostgreSQL + Drizzle; empty schema
src/server/health/   Read-only infrastructure health probe
src/modules/         Reserved for future authorized domain modules (no code yet)
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

## Drizzle / PWA scope

`drizzle.config.ts` uses the same validated `DATABASE_URL` and Next's environment
loader for `.env.local`. The schema is deliberately empty. No tables, migration
files, seeds, schema pushes, or startup DDL have been created/run.

The shell has Arabic RTL, responsive layout, viewport/safe-area support, and a
web manifest with an SVG icon. This is PWA groundwork, not a complete offline
or installability implementation. No service worker, push, caching strategy,
maps, authentication, integrations, or business screens are included.