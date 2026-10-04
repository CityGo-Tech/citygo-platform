import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createR1HousingAnswers,
  r1HousingAnswerCommandSchema,
  r1HousingBriefCreateCommandSchema,
  r1HousingBriefDraftSchema,
  r1HousingIdSchema,
  r1HousingRevisionSchema,
  type QuestPlanReference,
} from "@citygo/contracts";
import { z } from "zod";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";
import { currentQuestPlan } from "./quest-plans.js";

type Content = z.infer<typeof r1HousingBriefDraftSchema>;
export type HousingBriefSnapshot = {
  id: string;
  revision: number;
  plan: QuestPlanReference;
  content: Content;
};
type Command = z.infer<typeof r1HousingAnswerCommandSchema>;
type Create = z.infer<typeof r1HousingBriefCreateCommandSchema>;
type Stored = {
  id: string;
  revision: number;
  plan_id: string;
  plan_version: number;
  content: unknown;
};
const missing = () => new DomainError(404, "Бриф или план не найден");
const conflict = () =>
  new DomainError(
    409,
    "Результат изменился. Загрузите актуальную версию.",
    "REVISION_CONFLICT",
  );

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError(400, "Некорректная команда брифа");
  // JSON wire semantics: omitted optional keys and explicit undefined are equal.
  return JSON.parse(JSON.stringify(result.data)) as T;
}
function snapshot(row: Stored): HousingBriefSnapshot {
  return {
    id: row.id,
    revision: row.revision,
    plan: { id: row.plan_id, version: row.plan_version },
    content: r1HousingBriefDraftSchema.parse(row.content),
  };
}
async function read(tx: Sql, owner: string, id: string, revision?: number) {
  const row = (
    await tx.query<Stored>(
      `select b.id::text,b.plan_id::text,b.plan_version,r.revision,r.content
     from r1_housing_briefs b join r1_housing_brief_revisions r on r.brief_id=b.id
     where b.id=$1 and b.user_id=$2 and ($3::integer is null or r.revision=$3)
     order by r.revision desc limit 1`,
      [id, owner, revision ?? null],
    )
  ).rows[0];
  if (!row) throw missing();
  return snapshot(row);
}

// Internal candidate repository, NOT an HTTP endpoint or an LLM tool. owner must
// come from the authenticated session; models/operators cannot call stateAnswer
// as though they were the user. No runtime grant/route is enabled in CG-012A.
export class HousingAnswers {
  constructor(private readonly db: Database) {}

  async get(owner: string, id: string, revision?: number) {
    parse(r1HousingIdSchema, owner);
    parse(r1HousingIdSchema, id);
    if (revision !== undefined) parse(r1HousingRevisionSchema, revision);
    return read(this.db, owner, id, revision);
  }

  // Same order as existing quest writers: user -> plan -> artifact. Read-only
  // historical reads/replays need no active plan, but new writes always do.
  private async lockOwner(tx: Sql, owner: string) {
    if (
      !(await tx.query("select id from users where id=$1 for update", [owner]))
        .rows.length
    )
      throw missing();
  }

  private async lockPlan(tx: Sql, owner: string, expected: QuestPlanReference) {
    const owned = (
      await tx.query<{ version: number; status: string }>(
        "select version,status from relocation_plans where id=$1 and user_id=$2 for update",
        [expected.id, owner],
      )
    ).rows[0];
    if (!owned) throw missing();
    const current = await currentQuestPlan(tx, owner);
    if (
      owned.version !== expected.version ||
      current?.id !== expected.id ||
      (owned.status !== "active" && owned.status !== "completed")
    )
      throw new DomainError(
        409,
        "План изменился",
        "PLAN_STALE",
        current?.version,
      );
  }

  private async replay(
    tx: Sql,
    owner: string,
    request: Create | Command,
    action: string,
  ) {
    const old = (
      await tx.query<{
        action: string;
        request: unknown;
        brief_id: string;
        result_revision: number;
      }>(
        "select action,request,brief_id::text,result_revision from r1_housing_commands where user_id=$1 and command_id=$2",
        [owner, request.commandId],
      )
    ).rows[0];
    if (!old) return;
    if (old.action !== action || !isDeepStrictEqual(old.request, request))
      throw new DomainError(
        409,
        "ID команды уже использован для другого действия",
      );
    return read(tx, owner, old.brief_id, old.result_revision);
  }

  async create(owner: string, input: unknown): Promise<HousingBriefSnapshot> {
    parse(r1HousingIdSchema, owner);
    const request = parse(r1HousingBriefCreateCommandSchema, input);
    return this.db.transaction(async (tx) => {
      await this.lockOwner(tx, owner);
      const replay = await this.replay(tx, owner, request, "create_brief");
      if (replay) return replay;
      await this.lockPlan(tx, owner, request.plan);
      const row = (
        await tx.query<{ id: string }>(
          "insert into r1_housing_briefs(user_id,plan_id,plan_version) values ($1,$2,$3) returning id::text",
          [owner, request.plan.id, request.plan.version],
        )
      ).rows[0]!;
      const content = r1HousingBriefDraftSchema.parse({
        schemaVersion: 1,
        kind: "housing_brief",
        purpose: "rental_search_preparation",
        destination: { countryCode: "RU", cityCode: "RU-MOW" },
        answers: createR1HousingAnswers(),
        suggestions: [],
        starterPlan: null,
      });
      const event = randomUUID();
      await tx.query(
        `insert into r1_housing_commands(user_id,command_id,event_id,action,actor,source,request,brief_id,result_revision)
         values ($1,$2,$3,'create_brief','user','explicit_command',$4,$5,1)`,
        [owner, request.commandId, event, JSON.stringify(request), row.id],
      );
      await this.append(tx, row.id, 1, event, content);
      return { id: row.id, revision: 1, plan: request.plan, content };
    });
  }

  async stateAnswer(
    owner: string,
    input: unknown,
  ): Promise<HousingBriefSnapshot> {
    parse(r1HousingIdSchema, owner);
    const request = parse(r1HousingAnswerCommandSchema, input);
    return this.db.transaction(async (tx) => {
      await this.lockOwner(tx, owner);
      const replay = await this.replay(tx, owner, request, "state_answer");
      if (replay) return replay;
      const current = await read(tx, owner, request.brief.id);
      if (!isDeepStrictEqual(current.plan, request.plan)) throw missing();
      await this.lockPlan(tx, owner, request.plan);
      const { field, answer, expectedFieldRevision } = request.change;
      const before = current.content.answers[field];
      if (
        current.revision !== request.brief.revision ||
        before.revision !== expectedFieldRevision
      )
        throw conflict();
      if (current.revision === 2147483647 || before.revision === 2147483647)
        throw conflict();
      const event = randomUUID();
      const after = {
        ...answer,
        revision: before.revision + 1,
        provenance: { kind: "user_stated", eventId: event },
      };
      // No proposals/results writer in this increment. Do not silently discard
      // their future history or invalidate a starter plan without dependency rules.
      if (
        current.content.starterPlan !== null ||
        current.content.suggestions.length
      )
        throw new DomainError(
          409,
          "Этот бриф требует команды обновления результата",
        );
      const content = r1HousingBriefDraftSchema.parse({
        ...current.content,
        answers: { ...current.content.answers, [field]: after },
      });
      const revision = current.revision + 1;
      await tx.query(
        `insert into r1_housing_commands(user_id,command_id,event_id,action,actor,source,request,brief_id,result_revision,field,before_answer,after_answer)
         values ($1,$2,$3,'state_answer','user','explicit_command',$4,$5,$6,$7,$8,$9)`,
        [
          owner,
          request.commandId,
          event,
          JSON.stringify(request),
          current.id,
          revision,
          field,
          JSON.stringify(before),
          JSON.stringify(content.answers[field]),
        ],
      );
      await this.append(tx, current.id, revision, event, content);
      return { ...current, revision, content };
    });
  }

  private async append(
    tx: Sql,
    id: string,
    revision: number,
    event: string,
    content: Content,
  ) {
    await tx.query(
      "insert into r1_housing_brief_revisions(brief_id,revision,event_id,content) values ($1,$2,$3,$4)",
      [id, revision, event, JSON.stringify(content)],
    );
  }
}
