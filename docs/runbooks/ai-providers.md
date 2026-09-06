# AI provider rollout — stage 1 of 5

This release introduces provider-neutral contracts and retains direct OpenAI.
It does **not** enable RouterAI or GigaChat, automatic failover, an admin selector,
or a new data recipient. No model is selected or upgraded automatically.

## Server configuration

| Setting                               | Behavior                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER` unset/blank            | Preserve legacy OpenAI selection when both OpenAI settings exist. Both absent means AI is unconfigured. A partial pair is an error. |
| `LLM_PROVIDER=openai`                 | Require both `OPENAI_API_KEY` and `OPENAI_MODEL`.                                                                                   |
| `LLM_PROVIDER=disabled`               | Disable AI explicitly, even if keys remain configured.                                                                              |
| `LLM_PROVIDER=routerai` or `gigachat` | Reserved IDs; fail startup before database connection. Never silently route to OpenAI.                                              |
| `LLM_REQUEST_TIMEOUT_MS`              | Integer 1000–60000, default 60000. Shared API deadline includes the provider's retry.                                               |
| `LLM_MAX_OUTPUT_TOKENS`               | Integer 1–8000, default 1400. Existing 24000-character response cap also applies.                                                   |

Configure secrets only in the API environment or ignored root `.env`, never in
`NEXT_PUBLIC_*`, the mobile bundle, issue/PR bodies or chat. The launch scripts
load root `.env`; Turbo passes the three new settings to its child processes.
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

- CI uses fake HTTP Responses streams and test-only providers. No live key or
  paid request is needed. Test labels `routerai`/`gigachat` prove the common
  contract, not successful calls to those services.
- Tests cover config/defaults, fail-closed startup, model/usage persistence,
  cancellation, missing/duplicate terminal events, history continuity between
  API instances, ownership, handoff and exactly-once XP.
- Stage 2: RouterAI adapter with separate credentials/model and explicit upstream
  routing restrictions. Validate capabilities for the selected model.
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
- [GigaChat authorization](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/gigachat-api)
- [GigaChat streaming](https://developers.sber.ru/docs/ru/gigachat/guides/response-token-streaming)
- [GigaChat certificates](https://developers.sber.ru/docs/ru/gigachat/certificates)
