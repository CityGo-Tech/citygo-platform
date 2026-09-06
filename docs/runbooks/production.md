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
