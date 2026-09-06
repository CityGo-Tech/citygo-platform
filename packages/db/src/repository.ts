import type { Database, Sql } from "./index.js";
import type {
  AgentKey,
  Dashboard,
  Message,
  Questionnaire,
  Quest,
  ModelGeneration,
} from "@citygo/contracts";
import { randomUUID } from "node:crypto";
import { canTransitionQuest } from "@citygo/domain";

export class DomainError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new DomainError(status, message);
};
type User = { id: string; email: string; password_hash: string };
type Thread = { id: string; agent_key: AgentKey; busy_until: string | null };
export class Repository {
  constructor(public db: Database) {}
  async register(email: string, passwordHash: string) {
    return this.db.transaction(async (tx) => {
      const user = (
        await tx.query<{ id: string }>(
          "insert into users(auth_subject) values ($1) returning id::text",
          [randomUUID()],
        )
      ).rows[0]!;
      await tx.query(
        "insert into user_credentials(user_id,email,password_hash) values ($1,$2,$3)",
        [user.id, email, passwordHash],
      );
      return user.id;
    });
  }
  async credentials(email: string): Promise<User | undefined> {
    return (
      await this.db.query<User>(
        "select u.id::text,c.email,c.password_hash from users u join user_credentials c on c.user_id=u.id where c.email=$1 and u.status='active'",
        [email],
      )
    ).rows[0];
  }
  async session(tokenHash: string) {
    return (
      await this.db.query<{ id: string; email: string }>(
        "select u.id::text,c.email from sessions s join users u on u.id=s.user_id join user_credentials c on c.user_id=u.id where s.token_hash=$1 and s.expires_at>now() and u.status='active'",
        [tokenHash],
      )
    ).rows[0];
  }
  async createSession(userId: string, tokenHash: string) {
    await this.db.query(
      "insert into sessions(token_hash,user_id,expires_at) values ($1,$2,now()+interval '7 days')",
      [tokenHash, userId],
    );
  }
  async logout(tokenHash: string) {
    await this.db.query("delete from sessions where token_hash=$1", [
      tokenHash,
    ]);
  }
  async dashboard(
    user: { id: string; email: string },
    provider: Dashboard["provider"],
  ): Promise<Dashboard> {
    return this.db.transaction(async (tx) => {
      const profile =
        (
          await tx.query<{ preferences: Questionnaire }>(
            "select preferences from relocation_profiles where user_id=$1",
            [user.id],
          )
        ).rows[0]?.preferences ?? null;
      const xp = (
        await tx.query<{ xp: number }>(
          "select coalesce(sum(points),0)::integer as xp from xp_events where user_id=$1",
          [user.id],
        )
      ).rows[0]!.xp;
      const quests = (
        await tx.query<Quest>(
          'select uq.id::text,q.slug,q.title,uq.state,q.xp_reward as "xpReward" from user_quests uq join quests q on q.id=uq.quest_id where uq.user_id=$1 order by q.id',
          [user.id],
        )
      ).rows;
      const thread = (
        await tx.query<Thread>(
          "select id::text,agent_key from agent_threads where user_id=$1 and status<>'closed'",
          [user.id],
        )
      ).rows[0];
      const messages = thread ? await this.history(tx, thread.id) : [];
      return {
        user,
        profile,
        xp,
        quests,
        thread: thread
          ? { id: thread.id, agentKey: thread.agent_key, messages }
          : null,
        provider,
      };
    });
  }
  async history(tx: Sql, threadId: string): Promise<Message[]> {
    const rows = (
      await tx.query<Message>(
        `select id::text,role,content,coalesce(metadata->>'agentKey','housing') as "agentKey",
      coalesce(metadata->>'status','complete') as status, metadata->'generation' as generation
      from messages where thread_id=$1 and role in ('user','assistant')
      order by id desc limit 100`,
        [threadId],
      )
    ).rows;
    return rows.reverse();
  }
  async questionnaire(userId: string, profile: Questionnaire) {
    return this.db.transaction(async (tx) => {
      await tx.query("select id from users where id=$1 for update", [userId]);
      const exists = (
        await tx.query("select id from relocation_profiles where user_id=$1", [
          userId,
        ])
      ).rows[0];
      if (exists) fail(409, "Анкета уже сохранена");
      await tx.query(
        "insert into relocation_profiles(user_id,origin_city,target_city,monthly_budget,move_target_date,preferences) values ($1,$2,$3,$4,$5,$6)",
        [
          userId,
          profile.originCity,
          profile.targetCity,
          profile.monthlyBudget,
          profile.moveTargetDate,
          JSON.stringify(profile),
        ],
      );
      for (const [key, value] of Object.entries(profile))
        await tx.query(
          "insert into questionnaire_answers(user_id,question_key,answer) values ($1,$2,$3)",
          [userId, key, JSON.stringify(value)],
        );
      await tx.query(
        "insert into consent_events(user_id,consent_key,action,policy_version) values ($1,'ai-profile-processing','granted','2026-09-mvp')",
        [userId],
      );
      await tx.query(
        "insert into relocation_plans(user_id,status,plan) values ($1,'active',$2)",
        [
          userId,
          JSON.stringify({
            targetCity: profile.targetCity,
            stages: ["housing-brief", "housing-viewing"],
          }),
        ],
      );
      await tx.query(
        `insert into user_quests(user_id,quest_id,state) select $1,id,case when slug='housing-brief' then 'available' else 'locked' end from quests where slug in ('housing-brief','housing-viewing')`,
        [userId],
      );
      await tx.query(
        "insert into analytics_events(user_id,name) values ($1,'questionnaire_completed')",
        [userId],
      );
    });
  }
  async start(userId: string, questId: string) {
    return this.db.transaction(async (tx) => {
      const quest =
        (
          await tx.query<{ state: Quest["state"] }>(
            "select state from user_quests where id=$1 and user_id=$2 for update",
            [questId, userId],
          )
        ).rows[0] ?? fail(404, "Квест не найден");
      if (
        quest.state !== "in_progress" &&
        !canTransitionQuest(quest.state, "in_progress")
      )
        fail(409, "Квест пока недоступен");
      await tx.query(
        "update user_quests set state='in_progress',started_at=coalesce(started_at,now()),updated_at=now() where id=$1",
        [questId],
      );
      const thread = (
        await tx.query<{ id: string }>(
          "insert into agent_threads(user_id,agent_key) values ($1,'housing') on conflict (user_id) where status<>'closed' do update set agent_key=case when $2 then 'housing' else agent_threads.agent_key end,updated_at=now() returning id::text",
          [userId, quest.state === "available"],
        )
      ).rows[0]!;
      return thread;
    });
  }
  async complete(userId: string, questId: string) {
    return this.db.transaction(async (tx) => {
      const q =
        (
          await tx.query<{
            id: string;
            state: Quest["state"];
            slug: string;
            xp_reward: number;
          }>(
            "select uq.id::text,uq.state,q.slug,q.xp_reward from user_quests uq join quests q on q.id=uq.quest_id where uq.id=$1 and uq.user_id=$2 for update of uq",
            [questId, userId],
          )
        ).rows[0] ?? fail(404, "Квест не найден");
      if (q.state === "completed") return { awarded: 0 };
      if (!canTransitionQuest(q.state, "completed"))
        fail(409, "Сначала начните квест");
      const advice = (
        await tx.query(
          `select m.id from messages m join agent_threads t on t.id=m.thread_id
        where t.user_id=$1 and m.role='assistant' and m.metadata->>'agentKey'='housing' and m.metadata->>'status'='complete' and m.metadata->>'source'='model'
        and m.created_at >= (select started_at from user_quests where id=$2) limit 1`,
          [userId, questId],
        )
      ).rows[0];
      if (!advice) fail(409, "Сначала обсудите критерии с Housing Navigator");
      await tx.query(
        "update user_quests set state='completed',completed_at=now(),updated_at=now() where id=$1",
        [questId],
      );
      await tx.query(
        "insert into xp_events(user_id,user_quest_id,event_key,points) values ($1,$2,$3,$4)",
        [userId, questId, "quest-complete:" + questId, q.xp_reward],
      );
      if (q.slug === "housing-brief")
        await tx.query(
          "update user_quests set state='available',updated_at=now() where user_id=$1 and state='locked' and quest_id=(select id from quests where slug='housing-viewing')",
          [userId],
        );
      if (q.slug === "housing-viewing")
        await tx.query(
          "update relocation_plans set status='completed',updated_at=now() where user_id=$1 and status='active'",
          [userId],
        );
      await tx.query(
        "insert into analytics_events(user_id,name) values ($1,'quest_completed')",
        [userId],
      );
      return { awarded: q.xp_reward };
    });
  }
  async reserveChat(
    userId: string,
    threadId: string,
    requestId: string,
    text: string,
  ) {
    return this.db.transaction(async (tx) => {
      const thread =
        (
          await tx.query<Thread>(
            "select id::text,agent_key,busy_until from agent_threads where id=$1 and user_id=$2 and status<>'closed' for update",
            [threadId, userId],
          )
        ).rows[0] ?? fail(404, "Чат не найден");
      if (
        thread.busy_until &&
        new Date(thread.busy_until).getTime() > Date.now()
      )
        fail(409, "Дождитесь текущего ответа");
      if (
        (
          await tx.query(
            "select request_id from chat_requests where thread_id=$1 and request_id=$2",
            [threadId, requestId],
          )
        ).rows.length
      )
        fail(409, "Этот запрос уже был принят");
      const lease = randomUUID();
      await tx.query(
        "update agent_threads set busy_until=now()+interval '90 seconds',lease_token=$2 where id=$1",
        [threadId, lease],
      );
      await tx.query(
        "insert into chat_requests(thread_id,request_id,status) values ($1,$2,'running')",
        [threadId, requestId],
      );
      await tx.query(
        "insert into messages(thread_id,role,content,metadata) values ($1,'user',$2,$3)",
        [
          threadId,
          text,
          JSON.stringify({ agentKey: thread.agent_key, status: "complete" }),
        ],
      );
      const profile = (
        await tx.query<{ preferences: Questionnaire }>(
          "select preferences from relocation_profiles where user_id=$1",
          [userId],
        )
      ).rows[0]!.preferences;
      return {
        thread,
        lease,
        profile,
        messages: await this.history(tx, threadId),
      };
    });
  }
  async handoff(
    userId: string,
    threadId: string,
    from: AgentKey,
    to: AgentKey,
    reason: string,
    human = false,
  ) {
    await this.db.transaction(async (tx) => {
      const thread =
        (
          await tx.query(
            "select id from agent_threads where id=$1 and user_id=$2 for update",
            [threadId, userId],
          )
        ).rows[0] ?? fail(404, "Чат не найден");
      void thread;
      await tx.query(
        "insert into agent_handoffs(thread_id,from_agent_key,to_agent_key,reason,requires_human) values ($1,$2,$3,$4,$5)",
        [threadId, from, to, reason, human],
      );
      if (!human)
        await tx.query(
          "update agent_threads set agent_key=$2,updated_at=now() where id=$1",
          [threadId, to],
        );
    });
  }
  async finishChat(
    threadId: string,
    requestId: string,
    lease: string,
    agent: AgentKey,
    content: string,
    complete: boolean,
    modelResponse = complete,
    generation?: ModelGeneration,
  ) {
    return this.db.transaction(async (tx) => {
      const owner = (
        await tx.query(
          "select id from agent_threads where id=$1 and lease_token=$2 for update",
          [threadId, lease],
        )
      ).rows[0];
      if (!owner) fail(409, "Ответ устарел");
      const message = (
        await tx.query<{ id: string }>(
          "insert into messages(thread_id,role,content,metadata) values ($1,'assistant',$2,$3) returning id::text",
          [
            threadId,
            content,
            JSON.stringify({
              agentKey: agent,
              status: complete ? "complete" : "interrupted",
              source: modelResponse ? "model" : "system",
              ...(modelResponse && generation ? { generation } : {}),
            }),
          ],
        )
      ).rows[0]!;
      await tx.query(
        "update chat_requests set status=$3 where thread_id=$1 and request_id=$2",
        [threadId, requestId, complete ? "complete" : "interrupted"],
      );
      await tx.query(
        "update agent_threads set busy_until=null,lease_token=null,updated_at=now() where id=$1",
        [threadId],
      );
      return message.id;
    });
  }
}
