import {
  favoriteMessagesQuerySchema,
  messageIdSchema,
  setMessageFavoriteSchema,
  type FavoriteMessage,
  type FavoriteMessagesPage,
} from "@citygo/contracts";
import type { Database } from "./index.js";
import { DomainError } from "./errors.js";

/** A private bookmark on the existing message, not a second copy of its text.
 * Removing the message/account removes the bookmark too. No AI or money calls.
 */
export class MessageFavorites {
  constructor(private readonly db: Database) {}

  async set(userId: string, messageId: string, saved: boolean) {
    messageIdSchema.parse(userId);
    messageIdSchema.parse(messageId);
    setMessageFavoriteSchema.parse({ saved });
    // One atomic UPDATE: concurrent metadata changes are preserved, and neither
    // a forged owner nor system/tool messages may be bookmarked. Replays set
    // an explicit state rather than toggling it a second time.
    const result = await this.db.query(
      `update messages m set metadata=jsonb_set(m.metadata,'{citygoFavorite}',to_jsonb($3::boolean),true)
       from agent_threads t where m.thread_id=t.id and t.user_id=$1 and m.id=$2
       and m.role in ('user','assistant') returning m.id`,
      [userId, messageId, saved],
    );
    if (!result.rows.length) throw new DomainError(404, "Сообщение не найдено");
    return { messageId, saved };
  }

  async list(userId: string, before?: string): Promise<FavoriteMessagesPage> {
    messageIdSchema.parse(userId);
    favoriteMessagesQuerySchema.parse({ before });
    // Keyset by original message ID, not floating-point JS IDs or OFFSET.
    // Existing owner/thread and message indexes bound this pilot-sized query;
    // no schema upgrade is needed. Sort is message order, NOT
    // bookmark creation time. Closed conversations remain readable by owner.
    const result = await this.db.query<FavoriteMessage>(
      `select m.id::text,m.thread_id::text as "threadId",m.role,m.content,
       coalesce(m.metadata->>'agentKey','housing') as "agentKey",
       coalesce(m.metadata->>'status','complete') as status
       from agent_threads t join messages m on m.thread_id=t.id
       where t.user_id=$1 and m.role in ('user','assistant')
       and m.metadata->'citygoFavorite'='true'::jsonb
       and ($2::bigint is null or m.id<$2::bigint)
       order by m.id desc limit 21`,
      [userId, before ?? null],
    );
    const messages: FavoriteMessage[] = [];
    let bytes = 0;
    for (const message of result.rows.slice(0, 20)) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (messages.length && bytes + size > 6 * 1024 * 1024) break;
      messages.push(message);
      bytes += size;
    }
    return {
      userId,
      messages,
      nextBefore:
        result.rows.length > messages.length ? messages.at(-1)!.id : null,
    };
  }
}
