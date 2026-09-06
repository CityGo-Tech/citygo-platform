# AI provider rollout — stage 2 of 5

This release adds a RouterAI adapter for a local synthetic-data pilot and retains
independent direct OpenAI. RouterAI production activation remains blocked pending
recipient/consent rollout. It does **not** enable GigaChat, automatic failover or an
admin selector. No model is selected or upgraded automatically.

## Server configuration

| Setting                    | Behavior                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER` unset/blank | Preserve legacy OpenAI selection when both OpenAI settings exist. Both absent means AI is unconfigured. A partial pair is an error.                |
| `LLM_PROVIDER=openai`      | Require both `OPENAI_API_KEY` and `OPENAI_MODEL`.                                                                                                  |
| `LLM_PROVIDER=disabled`    | Disable AI explicitly, even if keys remain configured.                                                                                             |
| `LLM_PROVIDER=routerai`    | Local/test only; require separate key, model and upstream below. Production startup fails before database connection, even with valid credentials. |
| `LLM_PROVIDER=gigachat`    | Reserved ID; fail startup before database connection. Never silently route to OpenAI.                                                              |
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
  No live key or paid request is needed. The real RouterAI adapter is exercised
  through mocked HTTP in unit and full vertical-slice integration tests. Test
  labels alone, including `gigachat`, prove the common contract, not live access.
- Tests cover config/defaults, fail-closed startup, model/usage persistence,
  cancellation, missing/duplicate terminal events, history continuity between
  API instances, ownership, handoff and exactly-once XP.
- Stage 2 (this release): RouterAI adapter, explicit upstream routing, separate
  credentials/model, failure tests and local-only activation boundary.
- Stage 3: GigaChat adapter with account-specific scope, cached OAuth token,
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

## Official references checked 2026-09-06

- [OpenAI Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses)
- [RouterAI quickstart](https://routerai.ru/docs/guides/overview/quickstart)
- [RouterAI provider routing](https://routerai.ru/docs/guides/overview/provider-selection)
- [RouterAI parameters](https://routerai.ru/docs/guides/overview/parameters)
- [GigaChat authorization](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/gigachat-api)
- [GigaChat streaming](https://developers.sber.ru/docs/ru/gigachat/guides/response-token-streaming)
- [GigaChat certificates](https://developers.sber.ru/docs/ru/gigachat/certificates)
