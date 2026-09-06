# Production handoff — not deployed

No cloud resource, paid service, domain or store project is provisioned by this
change. Select a hosting environment and data region before deployment.

1. Provision PostgreSQL 17 with encrypted storage and backups. Create distinct
   migration-owner and restricted runtime roles. Test restore into a separate DB.
2. Configure DATABASE_URL, WEB_ORIGIN=https://your-domain, OPENAI_API_KEY,
   OPENAI_MODEL and ADMIN_USER_IDS in the platform's secret store.
3. Install from pnpm-lock.yaml, run pnpm check and pnpm test:e2e in CI.
4. Apply migrations once with pnpm db:migrate. Do not run API replicas against
   PGlite. Run the API on the internal network only.
5. Build Web with API_INTERNAL_URL pointing to the internal API address. Next
   rewrites are resolved at build time. Serve Web behind HTTPS; disable SSE proxy
   buffering and allow at least 60 seconds for a response.
6. Run the built API (apps/api/dist/server.js) and Web (pnpm --filter @citygo/web start).
   Set API_HOST=0.0.0.0 only behind the deployment network boundary.
7. Monitor /health (process) and /ready (DB/migrations), 5xx/error rates, latency,
   interrupted model responses and OpenAI spending. No PII in metrics/logs.
8. Schedule the idempotent worker: pnpm worker:once. It is not a notification queue.
9. Set spending caps and run prompt-injection, tenancy, replay, timeout and load
   evaluations. Add a shared per-account rate limiter for multiple replicas.
10. Complete the security/privacy checklist before accepting real user data.

Rollback is a prior application build only when compatible with applied schema.
Never edit an applied migration to roll back. Add a forward repair migration.
Exact hosting commands and monitoring configuration depend on the chosen provider.
