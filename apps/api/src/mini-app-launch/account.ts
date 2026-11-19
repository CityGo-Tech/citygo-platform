import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AccountAccess,
  DomainError,
  MessengerAccounts,
  type Database,
} from "@citygo/db";
import { newToken, tokenHash, verifyPassword } from "../auth.js";
import {
  createMiniAppLaunchProofVerifier,
  type MiniAppLaunchProvider,
} from "./verify.js";
import { miniAppLaunchMaxBytes } from "./wire.js";

type Actor = { id: string; email: string; sessionTokenHash: string };
const initData = z.string().min(1).max(miniAppLaunchMaxBytes);
const signInInput = z.strictObject({ initData });
const prepareInput = z.strictObject({
  initData,
  password: z.string().min(1).max(128),
});
const linkInput = z.strictObject({
  initData,
  userId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  confirmation: z.string().regex(/^[a-f0-9]{64}$/),
});
const providerParams = z.object({ provider: z.enum(["telegram", "max"]) });
const authRoute = {
  config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  onRequest: async (request: FastifyRequest) => {
    if (request.url.includes("?"))
      throw new DomainError(400, "Передайте данные запуска в теле запроса.");
  },
};

export function registerMessengerAccounts(
  app: FastifyInstance,
  options: {
    db: Database;
    tokens: Partial<Record<MiniAppLaunchProvider, string>>;
    actor: (request: FastifyRequest) => Promise<Actor>;
    hasSession: (request: FastifyRequest) => Promise<boolean>;
    setSession: (reply: FastifyReply, token: string) => void;
    onSignIn?: (
      provider: MiniAppLaunchProvider,
      request: FastifyRequest,
    ) => Promise<void>;
  },
) {
  const accounts = new AccountAccess(options.db);
  const links = new MessengerAccounts(options.db);

  app.get("/v1/account/messenger-links", async (request) => {
    const actor = await options.actor(request);
    return { providers: await links.list(actor.id) };
  });
  app.delete("/v1/account/messenger-links/:provider", async (request) => {
    const { provider } = providerParams.parse(request.params);
    const { id, sessionTokenHash } = await options.actor(request);
    await links.unlink({ userId: id, sessionTokenHash, provider });
    return { ok: true };
  });
  app.post("/v1/account/messenger-links/:provider/revoke", async (request) => {
    const { provider } = providerParams.parse(request.params);
    const { id, sessionTokenHash } = await options.actor(request);
    await links.revoke({ userId: id, sessionTokenHash, provider });
    return { ok: true };
  });

  for (const provider of ["telegram", "max"] as const) {
    const token = options.tokens[provider];
    if (!token) continue;
    const createProof = createMiniAppLaunchProofVerifier(provider, token);
    const confirmationKey = createHmac(
      "sha256",
      "CityGoMiniAppLinkConfirmationV1",
    )
      .update(token)
      .digest();
    function proof(raw: string) {
      const value = createProof(raw);
      if (!value)
        throw new DomainError(
          400,
          "Откройте мини-приложение в мессенджере ещё раз.",
        );
      return value;
    }
    function confirmation(
      actor: Actor,
      fingerprint: string,
      passwordHash: string,
    ) {
      return createHmac("sha256", confirmationKey)
        .update(
          JSON.stringify([
            actor.id,
            actor.sessionTokenHash,
            fingerprint,
            passwordHash,
          ]),
        )
        .digest();
    }
    const prefix = `/v1/mini-apps/${provider}`;
    app.post(prefix + "/sign-in", authRoute, async (request, reply) => {
      const input = signInInput.parse(request.body);
      const launch = proof(input.initData);
      if (await options.hasSession(request))
        throw new DomainError(
          409,
          "Сначала выйдите из текущего аккаунта CityGo.",
        );
      const session = newToken();
      const user = await links.signIn({
        proof: launch,
        newSessionTokenHash: tokenHash(session),
      });
      options.setSession(reply, session);
      await options.onSignIn?.(provider, request);
      return { user, purpose: launch.purpose };
    });
    app.post(prefix + "/link/prepare", authRoute, async (request) => {
      const actor = await options.actor(request);
      const input = prepareInput.parse(request.body);
      const launch = proof(input.initData);
      const credentials = await accounts.credentials(actor.email);
      if (
        credentials?.id !== actor.id ||
        !(await verifyPassword(input.password, credentials.password_hash))
      )
        throw new DomainError(
          403,
          "Не удалось подтвердить пароль аккаунта CityGo.",
        );
      const verified = await options.db.query(
        "select 1 from account_email_verifications where user_id=$1 and email=$2",
        [actor.id, actor.email],
      );
      if (verified.rows.length !== 1)
        throw new DomainError(403, "Сначала подтвердите почту CityGo.");
      return {
        id: actor.id,
        email: actor.email,
        confirmation: confirmation(
          actor,
          launch.fingerprint,
          credentials.password_hash,
        ).toString("hex"),
      };
    });
    app.post(prefix + "/link", authRoute, async (request) => {
      const actor = await options.actor(request);
      const input = linkInput.parse(request.body);
      const launch = proof(input.initData);
      const credentials = await accounts.credentials(actor.email);
      if (
        actor.id !== input.userId ||
        credentials?.id !== actor.id ||
        !timingSafeEqual(
          confirmation(actor, launch.fingerprint, credentials.password_hash),
          Buffer.from(input.confirmation, "hex"),
        )
      )
        throw new DomainError(
          409,
          "Подтвердите текущий аккаунт CityGo ещё раз.",
        );
      await links.link({
        userId: actor.id,
        sessionTokenHash: actor.sessionTokenHash,
        expectedPasswordHash: credentials.password_hash,
        proof: launch,
      });
      return { linked: true };
    });
  }
}
