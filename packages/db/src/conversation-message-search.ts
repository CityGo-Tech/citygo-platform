import {
  conversationHistoryIdSchema,
  conversationMessageSearchQuerySchema,
  conversationMessageSearchPageSchema,
  type ConversationMessageSearchMatch,
} from "@citygo/contracts";
import type { Database } from "./index.js";
import { DomainError } from "./errors.js";

/** Read-only literal lookup in one authorized conversation. No AI/context or money mutation. */
export class ConversationMessageSearch {
  constructor(private readonly db: Database) {}
  async list(
    userId: string,
    threadId: string,
    input: { search: string; before?: string },
  ) {
    conversationHistoryIdSchema.parse(userId);
    conversationHistoryIdSchema.parse(threadId);
    const query = conversationMessageSearchQuerySchema.parse(input);
    return this.db.transaction(async (tx) => {
      // The same short user -> thread lock order as the existing context reader.
      const owner = (
        await tx.query<{ status: string; must_change_password: boolean }>(
          "select status,must_change_password from users where id=$1 for share",
          [userId],
        )
      ).rows[0];
      if (!owner) throw new DomainError(404, "Чат не найден");
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
        throw new DomainError(404, "Чат не найден");
      if (
        query.before &&
        !(
          await tx.query(
            "select id from messages where thread_id=$1 and id=$2 and role in ('user','assistant') and position(lower($3::text) in lower(content))>0",
            [threadId, query.before, query.search],
          )
        ).rows.length
      )
        throw new DomainError(404, "Сообщение не найдено");
      // Parameterized position(), not LIKE/regex: percent/underscore/backslash are literal.
      // A 21st hit is lookahead only. Existing indexes scope the conversation;
      // literal substring search is not claimed to have constant execution time.
      const rows = (
        await tx.query<ConversationMessageSearchMatch>(
          `select id::text as "messageId",role,
          coalesce(metadata->>'agentKey','housing') as "agentKey",
          coalesce(metadata->>'status','complete') as status,
          substring(content from greatest(position(lower($3::text) in lower(content))-60,1) for char_length($3::text)+120) as snippet
         from messages where thread_id=$1 and role in ('user','assistant')
          and ($2::bigint is null or id<$2::bigint)
          and position(lower($3::text) in lower(content))>0
         order by id desc limit 21`,
          [threadId, query.before ?? null, query.search],
        )
      ).rows;
      const matches = rows.slice(0, 20).map((row) => {
        let snippet = "";
        for (const point of row.snippet) {
          if (snippet.length + point.length > 512) break;
          snippet += point;
        }
        return { ...row, snippet };
      });
      return conversationMessageSearchPageSchema.parse({
        userId,
        threadId,
        search: query.search,
        matches,
        nextCursor: rows.length > 20 ? matches.at(-1)!.messageId : null,
      });
    });
  }
}
