import type { FastifyInstance } from "fastify";
import { DomainError } from "@citygo/db";
import {
  createMiniAppLaunchVerifier,
  type MiniAppLaunchProvider,
} from "./verify.js";
import { miniAppLaunchMaxBytes } from "./wire.js";

export function registerMiniAppLaunch(
  app: FastifyInstance,
  { telegramToken, maxToken }: { telegramToken?: string; maxToken?: string },
) {
  // Both providers use the same HMAC construction. Their keys must be distinct.
  if (telegramToken && telegramToken === maxToken)
    throw new Error("Mini-app launch validation requires distinct bot tokens");

  const routes: [MiniAppLaunchProvider, string | undefined][] = [
    ["telegram", telegramToken],
    ["max", maxToken],
  ];
  for (const [provider, botToken] of routes) {
    if (!botToken) continue;
    const verify = createMiniAppLaunchVerifier(provider, botToken);
    app.post(
      `/v1/mini-apps/${provider}/verify`,
      {
        bodyLimit: miniAppLaunchMaxBytes,
        onRequest: async (request) => {
          if (request.url.includes("?"))
            throw new DomainError(
              400,
              "Не удалось подтвердить запуск мини-приложения",
            );
          if (
            !/^text\/plain(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(
              request.headers["content-type"] ?? "",
            )
          )
            throw new DomainError(
              415,
              "Отправьте данные запуска в теле запроса",
            );
        },
      },
      async (request) => {
        const purpose =
          typeof request.body === "string" && verify(request.body);
        if (!purpose)
          throw new DomainError(
            400,
            "Не удалось подтвердить запуск мини-приложения",
          );
        return { verified: true, purpose };
      },
    );
  }
}
