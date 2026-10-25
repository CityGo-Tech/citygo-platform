import { createHash } from "node:crypto";
import {
  createPersonalMemoryItemSchema,
  personalMemoryIdSchema,
  personalMemoryItemSchema,
  personalMemoryListSchema,
  removePersonalMemoryItemSchema,
  updatePersonalMemoryItemSchema,
  type CreatePersonalMemoryItem,
  type PersonalMemoryItem,
  type PersonalMemoryList,
  type UpdatePersonalMemoryItem,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

const fields = `p.id::text,p.label,p.value,p.revision::text,
  json_build_object('messageId',m.id::text,'threadId',t.id::text,'role',m.role) as source,
  to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
  to_char(p.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"`;
const ownedSource = `from personal_memory_items p join messages m on m.id=p.source_message_id
  join agent_threads t on t.id=m.thread_id join users u on u.id=p.user_id
  where p.user_id=$1 and t.user_id=$1 and m.role in ('user','assistant')
  and u.status='active' and not u.must_change_password`;
type Stored = Omit<PersonalMemoryItem, "revision"> & {
  revision: string;
  deleted_at?: string | null;
  create_request_hash?: string;
};
const missing = () => new DomainError(404, "Сведение не найдено");
const conflict = (revision: number) =>
  new DomainError(
    409,
    "Сведение изменилось. Обновите память перед сохранением.",
    "REVISION_CONFLICT",
    revision,
  );
function item(row: Stored): PersonalMemoryItem {
  try {
    return personalMemoryItemSchema.parse({
      id: row.id,
      label: row.label,
      value: row.value,
      revision: Number(row.revision),
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch {
    throw new DomainError(500, "Не удалось прочитать память разговора.");
  }
}

/** Only explicit owner-confirmed records; no extraction or financial writes. */
export class PersonalMemory {
  constructor(private readonly db: Database) {}

  async list(userId: string): Promise<PersonalMemoryList> {
    personalMemoryIdSchema.parse(userId);
    const rows = (
      await this.db.query<Stored>(
        `select ${fields} ${ownedSource} and p.deleted_at is null order by p.id desc limit 21`,
        [userId],
      )
    ).rows;
    try {
      return personalMemoryListSchema.parse({ userId, items: rows.map(item) });
    } catch {
      throw new DomainError(500, "Не удалось прочитать память разговора.");
    }
  }

  private async lockOwner(tx: Sql, userId: string) {
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

  async create(userId: string, raw: CreatePersonalMemoryItem) {
    personalMemoryIdSchema.parse(userId);
    const input = createPersonalMemoryItemSchema.parse(raw);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          sourceMessageId: input.sourceMessageId,
          label: input.label,
          value: input.value,
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
            "Эта операция уже использована. Обновите память перед новым действием.",
            "CONFLICT",
          );
        return { userId, item: item(previous) };
      }
      const source = await tx.query(
        `select m.id from messages m join agent_threads t on t.id=m.thread_id
         where m.id=$1 and t.user_id=$2 and m.role in ('user','assistant')
         and coalesce(m.metadata->>'status','complete')='complete'`,
        [input.sourceMessageId, userId],
      );
      if (source.rows.length !== 1) throw missing();
      const count = (
        await tx.query<{ count: number }>(
          "select count(*)::integer as count from personal_memory_items where user_id=$1 and deleted_at is null",
          [userId],
        )
      ).rows[0]!.count;
      if (count >= 20)
        throw new DomainError(
          409,
          "В памяти уже 20 сведений. Удалите неактуальное сведение.",
        );
      const created = (
        await tx.query<{ id: string }>(
          `insert into personal_memory_items(user_id,source_message_id,operation_id,create_request_hash,label,value)
         values($1,$2,$3,$4,$5,$6) returning id::text`,
          [
            userId,
            input.sourceMessageId,
            input.operationId,
            hash,
            input.label,
            input.value,
          ],
        )
      ).rows[0]!;
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

  async update(userId: string, itemId: string, raw: UpdatePersonalMemoryItem) {
    personalMemoryIdSchema.parse(userId);
    personalMemoryIdSchema.parse(itemId);
    const input = updatePersonalMemoryItemSchema.parse(raw);
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
        throw new DomainError(
          409,
          "Достигнут технический предел версий сведения.",
        );
      await tx.query(
        `update personal_memory_items set label=$3,value=$4,revision=revision+1,
         updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
         where user_id=$1 and id=$2 and revision=$5 and deleted_at is null`,
        [userId, itemId, input.label, input.value, revision],
      );
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
    personalMemoryIdSchema.parse(userId);
    personalMemoryIdSchema.parse(itemId);
    removePersonalMemoryItemSchema.parse({ expectedRevision });
    return this.db.transaction(async (tx) => {
      await this.lockOwner(tx, userId);
      const current = (
        await tx.query<Stored>(
          `select ${fields},p.deleted_at ${ownedSource} and p.id=$2 for update of p`,
          [userId, itemId],
        )
      ).rows[0];
      if (!current) throw missing();
      // Tombstones deliberately have no public DTO: deleted text is erased.
      if (!current.deleted_at) {
        item(current);
        const revision = Number(current.revision);
        if (revision !== expectedRevision) throw conflict(revision);
        if (revision === Number.MAX_SAFE_INTEGER)
          throw new DomainError(
            409,
            "Достигнут технический предел версий сведения.",
          );
        await tx.query(
          `with stamp as materialized (select clock_timestamp() as at)
           update personal_memory_items set label='',value='',revision=revision+1,
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
