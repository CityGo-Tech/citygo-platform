import {
  conversationIdSchema,
  conversationTitleSchema,
  updateConversationTitleSchema,
  type ConversationTitle,
  type UpdateConversationTitle,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

const fields = `user_id::text as "userId",thread_id::text as "threadId",title,revision::text,
 to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"`;
const missing = () => new DomainError(404, "Чат не найден");
const stale = () =>
  new DomainError(
    409,
    "Название уже изменилось. Обновите его перед сохранением.",
  );
async function owned(tx: Sql, userId: string, threadId: string) {
  // Same user -> thread lock order as history/admission. Recheck after lock wait.
  const owner = (
    await tx.query<{ status: string; must_change_password: boolean }>(
      "select status,must_change_password from users where id=$1 for share",
      [userId],
    )
  ).rows[0];
  if (!owner) throw missing();
  if (owner.status !== "active" || owner.must_change_password)
    throw new DomainError(403, "Аккаунт недоступен");
  if (
    !(
      await tx.query(
        "select id from agent_threads where id=$2 and user_id=$1 for share",
        [userId, threadId],
      )
    ).rows.length
  )
    throw missing();
}
export class ConversationTitles {
  constructor(private readonly db: Database) {}
  private ids(userId: string, threadId: string) {
    conversationIdSchema.parse(userId);
    conversationIdSchema.parse(threadId);
  }
  async get(userId: string, threadId: string): Promise<ConversationTitle> {
    this.ids(userId, threadId);
    return this.db.transaction(async (tx) => {
      await owned(tx, userId, threadId);
      const row = (
        await tx.query<ConversationTitle>(
          `select ${fields} from conversation_titles where thread_id=$1 and user_id=$2`,
          [threadId, userId],
        )
      ).rows[0];
      return conversationTitleSchema.parse(
        row ?? {
          userId,
          threadId,
          title: null,
          revision: "0",
          updatedAt: null,
        },
      );
    });
  }
  async update(
    userId: string,
    threadId: string,
    raw: UpdateConversationTitle,
  ): Promise<ConversationTitle> {
    this.ids(userId, threadId);
    const input = updateConversationTitleSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await owned(tx, userId, threadId);
      const current = (
        await tx.query<ConversationTitle>(
          `select ${fields} from conversation_titles where thread_id=$1 and user_id=$2 for update`,
          [threadId, userId],
        )
      ).rows[0];
      if ((current?.revision ?? "0") !== input.expectedRevision) throw stale();
      if ((current?.title ?? null) === input.title)
        return conversationTitleSchema.parse(
          current ?? {
            userId,
            threadId,
            title: null,
            revision: "0",
            updatedAt: null,
          },
        );
      const result = current
        ? await tx.query<ConversationTitle>(
            `update conversation_titles set title=$3,revision=revision+1 where thread_id=$1 and user_id=$2 and revision=$4::bigint returning ${fields}`,
            [threadId, userId, input.title, input.expectedRevision],
          )
        : await tx.query<ConversationTitle>(
            `insert into conversation_titles(thread_id,user_id,title) values($1,$2,$3) on conflict(thread_id) do nothing returning ${fields}`,
            [threadId, userId, input.title],
          );
      if (!result.rows[0]) throw stale();
      return conversationTitleSchema.parse(result.rows[0]);
    });
  }
}
