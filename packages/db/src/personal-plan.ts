import { createHash } from "node:crypto";
import {
  createPersonalPlanItemSchema,
  personalPlanIdSchema,
  personalPlanItemSchema,
  personalPlanQuerySchema,
  personalPlanSummarySchema,
  removePersonalPlanItemSchema,
  updatePersonalPlanItemSchema,
  type CreatePersonalPlanItem,
  type PersonalPlanItem,
  type PersonalPlanPage,
  type PersonalPlanStatus,
  type PersonalPlanSummary,
  type UpdatePersonalPlanItem,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";
import { recordPersonalPlanRevision } from "./personal-plan-history.js";

const MAX_ACTIVE_ITEMS = 200;
const fields = `p.id::text,p.title,p.details,p.status,p.revision::text,
  case when p.source_message_id is null then null else json_build_object('messageId',m.id::text,'threadId',t.id::text,'role',m.role) end as source,
  to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
  to_char(p.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"`;
const ownedSource = `from personal_plan_items p left join messages m on m.id=p.source_message_id
  left join agent_threads t on t.id=m.thread_id
  join users u on u.id=p.user_id
  where p.user_id=$1 and (p.source_message_id is null or (t.user_id=$1 and m.role in ('user','assistant')))
  and u.status='active' and not u.must_change_password`;
type Stored = Omit<PersonalPlanItem, "revision"> & {
  revision: string;
  deleted_at?: string | null;
  create_request_hash?: string;
};
const missing = () => new DomainError(404, "Шаг плана не найден");
const conflict = (revision: number) =>
  new DomainError(
    409,
    "Шаг плана изменился. Обновите план перед сохранением.",
    "REVISION_CONFLICT",
    revision,
  );
function item(row: Stored): PersonalPlanItem {
  // Parse the public shape explicitly: never expose hashes or tombstones.
  try {
    return personalPlanItemSchema.parse({
      id: row.id,
      title: row.title,
      details: row.details,
      status: row.status,
      revision: Number(row.revision),
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch {
    // Stored corruption is a server failure, not a bad client DTO. Never leak
    // row contents or let the API misclassify this as an input-validation 400.
    throw new DomainError(500, "Не удалось прочитать личный план.");
  }
}

/** User-confirmed actions only. No profile, AI, financial or quest operations. */
export class PersonalPlan {
  constructor(private readonly db: Database) {}

  async list(
    userId: string,
    before?: string,
    status?: PersonalPlanStatus,
    search?: string,
  ): Promise<PersonalPlanPage> {
    personalPlanIdSchema.parse(userId);
    const query = personalPlanQuerySchema.parse({ before, status, search });
    const rows = (
      await this.db.query<Stored>(
        `select ${fields} ${ownedSource} and p.deleted_at is null
         and ($2::bigint is null or p.id<$2::bigint)
         and ($3::text is null or p.status=$3::text)
         and ($4::text is null or position(lower($4::text) in lower(p.title || E'\\n' || p.details))>0)
         order by p.id desc limit 21`,
        [
          userId,
          query.before ?? null,
          query.status ?? null,
          query.search ?? null,
        ],
      )
    ).rows;
    const items = rows.slice(0, 20).map(item);
    return {
      userId,
      items,
      nextBefore: rows.length > 20 ? items.at(-1)!.id : null,
    };
  }

  async summary(userId: string): Promise<PersonalPlanSummary> {
    personalPlanIdSchema.parse(userId);
    // Same visibility as list(), over every page. A single aggregate snapshot
    // cannot mix counts from concurrent edits, removals or source changes.
    const counts = (
      await this.db.query<{
        total: number;
        pending: number;
        completed: number;
      }>(
        `select count(*)::integer as total,
       count(*) filter(where p.status='pending')::integer as pending,
       count(*) filter(where p.status='completed')::integer as completed
       ${ownedSource} and p.deleted_at is null`,
        [userId],
      )
    ).rows[0];
    try {
      return personalPlanSummarySchema.parse({ userId, ...counts });
    } catch {
      throw new DomainError(500, "Не удалось прочитать личный план.");
    }
  }

  private async lockOwner(tx: Sql, userId: string) {
    // All writers use user -> item order. This serializes capacity and replay
    // across real PostgreSQL connections without locks spanning external I/O.
    const owner = (
      await tx.query<{ status: string; must_change_password: boolean }>(
        "select status,must_change_password from users where id=$1 for update",
        [userId],
      )
    ).rows[0];
    if (!owner || owner.status !== "active")
      throw new DomainError(401, "Войдите в аккаунт");
    if (owner.must_change_password)
      throw new DomainError(403, "Сначала смените временный пароль");
  }

  async create(userId: string, raw: CreatePersonalPlanItem) {
    personalPlanIdSchema.parse(userId);
    const input = createPersonalPlanItemSchema.parse(raw);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          sourceMessageId: input.sourceMessageId,
          title: input.title,
          details: input.details,
        }),
      )
      .digest("hex");
    return this.db.transaction(async (tx) => {
      await this.lockOwner(tx, userId);
      const previous = (
        await tx.query<Stored>(
          `select ${fields},p.deleted_at,p.create_request_hash ${ownedSource}
           and p.operation_id=$2::uuid for update of p`,
          [userId, input.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.create_request_hash !== hash || previous.deleted_at)
          throw new DomainError(
            409,
            "Эта операция уже использована. Обновите план перед новым действием.",
            "CONFLICT",
          );
        return { userId, item: item(previous) };
      }
      const source =
        input.sourceMessageId === null
          ? null
          : await tx.query(
              `select m.id from messages m join agent_threads t on t.id=m.thread_id
         where m.id=$1 and t.user_id=$2 and m.role in ('user','assistant')`,
              [input.sourceMessageId, userId],
            );
      if (source !== null && source.rows.length !== 1) throw missing();
      const count = (
        await tx.query<{ count: number }>(
          "select count(*)::integer as count from personal_plan_items where user_id=$1 and deleted_at is null",
          [userId],
        )
      ).rows[0]!.count;
      if (count >= MAX_ACTIVE_ITEMS)
        throw new DomainError(
          409,
          "В личном плане уже 200 шагов. Удалите ненужный шаг.",
        );
      const created = (
        await tx.query<{ id: string }>(
          `insert into personal_plan_items(user_id,source_message_id,operation_id,create_request_hash,title,details)
           values($1,$2,$3,$4,$5,$6) returning id::text`,
          [
            userId,
            input.sourceMessageId,
            input.operationId,
            hash,
            input.title,
            input.details,
          ],
        )
      ).rows[0]!;
      await recordPersonalPlanRevision(tx, created.id);
      const row = (
        await tx.query<Stored>(`select ${fields} ${ownedSource} and p.id=$2`, [
          userId,
          created.id,
        ])
      ).rows[0];
      if (!row) throw missing();
      return { userId, item: item(row) };
    });
  }

  async update(userId: string, itemId: string, raw: UpdatePersonalPlanItem) {
    personalPlanIdSchema.parse(userId);
    personalPlanIdSchema.parse(itemId);
    const input = updatePersonalPlanItemSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.lockOwner(tx, userId);
      const current = (
        await tx.query<Stored>(
          `select ${fields} ${ownedSource} and p.id=$2 and p.deleted_at is null for update of p`,
          [userId, itemId],
        )
      ).rows[0];
      if (!current) throw missing();
      item(current);
      const revision = Number(current.revision);
      if (revision !== input.expectedRevision) throw conflict(revision);
      if (revision === Number.MAX_SAFE_INTEGER)
        throw new DomainError(409, "Достигнут технический предел версий шага.");
      await tx.query(
        `update personal_plan_items set title=$3,details=$4,status=$5,revision=revision+1,
         updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
         where user_id=$1 and id=$2 and revision=$6 and deleted_at is null`,
        [userId, itemId, input.title, input.details, input.status, revision],
      );
      await recordPersonalPlanRevision(tx, itemId);
      const row = (
        await tx.query<Stored>(`select ${fields} ${ownedSource} and p.id=$2`, [
          userId,
          itemId,
        ])
      ).rows[0];
      if (!row) throw missing();
      return { userId, item: item(row) };
    });
  }

  async remove(userId: string, itemId: string, expectedRevision: number) {
    personalPlanIdSchema.parse(userId);
    personalPlanIdSchema.parse(itemId);
    removePersonalPlanItemSchema.parse({ expectedRevision });
    return this.db.transaction(async (tx) => {
      await this.lockOwner(tx, userId);
      const current = (
        await tx.query<Stored>(
          `select ${fields},p.deleted_at ${ownedSource} and p.id=$2 for update of p`,
          [userId, itemId],
        )
      ).rows[0];
      if (!current) throw missing();
      item(current);
      if (!current.deleted_at) {
        const revision = Number(current.revision);
        if (revision !== expectedRevision) throw conflict(revision);
        if (revision === Number.MAX_SAFE_INTEGER)
          throw new DomainError(
            409,
            "Достигнут технический предел версий шага.",
          );
        await tx.query(
          `with stamp as materialized (select clock_timestamp() as at)
           update personal_plan_items set revision=revision+1,
           updated_at=greatest(stamp.at,updated_at+interval '1 microsecond'),
           deleted_at=greatest(stamp.at,updated_at+interval '1 microsecond')
           from stamp where user_id=$1 and id=$2 and revision=$3 and deleted_at is null`,
          [userId, itemId, revision],
        );
      }
      return { userId, itemId, removed: true as const };
    });
  }
}
