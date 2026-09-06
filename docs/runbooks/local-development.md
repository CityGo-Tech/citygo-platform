# Local development

Use Node 24 LTS and pnpm 10.15.0 (pinned in packageManager).

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

No .env or Docker is required for the initial screen. The root launcher builds shared
packages, applies migrations and starts Web :3000 / API :4000 with an embedded
PostgreSQL engine (PGlite). Persistent data lives in ignored .local/database.
Use only one API process with this local store; the separate worker requires a server PostgreSQL connection.

The root .env is optional. Copy .env.example, then configure OPENAI_API_KEY and
OPENAI_MODEL server-side for real chat. Without them, the API returns an explicit
503; there is no production mock provider. Do not paste keys into issues, PRs or chat.

For PostgreSQL server:

1. Start docker compose -f docker-compose.dev.yml up -d.
2. Set DATABASE_URL=postgresql://citygo:citygo@localhost:5432/citygo in the root .env.
3. Run pnpm db:migrate and pnpm dev.
   This does not automatically transfer data from the embedded local database.

Checks: pnpm check, pnpm browser:install, pnpm test:e2e.
Browser tests own ports 3000/4000: stop an existing dev session first. The test
server is a separate non-production entry point using a deterministic provider.
For server-PostgreSQL integration tests, set TEST_DATABASE_URL to a dedicated
test database. Every fixture creates and drops its own randomly named test schema.

Build: pnpm build. Serve built Web/API: pnpm start after pnpm db:migrate.
Shared packages are prebuilt before the Web/API development watchers start. After
editing a shared package, restart pnpm dev to rebuild it, or run that package's
dev script in a separate terminal. The launcher deliberately starts only the two
application watchers to keep memory use bounded on development laptops.
Web typecheck runs next typegen before tsc, including from a fresh checkout.
