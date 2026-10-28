// Synthetic browser fixtures ONLY. Never imported by server.ts or production modules.
import { randomUUID } from "node:crypto";
import { PersonalPlan, type Database } from "@citygo/db";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";

export const observabilityFixture = {
  password: "test-observability-123456",
  ownerEmail: "observability-owner@example.test",
  controllerEmail: "observability-controller@example.test",
  adminEmail: "observability-admin@example.test",
  customerEmail: "observability-customer@example.test",
  otherEmail: "observability-other@example.test",
  firstMessage: "Первый вопрос тестового пользователя",
  lastMessage:
    '<img src=x onerror="window.__unexpectedPrivateHtml=true"> Только текст ответа',
  planTitle: "Найти жильё для переезда",
} as const;

export async function seedObservabilityE2eFixture(
  db: Database,
  app: FastifyInstance,
  databaseUrl: string,
) {
  if (process.env.NODE_ENV !== "test" || databaseUrl !== "pglite://:memory:")
    throw new Error(
      "Observability fixtures require isolated test memory database",
    );
  const passwordHash = await hashPassword(observabilityFixture.password);
  const accounts: Record<string, string> = {};
  for (const [name, email, role] of [
    ["owner", observabilityFixture.ownerEmail, "super_admin"],
    ["admin", observabilityFixture.adminEmail, "admin"],
    ["customer", observabilityFixture.customerEmail, "user"],
    ["other", observabilityFixture.otherEmail, "user"],
    ["controller", observabilityFixture.controllerEmail, "super_admin"],
  ]) {
    const id = await registerSyntheticConsentingUser(
      db,
      email!,
      passwordHash,
      app,
    );
    await db.query("update users set role=$2 where id=$1", [id, role]);
    accounts[name!] = id;
  }
  const userId = accounts.customer!;
  const conversationId = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,status)values($1,'housing','closed')returning id::text",
      [userId],
    )
  ).rows[0]!.id;
  let firstId = "";
  // More than one normal admin page, with a visible plain-text XSS sentinel.
  for (let index = 0; index < 128; index++) {
    const content =
      index === 0
        ? observabilityFixture.firstMessage
        : index === 127
          ? observabilityFixture.lastMessage
          : `${index % 2 === 0 ? "Вопрос" : "Ответ"} ${index + 1} тестового диалога`;
    const id = (
      await db.query<{ id: string }>(
        "insert into messages(thread_id,role,content,metadata)values($1,$2,$3,$4::jsonb)returning id::text",
        [
          conversationId,
          index % 2 === 0 ? "user" : "assistant",
          content,
          JSON.stringify({ citygoFavorite: index === 127 }),
        ],
      )
    ).rows[0]!.id;
    if (index === 0) firstId = id;
  }
  await db.query(
    "insert into ai_credit_accounts(user_id,granted_micros,held_micros,spent_micros)values($1,500000000,5000000,3000000)",
    [userId],
  );
  await db.query(
    "insert into relocation_profiles(user_id,origin_city,target_city,monthly_budget)values($1,'Казань','Москва',80000)",
    [userId],
  );
  await new PersonalPlan(db).create(userId, {
    operationId: randomUUID(),
    sourceMessageId: firstId,
    title: observabilityFixture.planTitle,
    details: "Синтетический шаг для проверки кабинета",
  });
  await db.query(
    "insert into analytics_events(user_id,name)values($1,'ui_wallet_opened'),($1,'ui_plan_opened')",
    [userId],
  );
}
