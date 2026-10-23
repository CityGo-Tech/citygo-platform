import type { AgentKey } from "@citygo/contracts";
import { agentKeySchema } from "@citygo/contracts";
import type { Database } from "./index.js";
import { DomainError } from "./errors.js";

export type ConversationThread = {
  id: string;
  agentKey: AgentKey;
  assistantKey?: AgentKey | null;
  closed?: boolean;
};

// Start talking before a profile, plan or quest exists. The caller supplies the
// authenticated session owner, never an owner ID taken from a request body.
export async function ensureConversation(
  db: Database,
  userId: string,
  agentKey?: AgentKey,
): Promise<ConversationThread> {
  if (!/^[1-9]\d{0,18}$/.test(userId) || BigInt(userId) > 9223372036854775807n)
    throw new DomainError(400, "Недопустимый идентификатор аккаунта");
  if (agentKey !== undefined && !agentKeySchema.safeParse(agentKey).success)
    throw new DomainError(400, "Неизвестный помощник");

  return db.transaction(async (tx) => {
    // Same owner -> thread order as chat admission and quest start. No model or
    // network call is made while holding this short creation lock.
    const owner = (
      await tx.query<{ id: string; status: string }>(
        "select id::text,status from users where id=$1 for update",
        [userId],
      )
    ).rows[0];
    if (!owner) throw new DomainError(404, "Аккаунт не найден");
    if (owner.status !== "active")
      throw new DomainError(403, "Аккаунт недоступен");

    const current = (
      await tx.query<ConversationThread>(
        `select id::text,agent_key as "agentKey" from agent_threads
         where user_id=$1 and status<>'closed'
           and conversation_agent_key is not distinct from $2::text for update`,
        [userId, agentKey ?? null],
      )
    ).rows[0];
    // Preserve the current specialist, lease and history; opening the app must
    // not hand the conversation back to Support or restart an admitted reply.
    if (current)
      return agentKey === undefined
        ? current
        : { ...current, assistantKey: agentKey, closed: false };

    const created = (
      await tx.query<ConversationThread>(
        `insert into agent_threads(user_id,agent_key,conversation_agent_key) values ($1,$2,$3)
         returning id::text,agent_key as "agentKey"`,
        [userId, agentKey ?? "support", agentKey ?? null],
      )
    ).rows[0]!;
    return agentKey === undefined
      ? created
      : { ...created, assistantKey: agentKey, closed: false };
  });
}
