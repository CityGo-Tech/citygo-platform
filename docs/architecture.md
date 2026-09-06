# Runtime architecture

Web and Expo consume @citygo/api-client and @citygo/contracts. Only the Fastify API
accesses user data and OpenAI. Admin is an executable workspace React package
mounted by Web at /admin; the API enforces its allowlist.

The API-owned Repository executes parameterized SQL through either a pg Pool
(server PostgreSQL) or PGlite (single-process local development). Migrations are
append-only, checksum-checked, serialized and transactional. Domain quest state
rules are shared; rewards are never decided by the model or a client.

Questionnaire creates one versioned plan and two user quests. Starting a quest
opens the user's conversation. Chat reserves a lease and stores the user message
before streaming. A short final transaction stores the assistant result. The
router can switch specialization without losing conversation history.

Completion requires an in-progress quest, explicit user confirmation, and a
complete Housing Navigator reply since that quest started. The quest update,
exactly-once XP event, next-quest unlock and analytics event commit together.

The model receives a bounded recent history and consented profile fields. It has
no external search, mutation or third-party messaging tools. Role instructions
cover housing, job search, resume, digital adaptation and support. Handoff is
rules-based routing plus a persisted audit record, not a multi-model swarm.

Worker is a separate one-shot server-PostgreSQL maintenance process. Readiness
checks applied migrations. Logs use request IDs and redact credentials. Production
deployment and external monitoring targets are intentionally not provisioned.
