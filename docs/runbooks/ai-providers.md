# AI provider rollout — stage 3 of 5

This release adds GigaChat alongside RouterAI for local synthetic-data pilots and
retains independent direct OpenAI. RouterAI and GigaChat production activation
remain blocked pending recipient/consent rollout. It does **not** enable automatic
failover or an admin selector. No model is selected or upgraded automatically.

## Server configuration

| Setting                    | Behavior                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER` unset/blank | Preserve legacy OpenAI selection when both OpenAI settings exist. Both absent means AI is unconfigured. A partial pair is an error.                |
| `LLM_PROVIDER=openai`      | Require both `OPENAI_API_KEY` and `OPENAI_MODEL`.                                                                                                  |
| `LLM_PROVIDER=disabled`    | Disable AI explicitly, even if keys remain configured.                                                                                             |
| `LLM_PROVIDER=routerai`    | Local/test only; require separate key, model and upstream below. Production startup fails before database connection, even with valid credentials. |
| `LLM_PROVIDER=gigachat`    | Local/test only; require a separate authorization key, model and account scope below. Production startup fails before database connection.         |
| `LLM_REQUEST_TIMEOUT_MS`   | Integer 1000–60000, default 60000. Shared API deadline includes the provider's retry.                                                              |
| `LLM_MAX_OUTPUT_TOKENS`    | Integer 1–8000, default 1400. Existing 24000-character response cap also applies.                                                                  |

Configure secrets only in the API environment or ignored root `.env`, never in
`NEXT_PUBLIC_*`, the mobile bundle, issue/PR bodies or chat. The launch scripts
load root `.env`; Turbo passes the provider settings to its child processes.
Changing configuration requires restarting API processes. Drain active requests
first; an abrupt process kill can lose the unsaved tail of an in-flight answer.

To retain OpenAI, keep `OPENAI_API_KEY` and `OPENAI_MODEL`, and leave
`LLM_PROVIDER` blank or set it to `openai`. To turn AI off, set it to `disabled`.
For rollback after later adapter releases, select `openai`, verify both OpenAI
settings, and restart the API. Existing histories and quest progress remain in
CityGo; access to a real model must be verified in the deployment environment.

Direct OpenAI always uses `https://api.openai.com/v1`, not an ambient
`OPENAI_BASE_URL`. It retains Responses API, `store:false`, current instructions,
the last 20 complete history messages, profile context, and at most one SDK retry.
The shared abort signal covers the complete request, including that retry.
`store:false` is not a guarantee of zero provider-side retention.

## RouterAI local pilot (synthetic data only)

Set `LLM_PROVIDER=routerai` explicitly. Adding RouterAI settings alone never selects
it; keeping OpenAI settings does not provide implicit fallback. No default model,
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
   usage when present, interruption behavior and a return to `LLM_PROVIDER=openai`.

Live RouterAI compatibility, credentials and billing have **not** been verified by
mock HTTP tests. `pnpm start` intentionally refuses RouterAI at this stage. There
is no override switch to bypass this production gate. A production pilot requires
the later consent/recipient and operational-controls stage first.

## GigaChat local pilot (synthetic data only)

Select `LLM_PROVIDER=gigachat` explicitly. Other providers' keys/models remain
independent and are not borrowed, deleted or used as fallback. Construction does
not fetch a token or send chat data. Changing provider/model/scope/key/CA requires
an API restart; drain active requests first. Return to `openai` or `routerai` with
their existing settings, or `disabled`; CityGo retains history and quest progress.

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
not retry. Separate API processes have separate token caches; cross-process quotas
and spending controls remain part of the later operational stage.

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
in shared Web/Expo contracts. No migration or new index is required: metadata is
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
- Stage 3 (this release): GigaChat adapter with account-specific scope, cached OAuth token,
  single-flight refresh, current API URL, and TLS certificate verification.
- Stage 4: operational switching, approved data-recipient/consent policy,
  bounded spending/attempts and optional failover, off by default. Never splice
  another provider into an answer after its first visible delta.
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
