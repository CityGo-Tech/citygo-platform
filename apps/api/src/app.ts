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
  type StreamEvent,
} from "@citygo/contracts";
import { Repository, DomainError, type Database } from "@citygo/db";
import { readConfig } from "@citygo/config";
import { instructions, routeAgent } from "@citygo/agents";
import { redactPaths } from "@citygo/observability";
import type { StreamingProvider } from "@citygo/llm";
import { hashPassword, verifyPassword, tokenHash, newToken } from "./auth.js";

export function buildApp(options: {
  db: Database;
  provider?: StreamingProvider;
  config?: ReturnType<typeof readConfig>;
  testing?: boolean;
}) {
  const config = options.config ?? readConfig();
  const repo = new Repository(options.db);
  const app = Fastify({
    logger: options.testing ? false : { redact: redactPaths },
    bodyLimit: 16 * 1024,
    genReqId: () => randomUUID(),
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
  app.register(cookie);
  app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  app.register(rateLimit, {
    max: options.testing ? 10000 : 120,
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
        "select 1 from citygo_migrations where name='0002_vertical_slice.sql'",
      );
      if (!result.rows.length) throw new Error("Pending migration");
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
            max: options.testing ? 10000 : 10,
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
  app.get("/v1/dashboard", async (request) =>
    repo.dashboard(
      await authenticate(request),
      options.provider ? "openai" : "unconfigured",
    ),
  );
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
          max: options.testing ? 10000 : 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const user = await authenticate(request);
      const threadId = questParams.parse(request.params).id;
      const input = chatInputSchema.parse(request.body);
      if (!options.provider)
        throw new DomainError(
          503,
          "AI пока не подключён. Администратору нужно задать OPENAI_API_KEY и OPENAI_MODEL.",
        );
      const reservation = await repo.reserveChat(
        user.id,
        threadId,
        input.requestId,
        input.text,
      );
      const routing = routeAgent(input.text, reservation.thread.agent_key);
      const abort = new AbortController();
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(60000),
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
          for await (const text of options.provider.stream(
            instructions(routing.to, reservation.profile),
            messages,
            signal,
          )) {
            if (signal.aborted) throw new Error("Aborted");
            content += text;
            if (content.length > 24000) throw new Error("Response too large");
            send({ type: "delta", text });
          }
          if (!content.trim()) throw new Error("Empty response");
        }
        const messageId = await repo.finishChat(
          threadId,
          input.requestId,
          reservation.lease,
          routing.to,
          content,
          !routing.human,
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
            )
            .catch(() =>
              request.log.error("Failed to persist interrupted response"),
            );
        send({
          type: "error",
          message:
            "Ответ прерван. История сохранена; попробуйте отправить сообщение снова.",
        });
      } finally {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    },
  );
  app.get("/v1/admin/overview", async (request) => {
    const user = await authenticate(request);
    if (
      !config.ADMIN_USER_IDS.split(",")
        .map((v) => v.trim())
        .includes(user.id)
    )
      throw new DomainError(403, "Доступ только для администратора");
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
