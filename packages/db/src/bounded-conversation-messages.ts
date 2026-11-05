import { validateWebSourcesForAnswer, type Message } from "@citygo/contracts";
import type { Sql } from "./index.js";
import { DomainError } from "./errors.js";

export const CONVERSATION_PAGE_CONTENT_BYTES = 524288;
export const CONVERSATION_CONTEXT_CONTENT_BYTES = 8388608;
export type ConversationHistoryByteLimit =
  | typeof CONVERSATION_PAGE_CONTENT_BYTES
  | typeof CONVERSATION_CONTEXT_CONTENT_BYTES;
const maximumSingleLegacyCharacters = 1024 * 1024;

export function conversationHistoryByteLimit(
  value: ConversationHistoryByteLimit = CONVERSATION_PAGE_CONTENT_BYTES,
) {
  if (
    value !== CONVERSATION_PAGE_CONTENT_BYTES &&
    value !== CONVERSATION_CONTEXT_CONTENT_BYTES
  )
    throw new DomainError(400, "Недопустимый предел истории диалога");
  return value;
}

/** Bound aggregate text before fetching it through the database driver. The
 * cursor always precedes the oldest returned row, including byte-limited pages. */
export async function readBoundedConversationMessages(
  tx: Sql,
  threadId: string,
  beforeId?: string,
  inclusive = false,
  limit = 100,
  inputMaxBytes?: ConversationHistoryByteLimit,
) {
  const maxBytes = conversationHistoryByteLimit(inputMaxBytes);
  const expectedLimit =
    maxBytes === CONVERSATION_CONTEXT_CONTENT_BYTES ? 256 : 100;
  if (limit !== expectedLimit)
    throw new DomainError(400, "Недопустимый размер страницы истории");
  const candidates = (
    await tx.query<{ id: string; bytes: number; characters: number }>(
      `select m.id::text,(octet_length(m.content)+coalesce(octet_length((m.metadata->'generation')::text),0))::int as bytes,
         char_length(m.content) as characters from messages m
       where m.thread_id=$1 and m.role in('user','assistant')
         and ($2::bigint is null or m.id${inclusive ? "<=" : "<"}$2::bigint)
       order by m.id desc limit $3`,
      [threadId, beforeId ?? null, limit + 1],
    )
  ).rows;
  const ids: string[] = [];
  let bytes = 0;
  let singleLegacy = false;
  for (const row of candidates) {
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0)
      throw new DomainError(503, "Не удалось проверить размер истории");
    if (
      !ids.length &&
      row.bytes > maxBytes &&
      Number.isSafeInteger(row.characters) &&
      row.characters <= maximumSingleLegacyCharacters &&
      row.bytes <= 4 * maximumSingleLegacyCharacters
    ) {
      ids.push(row.id);
      singleLegacy = true;
      break;
    }
    if (ids.length >= limit || bytes + row.bytes > maxBytes) break;
    ids.push(row.id);
    bytes += row.bytes;
  }
  if (candidates.length && !ids.length)
    throw new DomainError(
      413,
      "Сообщение слишком большое для просмотра истории",
    );
  if (!ids.length) return { messages: [] as Message[], nextCursor: null };
  const rows = (
    await tx.query<Message>(
      `select m.id::text,m.role,m.content,coalesce(m.metadata->>'agentKey','housing') as "agentKey",
        coalesce(m.metadata->>'status','complete') as status,m.metadata->'generation' as generation,
        m.metadata->>'failureCode' as "failureCode",
        (m.metadata->'citygoFavorite'='true'::jsonb) is true as favorite
       from messages m where m.thread_id=$1 and m.id=any($2::bigint[])
         and m.role in('user','assistant') order by m.id desc`,
      [threadId, ids],
    )
  ).rows;
  for (const row of rows) {
    if (row.generation?.webSources === undefined) continue;
    if (
      row.role !== "assistant" ||
      row.status !== "complete" ||
      row.generation.provider !== "routerai" ||
      row.generation.requestedModel !== "openai/gpt-6.1-sol" ||
      row.generation.model !== "openai/gpt-6.1-sol"
    )
      throw new DomainError(
        503,
        "Не удалось проверить источники сохранённого ответа",
      );
    try {
      row.generation = {
        ...row.generation,
        webSources: validateWebSourcesForAnswer(
          row.generation.webSources,
          row.content,
        ),
      };
    } catch {
      throw new DomainError(
        503,
        "Не удалось проверить источники сохранённого ответа",
      );
    }
  }
  if (
    rows.length !== ids.length ||
    rows.some((row, index) => row.id !== ids[index]) ||
    (singleLegacy
      ? rows.length !== 1 ||
        rows[0]!.content.length > maximumSingleLegacyCharacters ||
        Buffer.byteLength(JSON.stringify(rows[0]), "utf8") > 7 * 1024 * 1024
      : rows.reduce(
          (total, row) =>
            total +
            Buffer.byteLength(row.content, "utf8") +
            (row.generation == null
              ? 0
              : Buffer.byteLength(JSON.stringify(row.generation), "utf8")),
          0,
        ) > maxBytes)
  )
    throw new DomainError(
      503,
      "История изменилась во время чтения. Обновите страницу.",
    );
  return {
    messages: rows.reverse(),
    nextCursor: candidates.length > ids.length ? ids.at(-1)! : null,
  };
}
