# Local development runbook

1. Copy `.env.example` to `.env` and keep it untracked.
2. Start PostgreSQL with `docker compose -f docker-compose.dev.yml up -d`.
3. Install dependencies with `corepack pnpm install`.
4. Run `pnpm dev`.
5. Before a PR, run `pnpm check`.

If a secret is committed, revoke it immediately, notify maintainers, and then
clean repository history. Deleting the visible line is not sufficient.
