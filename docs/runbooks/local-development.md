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
OPENAI_MODEL server-side for real chat. With both absent, the API returns an explicit
503; partial configuration is a startup error. LLM_PROVIDER can be empty (legacy
OpenAI selection), openai (both settings required), or disabled (explicitly off).
RouterAI and GigaChat are available as explicit local synthetic-data pilots;
production activation is blocked pending recipient/consent rollout. GigaChat needs
its own authorization key, explicit model/account scope, and verified CA trust.
There is no production mock provider. Do not paste keys into issues, PRs or chat.
See [AI provider configuration](ai-providers.md) for limits and rollout boundaries.

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

Build: pnpm build. pnpm start is production-only and requires PostgreSQL, HTTPS
WEB_ORIGIN and explicit TRUSTED_PROXY_CIDRS after pnpm db:migrate. For local
HTTP/PGlite development continue to use pnpm dev; apps/api/src/dev.ts is not shipped
in the production build. Root pnpm dev explicitly selects development mode.
Proxy trust is disabled by default locally. Do not expose a development server to
real users; shared deployments require the sanitizing ingress and proxy allowlist
described in [production.md](production.md).
Shared packages are prebuilt before the Web/API development watchers start. After
editing a shared package, restart pnpm dev to rebuild it, or run that package's
dev script in a separate terminal. The launcher deliberately starts only the two
application watchers to keep memory use bounded on development laptops.
Web typecheck runs next typegen before tsc, including from a fresh checkout.
