# Production handoff — not deployed

No cloud resource, paid service, domain or store project is provisioned by this
change. Select a hosting environment and data region before deployment.

1. Provision PostgreSQL 17 with encrypted storage and backups. Create distinct
   migration-owner and restricted runtime roles. Test restore into a separate DB.
2. Configure NODE_ENV=production, DATABASE_URL, WEB_ORIGIN=https://your-domain,
   OPENAI_API_KEY, OPENAI_MODEL, ADMIN_USER_IDS and TRUSTED_PROXY_CIDRS in the
   platform's server environment/secret store. TRUSTED_PROXY_CIDRS is an explicit
   comma-separated list of trusted Web proxy IPs/CIDRs (not hostnames or hop counts).
   Prefer exact /32 IPv4 or /128 IPv6 addresses; never trust client address ranges.
   Missing proxy configuration, HTTP or PGlite makes production startup fail closed.
3. Install from pnpm-lock.yaml, run pnpm check and pnpm test:e2e in CI.
4. Apply migrations once with pnpm db:migrate. Do not run API replicas against
   PGlite. Run the API on the internal network only. Allow API connections only
   from the Web service and designated native-client ingress.
5. Build Web with API_INTERNAL_URL pointing to the internal API address. Next
   rewrites are resolved at build time. Serve Web behind HTTPS; disable SSE proxy
   buffering and allow at least 60 seconds for a response.
6. Run pnpm start for colocated Web/API, or pnpm --filter @citygo/api start and
   pnpm --filter @citygo/web start for separate services. Both root start and the
   built API entry point force NODE_ENV=production even if the inherited environment
   says development/test. The direct node apps/api/dist/server.js path does too.
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

AI consent rollout: apply `0003_ai_access.sql`, update Web/Expo and drain old API
instances before serving the new version. Existing users must explicitly confirm
the recipient; the questionnaire checkbox does not authorize chat. Configure
`LLM_USER_DAILY_REQUEST_LIMIT` and `LLM_GLOBAL_DAILY_REQUEST_LIMIT` consistently
on every replica (defaults 20/200 per UTC day; zero blocks new chat). These shared
admission caps are not financial budgets or a replacement for provider-side caps.
Do not revert to pre-consent application code with chat enabled. The technical
disclosure is not an approved legal notice; RouterAI/GigaChat production remain
blocked. See [AI provider rollout](ai-providers.md) for admission/revocation
semantics and the remaining stage 4B launch requirements.

AI control rollout additionally requires `0004_ai_routing.sql` and replacing all
pre-4B1 API instances. The saved admin choice is shared in PostgreSQL and survives
restarts; `LLM_PROVIDER` only bootstraps a new database (its required config remains
validated on every start). `LLM_PROVIDER=disabled` always overrides the saved
choice on that replica and cannot be bypassed by the admin. Use consistent settings
on every replica. `/admin` requires `ADMIN_USER_IDS`; no admin accounts are created
or granted by this rollout. Changing selection does not test real credentials.
Never roll back to pre-4B1 API code with chat enabled: it ignores the saved disable
and selection. Prefer a forward fix or a server-level stop on all replicas.

Attempt-control rollout additionally requires `0005_ai_attempts.sql` and replacing
all older API instances: old code does not reserve model attempts. Drain them and
apply the migration before starting this version. The journal starts at rollout with no reconstructed historical counts, so
check provider-side spending before choosing a launch window. Keep
`LLM_USER_DAILY_ATTEMPT_LIMIT` / `LLM_GLOBAL_DAILY_ATTEMPT_LIMIT` identical on all
replicas (defaults 20/200). The first reserve pins the two limits for that UTC day;
schedule changes to positive limits for the next day. Zero remains a hard stop
for new attempts, not cancellation of an already reserved call. Do not clear
counters to change a limit. The admin journal is capacity accounting, not billing;
approved financial envelopes and provider-side caps remain required. Never roll
back to pre-attempt-control code with AI enabled; use a forward fix or the server
hard-disable setting. See the model-attempt section of the AI runbook.

Monetary-control rollout requires `0006_ai_budget.sql` and replacing **all** older
API instances after draining them. `/ready` now checks `0006`. New model attempts,
including direct OpenAI, are blocked by default until an existing allowlisted admin
explicitly approves/enables currency, total/daily budget and verified per-attempt
ceilings. Migration grants no admin rights and does not authorize live spending.
There is no automatic tariff lookup, conversion, refund or billed-cost reconciliation.
Never serve mixed old/new versions or roll back to older code with AI enabled:
older versions ignore this guard. Use a forward fix or hard-disable all replicas.
Do not reset accounting data; historical attempts remain unpriced, not zero-cost.
See [monetary budget rollout](ai-providers.md#monetary-reservation-budget-stage-4b2b).

## Forwarded client address: required ingress contract

Next.js preserves an existing X-Forwarded-For header. An allowlist at the API alone
is therefore insufficient if clients can bypass the ingress or inject that header.
The internet-facing trusted ingress MUST replace client-supplied forwarding headers,
and the Web service must accept traffic only from that ingress. For a single Nginx
HTTPS ingress, the proxy location includes:

```nginx
location / {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 75s;
    proxy_pass http://citygo_web;
}
```

This is a location snippet, not a complete deployment config (TLS certificates,
upstream and firewall rules still need deployment-specific configuration). Do not
use an unvalidated incoming X-Forwarded-For as the client identity. With a managed
load balancer/CDN, use its verified client-address mechanism and validate every hop.
The API walks the allowlisted proxy chain from the socket peer and stops at the
first untrusted address. Direct untrusted callers cannot rotate forwarding headers
to escape the limiter. Rate limits remain per API process and per client IP; users
sharing a NAT may still share a quota. Multiple replicas need a shared store and
account-aware limits as described in the security checklist.

Before public launch, verify the actual ingress: exhaust one client's limit and
confirm a second client's access, then repeat while spoofing X-Forwarded-For. Unit
tests cover API trust handling, not the firewall/headers of an unprovisioned host.
