# CityGo Platform

Private monorepo for the CityGo relocation platform.

## Workspace

- `apps/web` — Next.js customer experience.
- `apps/api` — Fastify HTTP API.
- `packages/contracts` — shared schemas, types, and product constants.
- `docs` — architecture and engineering decisions.

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
`http://localhost:4000`. Check the API with `GET /health`.

## Quality checks

```bash
pnpm check
```

Copy `.env.example` to `.env` when local configuration is needed. Never commit
secrets or customer relocation data.
