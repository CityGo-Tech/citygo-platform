import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate } from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  dashboardResponseSchema,
  type AgentKey,
} from "@citygo/contracts";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { seedTestBudget } from "./test-budget.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";

async function fixture(t: TestContext, raw: string, interrupt = false) {
  // Isolated PGlite and provider double: no inherited environment or external calls.
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  let calls = 0;
  const response = { raw, interrupt };
  const seenFacts: string[][] = [];
  const provider: StreamingProvider = {
    name: "openai",
    model: "synthetic/cv-grounding",
    async *stream(prompt, messages) {
      calls++;
      if (messages.at(-1)?.content.includes("PERSONAL_FACTS")) {
        assert.match(prompt, /VACANCY/);
        const envelope = JSON.parse(messages.at(-1)!.content);
        seenFacts.push(
          envelope.PERSONAL_FACTS.map((f: { quote: string }) => f.quote),
        );
        assert.doesNotMatch(
          JSON.stringify(envelope.PERSONAL_FACTS),
          /Power BI|бизнесу/,
        );
      }
      // A harmful first chunk must not leak over SSE even before completion.
      yield { type: "delta", text: response.raw.slice(0, 24) };
      if (response.interrupt)
        throw new Error("Synthetic upstream interruption");
      yield { type: "delta", text: response.raw.slice(24) };
      yield { type: "complete", model: "synthetic/cv-grounding" };
    },
  };
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    LLM_PROVIDER: "openai",
    OPENAI_MODEL: provider.model,
  });
  await seedTestBudget(db, config, { openai: provider });
  const app = await buildApp({ db, provider, config, testing: true });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const id = await registerSyntheticConsentingUser(
    db,
    "cv@example.test",
    "synthetic",
    app,
  );
  const token = randomUUID();
  await db.query(
    "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
    [tokenHash(token), id],
  );
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        "x-citygo-client": "native",
        authorization: "Bearer " + token,
      },
      ...(payload ? { payload } : {}),
    });
  const board = dashboardResponseSchema.parse(
    (await call("GET", "/v1/dashboard")).json(),
  );
  const policyId = board.aiAccess.policy!.id;
  assert.equal(
    (await call("POST", "/v1/ai/consent", { action: "granted", policyId }))
      .statusCode,
    200,
  );
  const start = async (agentKey: AgentKey) =>
    (await call("POST", "/v1/conversations/start", { agentKey })).json()
      .id as string;
  const send = (thread: string, text: string) =>
    call("POST", "/v1/threads/" + thread + "/messages", {
      text,
      policyId,
      requestId: randomUUID(),
    });
  return { db, call, start, send, calls: () => calls, response, seenFacts };
}
const question =
  "Адаптируй резюме. Факты профиля: 2 года с SQL и Excel; регулярные отчёты. Требования вакансии: Power BI, объяснять выводы бизнесу.";
const good = JSON.stringify({
  sections: [
    {
      kind: "experience",
      facts: [
        { id: "F1", quote: "2 года с SQL и Excel" },
        { id: "F2", quote: "регулярные отчёты." },
      ],
    },
  ],
  advice: ["business", "review"],
  question: "business",
});

test("real HTTP flow: both pinned career agents publish only validated CV, persist it and retain history", async (t) => {
  const f = await fixture(t, good);
  for (const agent of ["job-search", "resume-builder"] as const) {
    const thread = await f.start(agent);
    const reply = await f.send(thread, question);
    assert.match(reply.body, /"type":"done"/);
    assert.doesNotMatch(reply.body, /"type":"error"|\\"sections\\"/);
    assert.match(reply.body, /2 года с SQL и Excel/);
    assert.doesNotMatch(
      reply.body.split("Редакторские рекомендации")[0]!,
      /Power BI|объяснять выводы бизнесу/,
    );
    const history = await f.call("GET", "/v1/conversations/" + thread);
    assert.equal(history.statusCode, 200);
    const rows = (
      await f.db.query<{ content: string; status: string }>(
        "select content,metadata->>'status' as status from messages where thread_id=$1 and role='assistant' order by id desc limit 1",
        [thread],
      )
    ).rows;
    assert.match(rows[0]!.content, /Черновик резюме/);
    assert.equal(rows[0]!.status, "complete");
    assert.doesNotMatch(rows[0]!.content, /Power BI/);
  }
  assert.equal(
    f.calls(),
    2,
    "one provider attempt per CV, no extra verifier call",
  );
});
test("invalid provider CV is neither streamed nor persisted as experience or a successful result", async (t) => {
  const raw = good.replace(
    "2 года с SQL и Excel",
    "Владею Power BI, рост выручки 40%",
  );
  const f = await fixture(t, raw);
  const thread = await f.start("job-search");
  const reply = await f.send(thread, question);
  assert.match(reply.body, /VALIDATION_ERROR/);
  assert.doesNotMatch(reply.body, /Владею Power BI|рост выручки|"type":"done"/);
  const rows = (
    await f.db.query<{ content: string; status: string }>(
      "select content,metadata->>'status' as status from messages where thread_id=$1 and role='assistant' order by id desc limit 1",
      [thread],
    )
  ).rows;
  assert.doesNotMatch(rows[0]!.content, /Владею Power BI|рост выручки/);
  assert.notEqual(rows[0]!.status, "complete");
  assert.equal(f.calls(), 1);
});
test("ambiguous or vacancy-only CV asks locally without model attempt; ordinary career help remains generative", async (t) => {
  const f = await fixture(t, "Полезный план подготовки к собеседованию.");
  const thread = await f.start("resume-builder");
  const reply = await f.send(
    thread,
    "Составь резюме. Требования вакансии: Power BI, объяснять бизнесу.",
  );
  assert.match(reply.body, /"type":"done"/);
  assert.match(reply.body, /Какие сведения о своём опыте/);
  assert.equal(f.calls(), 0);
  const normal = await f.start("job-search");
  assert.match(
    (await f.send(normal, "Как подготовиться к собеседованию?")).body,
    /Полезный план/,
  );
  assert.equal(f.calls(), 1);
});
test("a provider failure after its first CV chunk never poisons persisted history", async (t) => {
  const f = await fixture(t, "Владею Power BI, рост выручки 40%", true);
  const thread = await f.start("job-search");
  const reply = await f.send(thread, question);
  assert.match(reply.body, /"type":"error"/);
  assert.doesNotMatch(reply.body, /Владею Power BI|рост выручки|"type":"done"/);
  const rows = (
    await f.db.query<{ content: string; status: string }>(
      "select content,metadata->>'status' as status from messages where thread_id=$1 and role='assistant'",
      [thread],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.doesNotMatch(rows[0]!.content, /Владею Power BI|рост выручки/);
  assert.notEqual(rows[0]!.status, "complete");
  assert.equal(f.calls(), 1);
});
test("a new user discovers the input format, supplies facts once, then can withdraw them without publishing stale experience", async (t) => {
  const f = await fixture(t, good);
  const thread = await f.start("resume-builder");
  const first = await f.send(thread, "Помоги с резюме.");
  assert.match(first.body, /Пример формата/);
  assert.equal(f.calls(), 0);
  const supplied = await f.send(
    thread,
    "Факты профиля: 2 года с SQL и Excel; регулярные отчёты. Требования вакансии: Power BI.",
  );
  assert.match(supplied.body, /Черновик резюме/);
  assert.equal(f.calls(), 1);
  const corrected = await f.send(
    thread,
    "Исправь резюме: прошлые сведения неверны; SQL я не применял.",
  );
  assert.match(corrected.body, /Пример формата/);
  assert.doesNotMatch(
    corrected.body,
    /Черновик резюме|Ваши исходные сведения|\[F1\]/,
  );
  assert.equal(f.calls(), 1);
});
test("a stored fact revision survives a rejected or interrupted assistant turn and cannot resurrect SQL", async (t) => {
  for (const interrupt of [false, true]) {
    const f = await fixture(t, good);
    const thread = await f.start("job-search");
    assert.match((await f.send(thread, question)).body, /"type":"done"/);
    f.response.raw = "Владею Power BI, рост выручки 40%";
    f.response.interrupt = interrupt;
    const revised = await f.send(
      thread,
      "Исправь резюме. Подтверждённые факты: Excel; SQL не применял. Требования вакансии: SQL.",
    );
    assert.match(revised.body, /"type":"error"/);
    f.response.interrupt = false;
    f.response.raw = JSON.stringify({
      sections: [{ kind: "skills", facts: [{ id: "F1", quote: "Excel" }] }],
      advice: ["review"],
      question: "none",
    });
    const shortened = await f.send(thread, "Сделай короче.");
    assert.match(shortened.body, /"type":"done"/);
    assert.match(shortened.body, /Excel \[F1\]/);
    assert.doesNotMatch(shortened.body, /SQL \[F|Power BI \[F|рост выручки/);
    assert.deepEqual(f.seenFacts[2], ["Excel"]);
    assert.equal(f.calls(), 3);
  }
});
