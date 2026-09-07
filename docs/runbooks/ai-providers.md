# AI provider rollout — stage 4B2a of 5

This release adds shared model-attempt reservations, guards for internal retries
and a read-only admin journal, building on 4B1's persistent provider selector and
4A's recipient consent / accepted-chat caps.
All three independent adapters remain available. RouterAI and GigaChat production
activation stays blocked: the technical disclosure is not an operator-approved
privacy notice. Automatic failover is **not** enabled. Stage 4 remains split into
reviewable steps; the financial/privacy launch requirements are not completed by
these reservations. No live model is chosen or upgraded by this PR.

## Model-attempt reservations (stage 4B2a)

Apply `0005_ai_attempts.sql` before starting the updated API; `/ready` requires it.
The journal starts empty without guessing older requests' attempt counts. Drain
and replace all older API instances; otherwise their unmetered calls bypass this
control. Do not roll back to older code with AI enabled or delete accounting rows.

`LLM_USER_DAILY_ATTEMPT_LIMIT` and `LLM_GLOBAL_DAILY_ATTEMPT_LIMIT` default to
20 and 200 per UTC day (bounds 0–10000 and 0–1000000). They are independent of
accepted-chat quotas and shared across providers, users, restarts and replicas.
At most two attempts can be reserved per admitted chat, matching the current
OpenAI retry and GigaChat auth-recovery boundaries; RouterAI still sends once.
Changing a provider or model never resets these counters.

The API reserves the first model attempt before entering the adapter, including
before GigaChat OAuth. An OpenAI SDK retry or GigaChat chat resubmission must reserve
another slot **before** sending model data. OAuth refresh requests are not model
attempts and retain their existing bounded/single-flight behavior. A denied first
reserve never enters an adapter; a denied retry sends no second model request.
The retry guard also rejects any retry after visible output. RouterAI and GigaChat
retain their production blocks, and no cross-provider failover is enabled.

A reservation is deliberately conservative: it is **not proof of HTTP dispatch,
provider acceptance, success, or a billable charge**. OAuth failure, process crash,
timeout or cancellation may leave an unused reserve. There are no automatic
refunds because the provider may already have accepted a request. Completed,
interrupted and unknown outcomes cannot safely be treated as zero cost. The admin
displays the final/current **chat request** status alongside each reservation,
not an invented per-attempt success/billing status. Late/cancelled calls may remain
reserved; no replay or stale-lease reuse is authorized by this journal.

Each reservation validates the admitted request's recipient/revision, ownership,
unexpired lease and next attempt number, then atomically appends a metadata-only
row and increments personal/global counters. Duplicate, out-of-order, third and
stale reservations are rejected. The short transaction locks user, thread, then
the UTC daily row. Model I/O is outside all locks. It validates the **admitted**
recipient, not current admin routing, so an already accepted answer keeps 4B1's
pinned-provider semantics even after a switch/revocation. A later request still
needs current routing and recipient consent. The reservation does not confer consent.

The first reservation of a UTC day also pins that day's two limit values. Replicas
with different positive settings fail closed, rather than raising the cap or
creating separate buckets. Configure all replicas consistently; schedule positive
limit changes for the next UTC day, or restore the values already pinned today.
Zero is an immediate new-attempt stop regardless of today's pinned values.
Restart is required for environment changes; an already reserved call may finish.
Never clear counters or change the server clock to work around this boundary.

Human handoff responses do not enter an adapter and reserve no model attempt.
Accepted-chat admission still occurs first: if attempt capacity later runs out,
the accepted user message and interrupted result remain in history and the chat
admission counter is not refunded. The client receives an explanatory SSE error
and does not automatically repeat the message. Consent/pre-admission rejections
never reserve an attempt. No new client consent/SSE contract is required.

`GET /v1/admin/ai` adds the optional `attempts` summary: today's reserve count,
configured limits and consistency flag, plus the latest 20 metadata-only rows.
The existing admin allowlist protects it. It exposes no keys, tokens, prompts or
profile fields. The journal's timestamp is UTC ISO 8601; the UI renders local time.
Historical response metadata and XP are unchanged. Missing token usage is not
invented. The per-attempt ledger has indexed foreign keys and a newest-first index.

**Financial budget remains a separate next step (4B2b).** Neither these count caps
nor existing output-token limits are a monetary guarantee. Before any live pilot,
the operator must approve currency, per-model/upstream prices and conservative
request-cost envelopes, daily/project budgets, provider-side caps and the handling
of unknown usage. This PR does not choose tariffs, convert currencies, authorize
spending, call live models, or present reserved attempts as actual expenses.

OpenAI keeps `maxRetries:1`. Its per-stream fetch wrapper observes each additional
SDK transport attempt and awaits the guard; a denial aborts that stream so it is
not mistaken for a retryable connection failure. Direct OpenAI fetch now also
rejects redirects instead of following an unaccounted transport/recipient hop. Official reference checked
2026-09-07: [TypeScript SDK retries and fetch customization](https://developers.openai.com/api/reference/typescript#retries).

## Server configuration

| Setting                          | Behavior                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER` unset/blank       | Preserve legacy OpenAI selection when both OpenAI settings exist. Both absent means AI is unconfigured. A partial pair is an error.                |
| `LLM_PROVIDER=openai`            | Require both `OPENAI_API_KEY` and `OPENAI_MODEL`.                                                                                                  |
| `LLM_PROVIDER=disabled`          | Disable AI explicitly, even if keys remain configured.                                                                                             |
| `LLM_PROVIDER=routerai`          | Local/test only; require separate key, model and upstream below. Production startup fails before database connection, even with valid credentials. |
| `LLM_PROVIDER=gigachat`          | Local/test only; require a separate authorization key, model and account scope below. Production startup fails before database connection.         |
| `LLM_REQUEST_TIMEOUT_MS`         | Integer 1000–60000, default 60000. Shared API deadline includes the provider's retry.                                                              |
| `LLM_MAX_OUTPUT_TOKENS`          | Integer 1–8000, default 1400. Existing 24000-character response cap also applies.                                                                  |
| `LLM_USER_DAILY_REQUEST_LIMIT`   | Integer 0–10000, default 20. Per-user accepted chats per UTC day. Zero blocks admission.                                                           |
| `LLM_GLOBAL_DAILY_REQUEST_LIMIT` | Integer 0–1000000, default 200. Shared accepted chats per UTC day. Zero blocks admission.                                                          |

Configure secrets only in the API environment or ignored root `.env`, never in
`NEXT_PUBLIC_*`, the mobile bundle, issue/PR bodies or chat. The launch scripts
load root `.env`; Turbo passes the provider settings to its child processes.
Changing keys/models/account scope/CA/caps requires restarting API processes. Drain
active requests first; an abrupt process kill can lose an unsaved answer tail.
The table's `LLM_PROVIDER` selection rules now initialize **only a new database**;
the bootstrap selection is still validated before every database connection.
Keep its required settings complete. Once initialized, `/admin` controls the
persistent choice; changing `LLM_PROVIDER` to another provider does not overwrite
it. `LLM_PROVIDER=disabled` is the exception: it is always a server-level hard stop.

Retain both OpenAI settings. A fresh database initially uses OpenAI when
`LLM_PROVIDER` is blank or `openai`. For an existing database, return to it in
`/admin` and explicitly confirm the displayed model. The saved `disabled` choice
stops new messages without a restart. An emergency server-level stop uses
`LLM_PROVIDER=disabled` plus a consistent restart on all replicas; the admin cannot
override it. Existing histories, quest progress and daily counters remain in CityGo.
Configuration presence is not verification of real model access or billing.

## Administrative control (stage 4B1)

Migration `0004_ai_routing.sql` adds a singleton selection with a positive revision,
the admitted routing revision on chat requests, and a bounded audit-query index.
Apply it before starting this version. First initialization inserts the existing
bootstrap choice exactly once and audits that event with no actor. Restarts and
additional replicas never reset the row or its revision. A saved choice pins the
**public disclosure ID** as well as the provider; changing a server model/upstream/
scope does not silently redirect already-consented traffic.

The runtime constructs independently configured adapters at startup, with no live
AI call. Inactive incomplete/invalid settings are marked unavailable and do not
break a valid bootstrap provider. Production never prepares RouterAI/GigaChat,
even if their credentials are complete; the API control layer enforces this again.
Hard-disabled servers prepare no adapters. No raw constructor errors, credentials,
certificate paths, configurable endpoints or API keys appear in the control API.

Log in through Web with an account listed by internal ID in server-side
`ADMIN_USER_IDS`, visit `/admin`, and choose **Обновить сводку**. The control shows
the saved selection, the locally matching configuration, allowed options, model,
recipient restrictions and the last 20 changes. Select an allowed provider (or
disable), read the model/recipient, check the explicit confirmation and apply.
This administrative confirmation does not grant or replace any user's consent.

Both `GET /v1/admin/ai` and `POST /v1/admin/ai` require the existing admin allowlist.
Writes retain same-origin/bearer protections and rate limits. The update body is
`{provider,policyId,expectedRevision}`; disabling requires `policyId:null`. An
unknown provider is invalid, unavailable providers or mismatched disclosure IDs
are rejected, and arbitrary model/endpoint/key edits are not supported. Compare-
and-swap rejects a stale revision with 409, including concurrent admin submissions.
The UI refreshes and resets confirmation; it never retries an old choice silently.
An identical current choice is a no-op, not an extra revision/audit event.

Selection and audit (`from`, `to`, full new public disclosure, actor ID, timestamp)
commit together. The journal retains the selected model/recipient description
even when later server configuration changes. Each
grant/admission takes a shared routing lock **before** its user/thread/quota locks;
the switch takes the exclusive routing lock. A switch between initial lookup and
admission therefore rejects the stale grant/message before storing data or quota.
Locks end before model I/O. Already admitted answers keep their original provider
instance and may finish after switching or disabling. The selector is not a
cancellation/retraction API and never combines providers within one answer.

Every request reads the shared selection; no process-local active-provider cache
can silently serve an old choice. If the selected policy does not match a local
adapter, that replica reports AI as unconfigured and returns 503 for new messages;
it does not fall back to another configured service. `/ready` verifies database/
migration readiness, not real upstream access. The admin can inspect and explicitly
accept an updated server model by reapplying the same provider with its new policy
ID. Users then confirm that new disclosure before their next AI request.

All replicas must have the same allowed models, routing settings and caps. Do not
load-balance mixed configurations: a mismatched replica intentionally rejects chat.
Rotate configuration consistently, then accept the new snapshot in the admin.
During an ordinary configured-provider switch, no restart or drain is required;
the in-flight snapshot semantics above apply. Keep OpenAI configured for return.

## Recipient consent and admission (stage 4A)

The questionnaire only permits CityGo to build its local plan. The legacy field
name `aiConsent` remains for contract compatibility, but neither it nor historical
`ai-profile-processing` consent events authorize external AI calls. There is no
automatic consent backfill. Existing accounts must confirm the recipient too.

The authenticated dashboard exposes `aiAccess`: a server-created disclosure with
provider, requested model, RouterAI upstream/country or GigaChat account scope,
data description and version. Its SHA-256 ID binds the **entire public snapshot**;
keys, tokens and CA paths are excluded. Changing any disclosed setting produces
a different ID. Future disclosure/purpose changes must change the snapshot too.
RouterAI's upstream tag and country filter are configuration, not certification of
legal recipients, residence or retention. Review those before production activation.

Web uses an unchecked checkbox plus confirmation; Expo uses an explicit permission
button after the same disclosure. `POST /v1/ai/consent` accepts
`{action:"granted",policyId}` or `{action:"revoked"}`. The server chooses the user
from the session and validates the current policy before granting. Revocation
works even when AI is disabled or the old recipient is no longer configured.
Only one current grant per user is retained; grant/revoke events are append-only
and include the granted public snapshot for auditing. A grant to another snapshot
replaces the old one, so returning to an earlier provider requires reconfirmation.

Chat sends the ID that the client actually displayed. Missing/stale IDs return
409; current ID without a matching grant returns 403 before storing a message or
calling AI. The clients refresh after errors but never auto-consent or replay a
message. History stays readable. After a provider switch, granting permission
also permits the disclosed history (including prior providers' answers) to be sent.

Migration `0003_ai_access.sql` creates consent state and daily counters; `/ready`
now requires the migration sequence through `0005_ai_attempts.sql`. Admission locks the user, owned thread and UTC global-counter row in
a consistent order. Consent, duplicate/busy checks, quota increments, lease and
request/message insert commit atomically. The model runs **outside** this short
transaction. A revocation committed before admission blocks the request; an
already admitted request can finish. Revocation cannot retract transmitted data
and does not erase CityGo history or constitute provider-side deletion.

Counters are stored in PostgreSQL, shared across users/replicas/provider changes,
and survive restarts. They reset by UTC date, never local server timezone. Rejected
or duplicate requests do not count. Every admitted chat counts, including the
local human-handoff response and failed/interrupted model requests. No refunds or
automatic retries at admission. Do not delete counters to work around a cap.

These are **request caps, not monetary budgets** or exact upstream-attempt counts.
The existing bounded OpenAI SDK retry and GigaChat pre-stream 401 refresh still
apply, now guarded by the separate model-attempt reservations above. Input sizes and output tokens are bounded elsewhere, but actual prices,
provider-side billing limits and an approved pilot budget remain required. All
replicas must use identical settings; do not serve mixed configs behind a balancer.

### Switching/rollback checklist for this release

1. Keep the current credentials; never paste keys into chat or PRs. For RouterAI or
   GigaChat use only an authorized synthetic-data local pilot until the production
   gate is explicitly addressed in a reviewed later change.
2. Drain and stop pre-4B2a API instances. Apply all migrations through `0005` before
   starting this version. Deploy the updated Web admin; Web/Expo clients from #17
   keep their consent/chat contract. Clients predating 4A still fail closed.
3. Configure the desired adapters and their own required settings, review caps,
   and start all replicas consistently. In `/admin` explicitly choose the intended
   provider and confirm the displayed model. No live choice or paid request is
   made by this PR, and selection alone does not contact a model.
4. Check readiness, login and the user's displayed recipient/model. Withhold confirmation
   first: no new message should reach a provider. Then explicitly grant only in the
   separately authorized pilot, test revocation and preserved history.
5. To stop new messages, select disabled in the admin. To return to direct OpenAI,
   select its configured option and reconfirm the user's disclosure if needed.
   Daily usage and histories are not reset. For a hard server stop, use the
   environment override described above and restart consistently.

Do not roll back to pre-4B1 API code while serving chat traffic: it ignores the
saved administrative selection/disable despite additive SQL compatibility.
Pre-4A code additionally ignores recipient consent. Disable AI at the server
environment level or use a forward fix. Never edit or remove an applied migration.

Direct OpenAI always uses `https://api.openai.com/v1`, not an ambient
`OPENAI_BASE_URL`. It retains Responses API, `store:false`, current instructions,
the last 20 complete history messages, profile context, and at most one SDK retry.
The shared abort signal covers the complete request, including that retry.
`store:false` is not a guarantee of zero provider-side retention.

## RouterAI local pilot (synthetic data only)

For a fresh database, `LLM_PROVIDER=routerai` is an explicit bootstrap choice. For
an existing database, select the configured option in the admin. Adding RouterAI
settings alone never selects it; keeping OpenAI settings does not provide implicit fallback. No default model,
upstream, key or country is supplied. RouterAI construction does not call the API.

| Setting             | Requirement                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ROUTERAI_API_KEY`  | Server-only RouterAI key, independent of `OPENAI_API_KEY`.                                                            |
| `ROUTERAI_MODEL`    | Exact `author/model` ID from the RouterAI catalogue; no `@` routing overrides, URLs or query strings.                 |
| `ROUTERAI_UPSTREAM` | One lowercase endpoint `tag` from the selected model's endpoint list; not its display name or a comma-separated list. |
| `ROUTERAI_COUNTRY`  | Optional lowercase two-letter geographic filter. No country or residency guarantee is inferred from the service name. |

The adapter sends Chat Completions to the fixed HTTPS endpoint
`https://routerai.ru/api/v1/chat/completions`, with system instructions, existing
history/profile context, `stream:true`, `stream_options.include_usage:true` and
the configured output limit as `max_tokens`. It asks for exactly the configured
upstream using `provider.only:[tag]` and `allow_fallbacks:false`, plus the optional
country filter. It makes one HTTP attempt; redirects, client retries, default
provider routing and automatic cross-provider fallback are not used. These are
request restrictions, not independent verification of an upstream's location or
data-retention practices. Provider/upstream terms still need review before launch.

Only text deltas are exposed. A `finish_reason:stop` followed by `[DONE]`, a
reported model and nonblank answer are required for success. Length truncation,
content filtering, tool calls, refusals, malformed streams, timeout and EOF without
the terminal marker fail closed. Reasoning fields are not shown. An optional usage
chunk is normalized; missing usage is not invented. Error bodies are not surfaced.
SSE parsing handles fragmented UTF-8, comments and CRLF, bounds frames/total bytes,
and cancels the upstream body on completion, interruption or consumer cancellation.

Before a separately authorized live pilot:

1. Use a fresh local test database and synthetic accounts, questionnaire and chat.
   Do not copy production histories or enter personal information.
2. Confirm the chosen model's current endpoint list at
   `GET https://routerai.ru/api/v1/models/{author}/{slug}/endpoints`: upstream tag,
   supported parameters, streaming/text capability, token limits, country and price.
   This release does not automatically certify every catalogue model as compatible.
3. Set the three required RouterAI values in the ignored API environment; retain
   OpenAI values unchanged. Start with `pnpm dev`, never production data in dev mode.
4. Agree a test budget before sending messages. Verify the response, actual model,
   usage when present, interruption behavior and an explicit return to OpenAI in the admin.

Live RouterAI compatibility, credentials and billing have **not** been verified by
mock HTTP tests. `pnpm start` intentionally refuses RouterAI at this stage. There
is no override switch to bypass this production gate. A production pilot requires
the later consent/recipient and operational-controls stage first.

## GigaChat local pilot (synthetic data only)

Use `LLM_PROVIDER=gigachat` for explicit first initialization, or select the
configured GigaChat option in the admin of an existing local pilot. Other providers' keys/models remain
independent and are not borrowed, deleted or used as fallback. Construction does
not fetch a token or send chat data. Changing model/scope/key/CA requires an API
restart; drain active requests first. Switching configured providers uses the
admin without a restart. Return to OpenAI or RouterAI with their existing settings,
or disable AI there; CityGo retains history and quest progress.

| Setting                   | Requirement                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GIGACHAT_CREDENTIALS`    | Server-only Base64 authorization key from the GigaChat API project, without the `Basic ` prefix. Not an access token or a giga.chat website password.                                |
| `GIGACHAT_MODEL`          | Explicit model ID available to that API project. No automatic selection or upgrade.                                                                                                  |
| `GIGACHAT_SCOPE`          | Required: `GIGACHAT_API_PERS` (individual account), `GIGACHAT_API_B2B` (business prepaid) or `GIGACHAT_API_CORP` (business pay-as-you-go). Verify against the account; do not guess. |
| `GIGACHAT_CA_BUNDLE_FILE` | Optional server-local path to a verified PEM bundle containing CA certificates. Invalid/missing configured files fail startup without exposing their contents.                       |

OAuth uses the fixed `https://ngw.devices.sberbank.ru:9443/api/v2/oauth` endpoint,
Basic authorization, form-encoded scope and a fresh UUIDv4 `RqUID`. Chat uses the
current `https://api.giga.chat/v1/chat/completions` endpoint with the access token
as Bearer, system instructions, history and synthetic profile context, `stream:true`
and the configured `max_tokens`. No user credentials are sent to the chat endpoint.
There are no configurable base URLs, redirect following or cross-provider fallback.

Tokens are kept only in memory per provider instance. `expires_at` is interpreted
as epoch **milliseconds**, matching the official SDK contract; malformed/expired/
seconds-based values are rejected. Refresh starts 60 seconds before expiration.
Concurrent callers share one refresh, but cancelling one caller does not cancel
other waiters. When all waiters leave, authorization is cancelled. OAuth has a
10-second cap; the configured overall deadline also covers authorization and chat.
Late errors for an old token cannot erase a newer cached token. No token, key,
OAuth response body or raw provider error is persisted in CityGo history or logs.

A chat HTTP 401 before SSE can trigger exactly **one** refresh and resubmission
within the same overall deadline. A second 401 fails. There is no retry after a
visible delta, on stream errors, or for 403/429/5xx. Token acquisition itself does
not retry. Separate API processes have separate token caches. Daily chat-admission
quotas and model-attempt reservations are now shared. The reservation count is not
proof of upstream acceptance; financial controls remain later work.

RouterAI and GigaChat share the bounded text-only completion decoder, with the
same stop + `[DONE]` requirement and interruption semantics. GigaChat `blacklist`,
length truncation and function-call endings fail closed. Token usage is saved only
when reported; unavailable usage is not invented. This adapter does not disable
content filtering, execute functions, upload files or expose reasoning fields.

### Certificate setup and live validation

TLS certificate **and hostname verification stay enabled**, including when an
unsafe process-wide TLS flag exists. The adapter uses a separate HTTPS transport;
an optional CA bundle extends trust only for its two fixed GigaChat endpoints.
There is no `rejectUnauthorized:false` mode, global CA installation or environment
mutation. Obtain CA certificates through the official instructions and verify
their provenance before configuring the file. Never use insecure downloads or
disable verification to bypass certificate errors. Relative CA paths resolve from
the API process working directory; an absolute path is recommended.

Use a fresh test database and synthetic questionnaire/chat, confirm the API
project's scope, model access, certificate chain and test budget, then run `pnpm dev`.
No credentials, certificates or model choices are supplied by this release.
No live paid calls have been made. Mock tests validate transport settings and
contracts, **not** the real provider's TLS chain, billing, model quality or access.
`pnpm start` refuses GigaChat even with complete settings until the recipient/
consent and operational-controls stage. Never bypass this by serving production
data in development mode. A generic existing AI checkbox does not approve a new
recipient.

## Contract and persistence

`AiProviderId` is independent of `AgentKey`. A Housing Navigator can use any
implemented provider. The current production factory constructs only OpenAI.

`StreamingProvider` returns normalized `delta` events and exactly one final
`complete` event reporting the actual model and optional token usage. EOF alone,
empty output, an error, cancellation or events after completion are failures.
The adapter and API both enforce completion; clients still receive the unchanged
`delta`, `handoff`, `done`, `error` SSE contract. Provider switching is not an
agent handoff.

`messages.metadata.generation` records provider and requested model for model
attempts, plus actual model/usage when reported. Usage is not a monetary cost.
Historical rows and system/user messages return null generation metadata; they
are not relabelled with the currently configured provider. The field is additive
in shared Web/Expo contracts. Generation metadata needs no new index: it is
read with existing thread-scoped history queries, not used as a search filter.
External model waits remain outside database transactions.

Interrupted answers remain interrupted even if they include metadata. Only a
completed model answer from the required specialist can qualify a quest for
completion. XP remains server-controlled and exactly-once.

## Verification and remaining stages

- CI uses fake HTTP Responses/Chat Completions streams and test-only providers.
  No live key or paid request is needed. The real RouterAI and GigaChat adapters
  are exercised through mocked HTTP in unit and full vertical-slice integration
  tests. Test labels alone prove the common contract, not live access.
- Tests cover config/defaults, fail-closed startup, model/usage persistence,
  cancellation, missing/duplicate terminal events, history continuity between
  API instances, ownership, handoff and exactly-once XP.
- Stage 2 (completed): RouterAI adapter, explicit upstream routing, separate
  credentials/model, failure tests and local-only activation boundary.
- Stage 3 (completed): GigaChat adapter with account-specific scope, cached OAuth token,
  single-flight refresh, current API URL, and TLS certificate verification.
- Stage 4A (completed): technical recipient-specific grant/revoke, stale-client
  guard, audit, Web/Expo UI and atomic cross-process daily admission caps.
- Stage 4B1 (completed): protected manual selector, persistent revisioned choice,
  atomic audit, multi-replica admission guard and explicit return to direct OpenAI.
- Stage 4B2a (this release): atomic model-attempt reservations, guarded retries,
  shared personal/global caps and metadata-only admin journal. Not billing.
- Remaining stage 4: approved recipient/privacy notice, financial envelopes/
  budgets and optional failover, off by default. Never splice another
  provider into an answer after its first visible delta.
- Stage 5: cross-provider E2E/failure matrix, opt-in budgeted live smoke checks,
  deployment instructions and a verified return to direct OpenAI.

Before sending data to a new service, update and approve the data-recipient
notice/consent handling. A generic existing AI checkbox must not be treated as
automatic approval for every new recipient. Live checks need separately provided
server credentials, confirmed model access, and an approved test budget.

## Official references (GigaChat checked 2026-09-07; OpenAI/RouterAI 2026-09-06)

- [OpenAI Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses)
- [RouterAI quickstart](https://routerai.ru/docs/guides/overview/quickstart)
- [RouterAI provider routing](https://routerai.ru/docs/guides/overview/provider-selection)
- [RouterAI parameters](https://routerai.ru/docs/guides/overview/parameters)
- [GigaChat authorization](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/gigachat-api)
- [GigaChat streaming](https://developers.sber.ru/docs/ru/gigachat/guides/response-token-streaming)
- [GigaChat certificates](https://developers.sber.ru/docs/ru/gigachat/certificates)
- [GigaChat SDK token expiry units](https://github.com/ai-forever/gigachat-js/blob/master/src/interfaces/access_token.ts)
- [Node HTTPS transport and TLS options](https://nodejs.org/api/https.html)
