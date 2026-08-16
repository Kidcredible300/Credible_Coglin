# Coglin

Season operations for _FIRST_® Tech Challenge teams — boards, award-evidence
tracking, outreach logging, and portfolio planning mapped to the actual
Competition Manual criteria.

Coglin is **unofficial by design**. It is not affiliated with, endorsed by, or
licensed by _FIRST_®. No _FIRST_/FTC logos are used anywhere, and team
verification is manual (the FTC Events API's terms bar commercial use).

Product plan: `~/lilithforge/coglin-plan.md` · Backlog: `~/lilithforge/coglin-tracker.xlsx`

## Stack

Cloudflare Workers with static assets — one Worker serves the compiled React
bundle and the `/api/*` routes. "Static assets" means the build output only;
all app data is fetched at runtime from D1 and R2.

| Layer    | Choice                                  |
| -------- | --------------------------------------- |
| Runtime  | Cloudflare Workers (`@cloudflare/vite-plugin`) |
| API      | Hono                                    |
| Frontend | React 19 + Vite + Tailwind v4 + React Router |
| Data     | D1 (SQLite), multi-tenant, keyed by `team_id` |
| Files    | R2 (`MEDIA` binding) — photos, CAD renders |
| Realtime | Polling for v1; Durable Object `TeamRoom` in Phase 4 |

Node **22** is required (wrangler's asset handler needs ≥22). Use `nvm use`.

## Environments

| Resource | Staging                              | Production                   |
| -------- | ------------------------------------ | ---------------------------- |
| Worker   | `coglin-app-staging`                 | `coglin-app`                 |
| Domain   | `coglin-staging.lilithforge.com`     | `coglin.lilithforge.com`     |
| D1       | `coglin-staging`                     | `coglin-prod`                |
| R2       | `coglin-media-staging`               | `coglin-media-prod`          |

The top-level `wrangler.jsonc` target is named `coglin-app-dev` on purpose, so
an accidental bare `wrangler deploy` creates a throwaway worker instead of
overwriting production.

Staging is `coglin-staging.lilithforge.com`, **not**
`staging.coglin.lilithforge.com`. Cloudflare Universal SSL covers
`*.lilithforge.com` but not two-level names; the nested form resolves in DNS and
then fails the TLS handshake unless you pay for Advanced Certificate Manager.

**Environments are selected at build time, not deploy time.** The Cloudflare
Vite plugin emits a "redirected deploy config" flattened to the active
environment, and `wrangler deploy` reads that instead of `wrangler.jsonc`. So
`CLOUDFLARE_ENV` must be set for the *build*; a bare `wrangler deploy --env foo`
silently deploys the top-level worker. The npm scripts below handle this.

## Local development

```bash
nvm use
npm install
cp .dev.vars.example .dev.vars   # then fill SESSION_PEPPER
npm run db:migrate:local
npm run dev                      # http://localhost:5174
```

Port 5174, not Vite's default 5173, which the Inkubus dev server uses on the
same machine.

## Deploying

Push to `main` deploys **staging** automatically. Production is a manual
`workflow_dispatch` gated behind a GitHub environment protection rule —
production holds a real team's season data and is never updated as a side
effect of a push.

```bash
npm run deploy:staging      # or let CI do it
npm run deploy:production   # prefer the gated workflow
```

## Migrations

Real `wrangler d1 migrations`, with its `d1_migrations` ledger — not replayed
`CREATE TABLE IF NOT EXISTS` files.

```bash
npm run db:migrate:local
npm run db:migrate:staging
npm run db:migrate:production
```

Those scripts pass `--env` even though they already name the database, because
wrangler resolves that name against **the config file, not your account**. Each
database is only declared inside its own `env` block, so a bare
`wrangler d1 migrations apply coglin-prod --remote` fails with *"couldn't find a
D1 DB with the name or binding 'coglin-prod' in your wrangler.jsonc file"* —
which looks like a credentials problem and is not one. Staging appears to work
without `--env` only because the top-level block points at `coglin-staging` for
local dev.

## Tenancy rule

Every application table carries `team_id`, and `team_id` is **never** read from
a request body — it is resolved from the authenticated session's membership row
in `worker/lib/tenancy.ts`. Every tenant-scoped query must hit an index on
`team_id`: D1 bills per row *read*, so an unindexed scan costs money as well as
leaking. A cross-team read is the one bug this codebase cannot ship.

## Data protection

Users are 12–18. Students are **coach-provisioned**: no self-signup, no email,
login is `team_number + handle + password`. Student PII is limited to a display
name and a handle. See the plan's §6 before touching auth.
