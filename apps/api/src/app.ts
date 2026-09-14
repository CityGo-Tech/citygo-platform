import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  chatInputSchema,
  completionSchema,
  credentialsSchema,
  questionnaireSchema,
  aiConsentSchema,
  aiRoutingInputSchema,
  aiBudgetInputSchema,
  type StreamEvent,
  type ModelGeneration,
  type AiPolicy,
} from "@citygo/contracts";
import { Repository, DomainError, type Database } from "@citygo/db";
import { readConfig, effectiveLlmLimits } from "@citygo/config";
import { instructions, profileContext, routeAgent } from "@citygo/agents";
import { redactPaths } from "@citygo/observability";
import type { StreamingProvider } from "@citygo/llm";
import { hashPassword, verifyPassword, tokenHash, newToken } from "./auth.js";
import { createAiControl } from "./ai-control.js";
import type { ProviderMap } from "./provider.js";
import { createAiExecution } from "./ai-execution.js";

export async function buildApp(options: {
  db: Database;
  provider?: StreamingProvider;
  providers?: ProviderMap;
  config?: ReturnType<typeof readConfig>;
  testing?: boolean;
}) {
  const config = options.config ?? readConfig();
  const repo = new Repository(options.db);
  const providers: ProviderMap = { ...options.providers };
  if (options.provider) providers[options.provider.name] = options.provider;
  const control = createAiControl(config, providers);
  const executions = control.options.flatMap((option) =>
    option.policy ? [createAiExecution(config, option.policy)] : [],
  );
  await repo.initializeAiRouting(
    control.options.find((entry) => entry.provider === options.provider?.name)
      ?.policy ?? null,
  );
  const currentAi = async () => control.resolve(await repo.aiRouting());
  const app = Fastify({
    logger: options.testing ? false : { redact: redactPaths },
    bodyLimit: 16 * 1024,
    genReqId: () => randomUUID(),
    trustProxy: config.TRUSTED_PROXY_CIDRS.length
      ? config.TRUSTED_PROXY_CIDRS
      : false,
  });
  const secure = config.NODE_ENV === "production";
  const sessionName = secure ? "__Host-citygo" : "citygo";
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    maxAge: 7 * 86400,
  };
  await app.register(cookie);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  // The limiter installs an onRoute hook: register it before declaring routes.
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });
  const dummyHash = hashPassword(randomUUID());
  const bearer = (authorization?: string) =>
    authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  async function authenticate(request: {
    headers: { authorization?: string };
    cookies: Record<string, string | undefined>;
  }) {
    const token =
      bearer(request.headers.authorization) ?? request.cookies[sessionName];
    const user = token ? await repo.session(tokenHash(token)) : undefined;
    if (!user) throw new DomainError(401, "Войдите в аккаунт");
    return user;
  }
  async function authenticateAdmin(
    request: Parameters<typeof authenticate>[0],
  ) {
    const user = await authenticate(request);
    if (
      !config.ADMIN_USER_IDS.split(",")
        .map((value) => value.trim())
        .includes(user.id)
    )
      throw new DomainError(403, "Доступ только для администратора");
    return user;
  }
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store");
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    // Cookie-authenticated writes must be same-origin. Native clients use bearer sessions.
    if (
      request.headers.origin
        ? request.headers.origin !== config.WEB_ORIGIN
        : !bearer(request.headers.authorization) &&
          request.headers["x-citygo-client"] !== "native"
    ) {
      throw new DomainError(403, "Недопустимый источник запроса");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "Проверьте поля формы",
        fields: error.flatten().fieldErrors,
      });
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429)
      return reply
        .code(429)
        .send({ error: "Слишком много запросов. Попробуйте позже." });
    if ((error as { code?: string }).code === "23505")
      return reply.code(409).send({ error: "Запись уже существует" });
    request.log.error(
      { code: (error as { code?: string }).code, requestId: request.id },
      "Request failed",
    );
    return reply
      .code(status && status >= 400 && status < 500 ? status : 500)
      .send({ error: "Не удалось выполнить запрос", requestId: request.id });
  });
  app.get("/health", async () => ({
    service: "citygo-api",
    status: "ok",
    timestamp: new Date().toISOString(),
  }));
  app.get("/ready", async () => {
    try {
      const result = await options.db.query(
        "select name from citygo_migrations where name in ('0006_ai_budget.sql','0007_ai_user_daily_budget.sql')",
      );
      if (result.rows.length !== 2) throw new Error("Pending migration");
    } catch {
      throw new DomainError(503, "База данных не готова: примените миграции");
    }
    return { status: "ok" };
  });
  for (const action of ["register", "login"] as const) {
    app.post(
      "/v1/auth/" + action,
      {
        config: {
          rateLimit: {
            max: 10,
            timeWindow: "15 minutes",
          },
        },
      },
      async (request, reply) => {
        const input = credentialsSchema.parse(request.body);
        let id: string;
        if (action === "register")
          id = await repo.register(
            input.email,
            await hashPassword(input.password),
          );
        else {
          const candidate = await repo.credentials(input.email);
          const valid = await verifyPassword(
            input.password,
            candidate?.password_hash ?? (await dummyHash),
          );
          if (!candidate || !valid)
            throw new DomainError(401, "Неверная почта или пароль");
          id = candidate.id;
        }
        const token = newToken();
        await repo.createSession(id, tokenHash(token));
        reply.setCookie(sessionName, token, cookieOptions);
        // Native mode is explicit; browser sessions remain HttpOnly.
        return {
          user: { id, email: input.email },
          ...(request.headers["x-citygo-client"] === "native" ? { token } : {}),
        };
      },
    );
  }
  app.post("/v1/auth/logout", async (request, reply) => {
    const token =
      bearer(request.headers.authorization) ?? request.cookies[sessionName];
    if (token) await repo.logout(tokenHash(token));
    reply.clearCookie(sessionName, {
      path: "/",
      secure,
      httpOnly: true,
      sameSite: "lax",
    });
    return { ok: true };
  });
  app.get("/v1/dashboard", async (request) => {
    const user = await authenticate(request);
    const active = await currentAi();
    return repo.dashboard(
      user,
      active.provider?.name ?? "unconfigured",
      active.policy,
      config.LLM_USER_DAILY_REQUEST_LIMIT,
    );
  });
  app.post("/v1/ai/consent", async (request) => {
    const user = await authenticate(request);
    const input = aiConsentSchema.parse(request.body);
    if (input.action === "revoked") {
      await repo.aiConsent(user.id, null);
      return { ok: true };
    }
    const active = await currentAi();
    if (!active.policy || input.policyId !== active.policy.id)
      throw new DomainError(
        409,
        "AI-получатель изменился. Обновите страницу и проверьте условия.",
      );
    await repo.aiConsent(user.id, {
      policy: active.policy,
      revision: active.current.revision,
    });
    return { ok: true };
  });
  app.post("/v1/questionnaire", async (request) => {
    const user = await authenticate(request);
    await repo.questionnaire(user.id, questionnaireSchema.parse(request.body));
    return { ok: true };
  });
  const questParams = z.object({ id: z.string().regex(/^[1-9]\d*$/) });
  app.post("/v1/quests/:id/start", async (request) => {
    const user = await authenticate(request);
    return repo.start(user.id, questParams.parse(request.params).id);
  });
  app.post("/v1/quests/:id/complete", async (request) => {
    const user = await authenticate(request);
    completionSchema.parse(request.body);
    return repo.complete(user.id, questParams.parse(request.params).id);
  });
  app.post(
    "/v1/threads/:id/messages",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const user = await authenticate(request);
      const threadId = questParams.parse(request.params).id;
      const input = chatInputSchema.parse(request.body);
      // Immutable snapshot for this admission. A concurrent switch is caught by
      // the repository lock/revision check before any message or quota is stored.
      const { provider, policy: aiPolicy, current } = await currentAi();
      if (!provider || !aiPolicy)
        throw new DomainError(
          503,
          "AI пока недоступен. Администратору нужно проверить выбранного провайдера и настройки сервера.",
        );
      if (input.policyId !== aiPolicy.id)
        throw new DomainError(
          409,
          "AI-получатель изменился или не подтверждён. Обновите страницу и проверьте условия.",
        );
      const limits = effectiveLlmLimits(config, provider.name, provider.model);
      const reservation = await repo.reserveChat(
        user.id,
        threadId,
        input.requestId,
        input.text,
        {
          policyId: aiPolicy.id,
          revision: current.revision,
          userDailyLimit: config.LLM_USER_DAILY_REQUEST_LIMIT,
          globalDailyLimit: config.LLM_GLOBAL_DAILY_REQUEST_LIMIT,
          leaseMs: limits.chatLeaseMs,
        },
      );
      const routing = routeAgent(input.text, reservation.thread.agent_key);
      const abort = new AbortController();
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(limits.requestTimeoutMs),
      ]);
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined) reply.raw.setHeader(name, value);
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      const send = (event: StreamEvent) => {
        if (!reply.raw.destroyed)
          reply.raw.write("data: " + JSON.stringify(event) + "\n\n");
      };
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) abort.abort();
      });
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": keepalive\n\n");
      }, 15000);
      let content = "";
      let saved = false;
      let generation: ModelGeneration | undefined;
      let attemptNumber = 0;
      let attemptError: DomainError | undefined;
      const reserveAttempt = async () => {
        signal.throwIfAborted();
        try {
          if (attemptNumber > 0 && content.length > 0)
            throw new DomainError(409, "Повтор после начала ответа запрещён.");
          await repo.reserveAiAttempt({
            userId: user.id,
            threadId,
            requestId: input.requestId,
            lease: reservation.lease,
            attemptNumber: ++attemptNumber,
            provider: provider.name,
            model: provider.model,
            policyId: aiPolicy.id,
            routingRevision: current.revision,
            userDailyLimit: config.LLM_USER_DAILY_ATTEMPT_LIMIT,
            globalDailyLimit: config.LLM_GLOBAL_DAILY_ATTEMPT_LIMIT,
            execution: createAiExecution(config, aiPolicy),
          });
        } catch (error) {
          if (error instanceof DomainError) attemptError = error;
          abort.abort();
          throw error;
        }
        signal.throwIfAborted();
      };
      try {
        if (routing.to !== reservation.thread.agent_key || routing.human) {
          await repo.handoff(
            user.id,
            threadId,
            reservation.thread.agent_key,
            routing.to,
            routing.reason,
            routing.human,
          );
          send({
            type: "handoff",
            from: reservation.thread.agent_key,
            to: routing.to,
            reason: routing.reason,
          });
        }
        if (routing.human) {
          content =
            "Запрос на помощь человека сохранён. Живой риелтор пока не подключён к CityGo; это не отправка сообщения внешнему специалисту. Не переводите деньги и не отправляйте документы до независимой проверки.";
          send({ type: "delta", text: content });
        } else {
          const messages = reservation.messages
            .filter((m) => m.status === "complete")
            .slice(-20)
            .map((m) => ({ role: m.role, content: m.content }));
          const modelInstructions = instructions(routing.to);
          const modelMessages = [
            profileContext(reservation.profile),
            ...messages,
          ];
          if (
            Buffer.byteLength(
              JSON.stringify({
                instructions: modelInstructions,
                messages: modelMessages,
              }),
              "utf8",
            ) > config.LLM_MAX_INPUT_BYTES
          ) {
            attemptError = new DomainError(
              413,
              "Контекст диалога превышает подтверждённый лимит AI. Обратитесь к администратору.",
            );
            throw attemptError;
          }
          // Bound context and reserve both attempt + money before adapter/OAuth.
          // No automatic refund: even a failed request may have been billed.
          await reserveAttempt();
          generation = {
            provider: provider.name,
            requestedModel: provider.model,
          };
          let completed = false;
          for await (const event of provider.stream(
            modelInstructions,
            modelMessages,
            signal,
            { beforeRetry: reserveAttempt },
          )) {
            signal.throwIfAborted();
            if (completed)
              throw new Error("Provider sent events after completion");
            if (event.type === "complete") {
              if (!event.model.trim())
                throw new Error("Provider omitted model");
              completed = true;
              generation = {
                ...generation,
                model: event.model,
                ...(event.usage ? { usage: event.usage } : {}),
              };
            } else {
              content += event.text;
              if (content.length > limits.maxOutputCharacters)
                throw new Error("Response too large");
              send({ type: "delta", text: event.text });
            }
          }
          signal.throwIfAborted();
          if (!completed) throw new Error("Provider stream interrupted");
          if (!content.trim()) throw new Error("Empty response");
        }
        const messageId = await repo.finishChat(
          threadId,
          input.requestId,
          reservation.lease,
          routing.to,
          content,
          true,
          !routing.human,
          generation,
        );
        saved = true;
        send({ type: "done", messageId });
      } catch {
        if (!saved)
          await repo
            .finishChat(
              threadId,
              input.requestId,
              reservation.lease,
              routing.to,
              content,
              false,
              !routing.human,
              generation,
            )
            .catch(() =>
              request.log.error("Failed to persist interrupted response"),
            );
        send({
          type: "error",
          message:
            attemptError?.message ??
            "Ответ прерван. История сохранена; попробуйте отправить сообщение снова.",
        });
      } finally {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    },
  );
  app.get("/v1/admin/ai", async (request) => {
    await authenticateAdmin(request);
    const active = await currentAi();
    return {
      current: active.current,
      effectiveProvider: active.provider?.name ?? "unconfigured",
      environmentDisabled: control.environmentDisabled,
      automaticFallback: false,
      options: control.options,
      audit: await repo.aiRoutingAudit(),
      budget: await repo.aiBudget(executions),
      attempts: await repo.aiAttemptOverview(
        config.LLM_USER_DAILY_ATTEMPT_LIMIT,
        config.LLM_GLOBAL_DAILY_ATTEMPT_LIMIT,
      ),
    };
  });
  app.post("/v1/admin/ai", async (request) => {
    const user = await authenticateAdmin(request);
    const input = aiRoutingInputSchema.parse(request.body);
    let policy: AiPolicy | null = null;
    if (input.provider !== "disabled") {
      const option = control.options.find(
        (entry) => entry.provider === input.provider,
      );
      if (!option?.policy || option.policy.id !== input.policyId)
        throw new DomainError(
          409,
          "Провайдер недоступен или его настройки изменились. Обновите список.",
        );
      policy = option.policy;
    }
    return repo.changeAiRouting(user.id, input, policy);
  });
  app.post("/v1/admin/ai/budget", async (request) => {
    const user = await authenticateAdmin(request);
    return repo.changeAiBudget(
      user.id,
      aiBudgetInputSchema.parse(request.body),
      executions,
    );
  });
  app.get("/v1/admin/overview", async (request) => {
    await authenticateAdmin(request);
    const counts = (
      await options.db.query<{ users: number; completed: number; xp: number }>(
        "select (select count(*)::integer from users) as users,(select count(*)::integer from user_quests where state='completed') as completed,(select coalesce(sum(points),0)::integer from xp_events) as xp",
      )
    ).rows[0];
    const pendingHuman = (
      await options.db.query(
        "select id::text,thread_id::text,reason,created_at from agent_handoffs where requires_human=true order by id desc limit 50",
      )
    ).rows;
    return { counts, pendingHuman };
  });
  return app;
}
