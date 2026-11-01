import {
  CONVERSATION_EXPORT_MAX_BYTES,
  CONVERSATION_EXPORT_MAX_MESSAGES,
  conversationExportSchema,
  conversationHistoryIdSchema,
  type ConversationExportSnapshot,
} from "@citygo/contracts";
import type { Database } from "./index.js";
import { DomainError } from "./errors.js";

/** Owner -> thread locks, then one statement snapshot. No page stitching or writes. */
export async function exportConversation(
  db: Database,
  userId: string,
  threadId: string,
): Promise<ConversationExportSnapshot> {
  conversationHistoryIdSchema.parse(userId);
  conversationHistoryIdSchema.parse(threadId);
  return db.transaction(async (tx) => {
    const owner = (
      await tx.query<{ status: string; must_change_password: boolean }>(
        "select status,must_change_password from users where id=$1 for share",
        [userId],
      )
    ).rows[0];
    if (!owner || owner.status !== "active" || owner.must_change_password)
      throw new DomainError(403, "Аккаунт недоступен");
    const thread = (
      await tx.query<ConversationExportSnapshot["thread"]>(
        `select id::text,agent_key as "agentKey",conversation_agent_key as "assistantKey",(status='closed') as closed
       from agent_threads where id=$2 and user_id=$1 for share`,
        [userId, threadId],
      )
    ).rows[0];
    if (!thread) throw new DomainError(404, "Диалог не найден");
    // The 5001st row is only a refusal sentinel. Content is fetched only when
    // the entire bounded inventory fits; large conversations never become a
    // partial file. A single SELECT provides one MVCC snapshot even for legacy
    // message writers. ID order is the same as the existing history reader.
    const row = (
      await tx.query<{
        generatedAt: string;
        messageCount: string;
        contentBytes: string;
        messages: unknown;
      }>(
        `with visible as materialized (
        select id,octet_length(content)::bigint as bytes from messages
        where thread_id=$1 and role in ('user','assistant') order by id limit $2
      ), bounds as (
        select count(*)::bigint as message_count,coalesce(sum(bytes),0)::bigint as content_bytes from visible
      ), payload as (
        select m.id,jsonb_build_object('id',m.id::text,'role',m.role,'content',m.content,
          'agentKey',coalesce(m.metadata->>'agentKey','housing'),
          'status',coalesce(m.metadata->>'status','complete'),
          'failureCode',m.metadata->>'failureCode',
          'createdAt',to_char(m.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) as value
        from visible v join messages m on m.id=v.id cross join bounds b
        where b.message_count<=$3 and b.content_bytes<=$4
      )
      select to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "generatedAt",
        b.message_count::text as "messageCount",b.content_bytes::text as "contentBytes",
        coalesce((select jsonb_agg(p.value order by p.id) from payload p),'[]'::jsonb) as messages
      from bounds b`,
        [
          threadId,
          CONVERSATION_EXPORT_MAX_MESSAGES + 1,
          CONVERSATION_EXPORT_MAX_MESSAGES,
          CONVERSATION_EXPORT_MAX_BYTES,
        ],
      )
    ).rows[0];
    if (
      !row ||
      !/^\d{1,12}$/.test(row.messageCount) ||
      !/^\d{1,16}$/.test(row.contentBytes)
    )
      throw new DomainError(500, "Не удалось выгрузить весь диалог");
    const tooLarge = () =>
      new DomainError(
        413,
        "Диалог слишком большой для одного файла. Можно скачать отдельные сообщения.",
      );
    if (
      BigInt(row.messageCount) > BigInt(CONVERSATION_EXPORT_MAX_MESSAGES) ||
      BigInt(row.contentBytes) > BigInt(CONVERSATION_EXPORT_MAX_BYTES)
    )
      throw tooLarge();
    const value = {
      version: 1,
      userId,
      generatedAt: row.generatedAt,
      thread,
      messages: row.messages,
    };
    // Count JSON escaping and metadata too, not just database text lengths.
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      CONVERSATION_EXPORT_MAX_BYTES
    )
      throw tooLarge();
    const parsed = conversationExportSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.messages.length !== Number(row.messageCount)
    )
      throw new DomainError(500, "Не удалось выгрузить весь диалог");
    return parsed.data;
  });
}
