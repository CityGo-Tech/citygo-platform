import type { AgentKey } from "@citygo/contracts";
import type { Database } from "./index.js";
import { DomainError } from "./errors.js";

export type ConversationThread = { id: string; agentKey: AgentKey };

// Start talking before a profile, plan or quest exists. The caller supplies the
// authenticated session owner, never an owner ID taken from a request body.
export async function ensureConversation(
  db: Database,
  userId: string,
): Promise<ConversationThread> {
  if (!/^[1-9]\d{0,18}$/.test(userId) || BigInt(userId) > 9223372036854775807n)
    throw new DomainError(400, "Недопустимый идентификатор аккаунта");

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
         where user_id=$1 and status<>'closed' for update`,
        [userId],
      )
    ).rows[0];
    // Preserve the current specialist, lease and history; opening the app must
    // not hand the conversation back to Support or restart an admitted reply.
    if (current) return current;

    return (
      await tx.query<ConversationThread>(
        `insert into agent_threads(user_id,agent_key) values ($1,'support')
         returning id::text,agent_key as "agentKey"`,
        [userId],
      )
    ).rows[0]!;
  });
}
