# Service environments (CG-006)

Use the checked-in launch commands. They construct an explicit allowlist for
each child process instead of inheriting the entire shell/root `.env`. Existing
keys and local databases are not moved or rewritten by this change.

| Process              | Application variables                                                                                                                          | Optional root file                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| API                  | `DATABASE_URL`, API host/port, Web origin/proxy/admin settings, the explicitly listed `LLM_*`, `OPENAI_*`, `ROUTERAI_*`, `GIGACHAT_*` settings | `.env.api`, legacy `.env` fallback |
| Web                  | `API_INTERNAL_URL`, `PORT`, `NEXT_TELEMETRY_DISABLED`, `NODE_ENV`                                                                              | `.env.web`                         |
| Mobile               | `EXPO_PUBLIC_API_URL`, named Expo/Android development-tool settings                                                                            | `.env.mobile`                      |
| Worker               | `DATABASE_URL`, `NODE_ENV` (no HTTP/AI configuration)                                                                                          | `.env.worker`                      |
| Migrator             | `DATABASE_URL`, `NODE_ENV`                                                                                                                     | `.env.migrator`                    |
| Build/lint/typecheck | Non-secret `API_INTERNAL_URL` only                                                                                                             | `.env.web` routing value only      |
| Tests                | Explicit `TEST_DATABASE_URL`; test mode is forced                                                                                              | **None**                           |

The source of truth for exact names is `scripts/env.mjs`. The prefixes in the
table are shorthand, **not wildcard allowances**. A new server setting must be
added deliberately; a regression test compares the API schema with its allowlist.
Unknown keys in scoped files fail without printing names/values. Legacy `.env`
may contain unrelated entries; only the known API/DB values are selected.

OS essentials (PATH, home/temp locations, Windows system directories, locale,
terminal/CI flags and pnpm executable paths) are separately allowlisted. Arbitrary
cloud credentials, npm config, proxy credentials, `NODE_OPTIONS`, global TLS
verification overrides and arbitrary public-prefixed variables are not forwarded.
GigaChat retains its provider-specific verified CA bundle setting.

## Files and precedence

Copy `.env.example` to **root `.env.api`** for new API setups. A pre-existing root
`.env` still works. Optional `.env.web.example`, `.env.mobile.example`,
`.env.worker.example`, `.env.migrator.example` document the other scopes. All real
`.env*` files remain ignored by Git; only example files may be committed.

For API: injected environment > `.env.api` > legacy `.env` > development defaults.
For worker/migrator: injected environment > own scoped file > `.env.api` DB URL

> legacy `.env` DB URL. Worker has **no PGlite default** and requires server
> PostgreSQL. Migrator/API local PGlite paths resolve relative to the repository
> root, independent of the caller's current directory. `pglite://:memory:` remains
> in memory. Do not copy the migrator example over an existing PostgreSQL setup.

Web/mobile never load root `.env` or `.env.api`. Injected variables override their
own file. Blank injected values are still intentional overrides, not fallback.
Nothing expands `$OTHER_VARIABLE` inside files; values are parsed without
modifying the launcher's `process.env`.

`pnpm dev` preserves the custom local API port when deriving the default Web
route. Set `API_INTERNAL_URL` in `.env.web` for a different route. A production
Web **build** requires this route explicitly when it differs from port 4000;
changing the runtime value alone cannot change baked Next rewrites. The route
and `.env.web` participate in the Web build/typecheck cache key. API keys and
legacy `.env` do not participate in Turbo's global cache inputs.

## Supported commands and boundaries

- `pnpm dev`: secret-free shared builds, DB-only migration, separate API/Web
  runtime children; does not send their combined settings through Turbo.
- `pnpm start`: separate API/Web runtime children, production mode forced.
- `pnpm db:migrate`: secret-free shared builds then DB-only migration.
- `pnpm worker:once`: DB-only maintenance child; does not need API proxy/AI config.
- `pnpm build`, `lint`, `typecheck`, `test`, `test:startup`, `test:e2e` use filtered
  environments. Only API integration-test tasks receive `TEST_DATABASE_URL`
  through Turbo, never `DATABASE_URL`. Test DB must be a dedicated test database.
- Web package `build/dev/start/typecheck`, API package `dev/start`, and mobile
  `dev/export` also have launch boundaries when called through `pnpm --filter`.

Next automatically loads app-local env files. The wrapper rejects standard
`apps/web/.env*` runtime files rather than deleting them or letting them restore
filtered secrets. Move only permitted Web settings to root `.env.web` yourself.
Expo automatic dotenv loading is disabled with `EXPO_NO_DOTENV=1`; use root
`.env.mobile` or the explicitly permitted injected public URL.

The E2E server uses in-memory data and the deterministic TestProvider; the Web
test launcher ignores runtime files and pins the loopback API route. Runtime
bootstrap provider/model/budget choices are not changed by test launches.

This is an accidental-inheritance boundary, **not a sandbox against malicious
code with filesystem access**. A raw `next`, `expo`, `node dist/server.js` or
package test command bypassing these launchers can inherit its caller's secrets.
Do not provision production secrets to CI/build/Web containers in the first
place. Deployment must provide separate secret stores/container permissions and
DB roles. The local fallback DB URL preserves compatibility, not least-privilege
database grants. No such infrastructure or roles are provisioned here.

## Verification

`pnpm test:env` covers allowlists, precedence, legacy fallback, root-relative
paths, refusal of framework env files, API-schema drift, Turbo config and real
child processes using synthetic credentials. No live AI requests are involved.
CI injects a fixed fake marker into private/public-prefixed variables, runs the
full existing suite, and checks Web/mobile artifacts for the marker after builds.
The scan is additional evidence, not proof against arbitrary malicious bundling.

References used for the implementation:
[Node parseEnv](https://nodejs.org/api/util.html#utilparseenvcontent),
[Turbo environment modes](https://turborepo.dev/docs/crafting-your-repository/using-environment-variables),
[Next env loading](https://nextjs.org/docs/app/guides/environment-variables#environment-variable-load-order),
[Expo dotenv opt-out](https://docs.expo.dev/guides/environment-variables/).
