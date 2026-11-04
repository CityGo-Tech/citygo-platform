import {
  chatTextProblem,
  conversationHistoryIdSchema,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

const partSize = 1000;
const maximumSourceBytes = 400_000;
const maximumFragments = 32;
const maximumMemoryBytes = 128_000;
const missing = () => new DomainError(404, "Чат не найден");
const corrupt = () =>
  new DomainError(503, "Не удалось проверить сохранённые источники диалога.");

export type ConversationMemoryFragment = {
  messageId: string;
  content: string;
  start: number;
  end: number;
  sourceSha256: string;
};
export type ConversationMemorySnapshot = {
  fragments: ConversationMemoryFragment[];
  /** True only when every eligible quotation is returned, not just indexed. */
  complete: boolean;
  indexComplete: boolean;
  indexedMessages: number;
};

/** Called inside the existing user -> thread admission transaction. The caller
 * supplies identity only; quotation bytes and hash are read from the database. */
export async function indexConversationMemoryMessage(
  tx: Sql,
  userId: string,
  threadId: string,
  messageId: string,
) {
  for (const id of [userId, threadId, messageId])
    conversationHistoryIdSchema.parse(id);
  const result = await tx.query<{ message_id: string }>(
    `with source as materialized (
       select m.id,m.content,encode(sha256(convert_to(m.content,'UTF8')),'hex') as hash
       from messages m join agent_threads t on t.id=m.thread_id
       where t.user_id=$1 and t.id=$2 and m.id=$3 and m.role='user'
         and coalesce(m.metadata->>'status','complete')='complete'
         and char_length(m.content)>0 and octet_length(m.content)<=$4
     )
     insert into conversation_memory_fragments
       (message_id,ordinal,user_id,thread_id,source_sha256,start_offset,end_offset,content)
     select s.id,p,$1,$2,s.hash,p*$5,least(char_length(s.content),(p+1)*$5),
       substring(s.content from p*$5+1 for $5)
     from source s cross join lateral generate_series(0,(char_length(s.content)-1)/$5) p
     order by s.id,p on conflict(message_id,source_sha256,ordinal) do nothing returning message_id::text`,
    [userId, threadId, messageId, maximumSourceBytes, partSize],
  );
  return result.rows.length;
}

type Candidate = ConversationMemoryFragment & { valid: boolean };
const columns = `f.message_id::text as "messageId",f.content,
  f.start_offset as start,f.end_offset as end,f.source_sha256 as "sourceSha256",
  (f.content=substring(s.content from f.start_offset+1 for f.end_offset-f.start_offset)
   and f.end_offset<=s.characters) as valid`;
const eligible = `m.thread_id=$2 and m.role='user'
  and coalesce(m.metadata->>'status','complete')='complete'
  and octet_length(m.content)>0 and ($3::bigint is null or m.id<$3::bigint)`;
// Never hash the complete original once per quotation. The bounded source CTE is
// materialized once per read. Its ordered quotation hash proves the whole index;
// selected quotations are additionally checked against their exact source slice.
// A very long conversation remains stored in full, but its snapshot is honestly
// partial whenever this source/byte window cannot verify the entire history.
const verifiedSources = `with lexical_candidates as materialized (
    select f.message_id,ts_rank_cd(f.search_vector,to_tsquery('pg_catalog.russian',$4)) as rank
    from conversation_memory_fragments f
    where f.user_id=$1 and f.thread_id=$2 and $4<>''
      and ($3::bigint is null or f.message_id<$3::bigint)
      and f.search_vector @@ to_tsquery('pg_catalog.russian',$4)
    order by rank desc,f.message_id desc,f.ordinal asc limit 128
  ), source_ids as materialized (
    select id,min(priority) as priority from (
      (select m.id,0 as priority from messages m where ${eligible} order by m.id desc limit 4)
      union all
      (select message_id as id,1 as priority from lexical_candidates group by message_id
        order by max(rank) desc,message_id desc limit 16)
      union all
      (select m.id,2 as priority from messages m where ${eligible} order by m.id asc limit 8)
      union all
      (select m.id,3 as priority from messages m where ${eligible} order by m.id desc limit 256)
    ) chosen group by id
  ), source_sizes as materialized (
    select m.id,i.priority,octet_length(m.content) as bytes
    from source_ids i join messages m on m.id=i.id
    join agent_threads t on t.id=m.thread_id and t.user_id=$1
    where ${eligible}
  ), bounded_ids as materialized (
    select id,bytes from (select id,bytes,
      sum(bytes) over(order by priority,id desc) as cumulative_bytes from source_sizes) sized
    where cumulative_bytes<=33554432
  ), sources as materialized (
    select m.id,m.content,b.bytes,char_length(m.content) as characters,
      encode(sha256(convert_to(m.content,'UTF8')),'hex') as hash
    from bounded_ids b join messages m on m.id=b.id
  ), indexed as materialized (
    select s.id,count(*)::int as parts,min(f.ordinal) as first_ordinal,
      max(f.ordinal) as last_ordinal,max(f.end_offset) as last_end,
      bool_and(f.end_offset-f.start_offset=1000 or f.end_offset=s.characters) as full_parts,
      encode(sha256(convert_to(string_agg(f.content,'' order by f.ordinal),'UTF8')),'hex') as hash
    from sources s join conversation_memory_fragments f
      on f.message_id=s.id and f.source_sha256=s.hash and f.user_id=$1 and f.thread_id=$2
    group by s.id
  ), verified as materialized (
    select s.*,coalesce(i.parts=(s.characters+999)/1000 and i.first_ordinal=0
      and i.last_ordinal=i.parts-1 and i.last_end=s.characters
      and i.full_parts and i.hash=s.hash,false) as indexed,i.parts
    from sources s left join indexed i on i.id=s.id
  )`;
const scope = `from conversation_memory_fragments f join verified s
  on s.id=f.message_id and s.hash=f.source_sha256 and s.indexed
  where f.user_id=$1 and f.thread_id=$2`;

/** Persistent exact quotations from one private conversation. Lexical selection
 * is deterministic and bounded; it is not a model-generated fact store. */
export class ConversationMemory {
  constructor(private readonly db: Database) {}

  async snapshot(
    userId: string,
    threadId: string,
    query: string,
    options: { beforeMessageId?: string; readOnly?: boolean } = {},
  ): Promise<ConversationMemorySnapshot> {
    for (const id of [userId, threadId]) conversationHistoryIdSchema.parse(id);
    if (options.beforeMessageId !== undefined)
      conversationHistoryIdSchema.parse(options.beforeMessageId);
    if (typeof query !== "string" || chatTextProblem(query) !== null)
      throw new DomainError(400, "Недопустимый текст поиска по диалогу");
    return this.db.transaction(async (tx) => {
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
            "select id from agent_threads where user_id=$1 and id=$2 for share",
            [userId, threadId],
          )
        ).rows.length
      )
        throw missing();
      const terms = new Set<string>();
      for (const match of query
        .toLowerCase()
        .matchAll(/[\p{L}\p{N}]{2,64}/gu)) {
        terms.add(match[0]);
        if (terms.size >= 32) break;
      }
      const parameters = [
        userId,
        threadId,
        options.beforeMessageId ?? null,
        [...terms].join(" | "),
      ];
      if (
        options.beforeMessageId !== undefined &&
        !(
          await tx.query(
            "select id from messages where thread_id=$1 and id=$2 and role='user' and coalesce(metadata->>'status','complete')='complete'",
            [threadId, options.beforeMessageId],
          )
        ).rows.length
      )
        throw missing();

      // Bounded lazy backfill reaches both the original conditions and newest
      // corrections. Each transaction completes every selected source atomically.
      if (!options.readOnly) {
        const pending = await tx.query<{ id: string; bytes: number }>(
          `/* conversation-memory-pending */ ${verifiedSources}
          (select q.id::text,q.bytes from (select id,bytes from verified where not indexed order by id asc limit 8) q)
          union
          (select q.id::text,q.bytes from (select id,bytes from verified where not indexed order by id desc limit 8) q)`,
          parameters,
        );
        let backfillBytes = 0;
        for (const row of pending.rows.sort((a, b) =>
          BigInt(a.id) < BigInt(b.id)
            ? -1
            : BigInt(a.id) > BigInt(b.id)
              ? 1
              : 0,
        )) {
          if (
            row.bytes > maximumSourceBytes ||
            backfillBytes + row.bytes > 1_000_000
          )
            continue;
          backfillBytes += row.bytes;
          await indexConversationMemoryMessage(tx, userId, threadId, row.id);
        }
      }

      // First and last quotations from each of the four newest sources preserve
      // explicit late corrections even when a source message is very long. All
      // selections/totals share one verified source materialization.
      const selection = (
        await tx.query<{
          candidates: Candidate[];
          fragments: number;
          messages: number;
          index_complete: boolean;
        }>(
          `/* conversation-memory-snapshot */ ${verifiedSources}, candidate_ids as materialized (
          (select 1 as priority,q.* from (select distinct on(f.message_id)
              f.message_id,f.source_sha256,f.ordinal ${scope}
            order by f.message_id desc,f.ordinal asc limit 4) q)
          union all
          (select 2 as priority,q.* from (select distinct on(f.message_id)
              f.message_id,f.source_sha256,f.ordinal ${scope}
            order by f.message_id desc,f.ordinal desc limit 4) q)
          union all
          (select 3 as priority,f.message_id,f.source_sha256,f.ordinal ${scope} and $4<>''
              and f.search_vector @@ to_tsquery('pg_catalog.russian',$4)
            order by ts_rank_cd(f.search_vector,to_tsquery('pg_catalog.russian',$4)) desc,
              f.message_id desc,f.ordinal asc limit 16)
          union all
          (select 4 as priority,f.message_id,f.source_sha256,f.ordinal ${scope}
            order by f.message_id asc,f.ordinal asc limit 8)
        ), candidates as materialized (
          select c.priority,${columns} from candidate_ids c
          join conversation_memory_fragments f on f.message_id=c.message_id
            and f.source_sha256=c.source_sha256 and f.ordinal=c.ordinal
          join verified s on s.id=f.message_id and s.hash=f.source_sha256 and s.indexed
          where f.user_id=$1 and f.thread_id=$2
        ) select
          coalesce((select jsonb_agg(to_jsonb(c) order by priority,"messageId"::bigint desc,start)
            from candidates c),'[]'::jsonb) as candidates,
          coalesce((select sum(parts)::int from verified where indexed),0) as fragments,
          (select count(*)::int from verified where indexed) as messages,
          (select count(*) from verified where indexed)=
            (select count(*) from messages m where ${eligible}) as index_complete`,
          parameters,
        )
      ).rows[0]!;
      const unique = new Map<string, ConversationMemoryFragment>();
      let bytes = 0;
      let invalidSource = false;
      for (const candidate of selection.candidates) {
        if (!candidate.valid) {
          invalidSource = true;
          continue;
        }
        const fragment: ConversationMemoryFragment = {
          messageId: candidate.messageId,
          content: candidate.content,
          start: candidate.start,
          end: candidate.end,
          sourceSha256: candidate.sourceSha256,
        };
        const key = fragment.messageId + ":" + fragment.start;
        if (unique.has(key)) continue;
        const size = Buffer.byteLength(fragment.content, "utf8");
        if (size > 4000 || Array.from(fragment.content).length > partSize)
          throw corrupt();
        if (
          unique.size >= maximumFragments ||
          bytes + size > maximumMemoryBytes
        )
          continue;
        bytes += size;
        unique.set(key, fragment);
      }
      return {
        fragments: [...unique.values()],
        complete:
          !invalidSource &&
          selection.index_complete &&
          selection.fragments === unique.size,
        indexComplete: !invalidSource && selection.index_complete,
        indexedMessages: selection.messages,
      };
    });
  }
}
