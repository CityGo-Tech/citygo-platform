# MVP security boundaries

- Scrypt password hashes with independent salts; opaque random seven-day sessions.
  Only SHA-256 session hashes are stored. Browser cookies are HttpOnly, SameSite=Lax,
  and Secure with the __Host- prefix in production.
- Native sessions use explicit bearer tokens stored in the OS secure store.
  Passwords and provider keys must never be stored on the device.
- Auth and chat are rate limited. Current limiter is per process/IP; a shared,
  account-aware limiter is required before horizontally scaled production.
  Only configured TRUSTED_PROXY_CIDRS may supply forwarded client addresses.
  The HTTPS ingress must replace client-supplied forwarding headers and prevent
  direct public access to Web/API origins; see the production ingress contract.
- Built API and root pnpm start force production mode. Insecure database/origin
  settings or missing proxy trust abort startup; local HTTP/PGlite uses pnpm dev.
- Every user-facing data query is scoped to the authenticated user. The DB is
  API-owned, never accessible from browser/mobile. Use a restricted runtime DB role
  distinct from the migration owner before production.
- State completion + ledger insert + next-quest unlock share a short transaction.
  Replays return zero newly awarded points. A unique index additionally guards the ledger.
- Chat reserves a bounded lease, then releases the SQL transaction before calling
  OpenAI. Network waits never hold a DB connection/row lock. Partial/interrupted
  replies are not evidence for completion. Server process crashes may lose the
  unsaved tail of an in-flight response.
- Questionnaire city/budget/date/household may go to OpenAI only after explicit
  consent. Email is excluded from model context. Responses API uses store:false;
  that is not a promise of zero provider-side retention.
- The orchestrator is deterministic topic routing, not autonomous tool execution.
  Specialists cannot mutate XP, contact third parties or invent housing listings.
- Human handoffs are stored for review, not dispatched to a real realtor.
- Logs redact credentials/cookies. Analytics contain event names/internal IDs,
  not message text or raw questionnaires.

Not launch-ready until: email verification and password reset, retention/deletion
workflow and consent withdrawal, privacy/terms approval, domain/TLS, backup/restore
drill, spending caps, provider evaluation, abuse tests, shared rate limiting and
operator workflow. Existing SQL migrations are append-only and checksum-checked.
