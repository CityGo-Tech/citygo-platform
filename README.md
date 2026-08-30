# CityGo Platform

Private monorepo for the CityGo relocation platform: questionnaire, personal
plan, quest map, specialized assistants, and shared progress across web/mobile.

## Workspace

- `apps/web` — Next.js customer experience.
- `apps/mobile` — Expo / React Native application boundary.
- `apps/api` — Fastify HTTP API and use-case boundary.
- `apps/admin` — future content and quest administration surface.
- `apps/worker` — future background jobs and notifications.
- `packages/domain` — quest state machine and product rules.
- `packages/contracts` — shared schemas, types, and product constants.
- `packages/db` — PostgreSQL schema and migrations.
- `packages/agents` / `packages/llm` — agent roles and provider adapters.
- `packages/design-tokens` / `packages/ui-*` — cross-platform design system.
- `docs` — ADR, architecture, product, security, agents, and runbooks.

## Prerequisites

- Node.js 22+
- pnpm 10.15+

## Start locally

```bash
corepack enable
pnpm install
pnpm dev
```

The web app runs at `http://localhost:3000`; the API runs at
`http://localhost:4000`. PostgreSQL runs at `localhost:5432` when started with:

```bash
docker compose -f docker-compose.dev.yml up -d
```

Check the API with `GET /health`.

## Quality checks

```bash
pnpm check
```

Copy `.env.example` to `.env` when local configuration is needed. Never commit
secrets or customer relocation data.

## Delivery status

`apps/web`, `apps/api`, `packages/contracts`, `packages/domain`, and the initial
database migration are executable foundations. The other boundaries are
intentional scaffolds and must receive product code only when their milestone
starts. See `docs/product/mvp-scope.md`.
