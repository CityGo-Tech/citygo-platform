import assert from "node:assert/strict";
import test from "node:test";
import {
  composeTextMaterial,
  createTextMaterialResource,
  TEXT_MATERIAL_MAX_BYTES,
  type TextMaterialContext,
  type TextMaterialFile,
  type TextMaterialView,
} from "./text-material-state";

function file(text: string, name = "material.txt"): TextMaterialFile {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  };
}
function deferred() {
  let resolve!: (value: ArrayBuffer) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ArrayBuffer>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(draft = "Мой вопрос") {
  const controller = new AbortController();
  const initial: TextMaterialContext = {
    userId: "101",
    threadId: "9007199254740993",
    sessionSignal: controller.signal,
    enabled: true,
    draft,
  };
  const state = {
    context: initial,
    views: [] as TextMaterialView[],
    applied: [] as string[],
    view: { phase: "select" } as TextMaterialView,
  };
  const resource = createTextMaterialResource({
    scope: initial,
    current: () => state.context,
    publish: (view) => {
      state.view = view;
      state.views.push(view);
    },
    apply: (text) => {
      state.applied.push(text);
      state.context = { ...state.context, draft: text };
    },
  });
  return { state, resource, controller };
}

test("UTF-8 preview keeps the real filename and exact draft; only explicit confirmation appends text once", async () => {
  const f = fixture("  Вопрос с пробелами  ");
  const name = "<img src=x onerror=alert(1)>.TXT";
  await f.resource.select(file("Опыт работы\nМосква 🧳", name));
  assert.deepEqual(f.state.view, {
    phase: "preview",
    filename: name,
    text: "Опыт работы\nМосква 🧳",
  });
  assert.deepEqual(f.state.applied, []);
  f.resource.edit("Проверенный текст");
  assert.equal(f.resource.confirm(), true);
  assert.equal(f.resource.confirm(), false);
  assert.deepEqual(f.state.applied, [
    "  Вопрос с пробелами  \n\nМатериал:\nПроверенный текст",
  ]);
  f.resource.dispose();
});

test("the composed 4000-character limit includes the exact current question, separators and material heading", () => {
  assert.equal(composeTextMaterial("q", "x".repeat(3987)).length, 4000);
  assert.equal(composeTextMaterial("", "x".repeat(3990)).length, 4000);
  assert.throws(
    () => composeTextMaterial("q", "x".repeat(3988)),
    /вместе превышают 4000/,
  );
  assert.throws(() => composeTextMaterial("", "x".repeat(4001)), /больше 4000/);
  assert.throws(() => composeTextMaterial("q", "  \n"), /нет текста/);
});

test("extension, empty size, invalid size and 64-KB metadata fail before a buffer is read", async () => {
  for (const metadata of [
    { name: "resume.pdf", size: 20 },
    { name: "resume.txt.pdf", size: 20 },
    { name: "resume.txt", size: 0 },
    { name: "resume.txt", size: NaN },
    { name: "resume.txt", size: TEXT_MATERIAL_MAX_BYTES + 1 },
  ]) {
    const f = fixture();
    let reads = 0;
    await f.resource.select({
      ...metadata,
      arrayBuffer: async () => {
        reads++;
        return new ArrayBuffer(1);
      },
    });
    assert.equal(reads, 0);
    assert.equal(f.state.view.phase, "select");
    assert.ok("error" in f.state.view && f.state.view.error);
    assert.deepEqual(f.state.applied, []);
    f.resource.dispose();
  }
});

test("invalid UTF-8, NUL/control bytes, empty text and overlong text never enter the preview", async () => {
  for (const invalid of [
    {
      name: "bad.txt",
      size: 2,
      arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer,
    },
    file("text\u0000secret"),
    file("text\u0001secret"),
    file("  \r\n"),
    file("x".repeat(4001)),
    {
      name: "wrong-size.txt",
      size: 1,
      arrayBuffer: async () => new ArrayBuffer(TEXT_MATERIAL_MAX_BYTES + 1),
    },
  ]) {
    const f = fixture();
    await f.resource.select(invalid);
    assert.equal(f.state.view.phase, "select");
    assert.ok("error" in f.state.view && f.state.view.error);
    assert.deepEqual(f.state.applied, []);
    f.resource.dispose();
  }
});

test("a failed local read can be retried explicitly without modifying the question", async () => {
  const f = fixture();
  await f.resource.select({
    name: "read.txt",
    size: 1,
    arrayBuffer: async () => {
      throw new Error("Read failed");
    },
  });
  assert.equal(f.state.view.phase, "select");
  assert.deepEqual(f.state.applied, []);
  await f.resource.select(file("Повтор"));
  assert.equal(f.state.view.phase, "preview");
  assert.equal(f.state.context.draft, "Мой вопрос");
  f.resource.dispose();
});

test("back invalidates a pending read and a newer selection wins over a late older file", async () => {
  const f = fixture();
  const first = deferred();
  const reading = f.resource.select({
    name: "old.txt",
    size: 3,
    arrayBuffer: () => first.promise,
  });
  f.resource.back();
  await f.resource.select(file("Новый материал", "new.txt"));
  first.resolve(new TextEncoder().encode("OLD").buffer);
  await reading;
  assert.deepEqual(f.state.view, {
    phase: "preview",
    filename: "new.txt",
    text: "Новый материал",
  });
  f.resource.dispose();
});

test("closing or unmounting while reading ignores a later successful file and cannot confirm", async () => {
  const f = fixture();
  const wait = deferred();
  const reading = f.resource.select({
    name: "late.txt",
    size: 1,
    arrayBuffer: () => wait.promise,
  });
  const count = f.state.views.length;
  f.resource.dispose();
  wait.resolve(new TextEncoder().encode("Личный текст").buffer);
  await reading;
  assert.equal(f.state.views.length, count);
  assert.equal(f.resource.confirm(), false);
  assert.deepEqual(f.state.applied, []);
});

test("abort synchronously blocks preview confirmation and ignores a pending read before UI cleanup", async () => {
  const ready = fixture();
  await ready.resource.select(file("Материал"));
  ready.controller.abort();
  assert.equal(ready.resource.confirm(), false);
  assert.deepEqual(ready.state.applied, []);
  ready.resource.dispose();
  const pending = fixture();
  const wait = deferred();
  const reading = pending.resource.select({
    name: "late.txt",
    size: 1,
    arrayBuffer: () => wait.promise,
  });
  pending.controller.abort();
  const count = pending.state.views.length;
  wait.resolve(new TextEncoder().encode("Старый владелец").buffer);
  await reading;
  assert.equal(pending.state.views.length, count);
  assert.deepEqual(pending.state.applied, []);
  pending.resource.dispose();
});

for (const field of [
  "userId",
  "threadId",
  "sessionSignal",
  "enabled",
] as const) {
  test(
    "live " +
      field +
      " replacement blocks a stale confirmation before React cleanup",
    async () => {
      const f = fixture();
      await f.resource.select(file("Закрытый материал"));
      f.state.context = {
        ...f.state.context,
        ...(field === "userId"
          ? { userId: "202" }
          : field === "threadId"
            ? { threadId: "21" }
            : field === "sessionSignal"
              ? { sessionSignal: new AbortController().signal }
              : { enabled: false }),
      };
      assert.equal(f.resource.confirm(), false);
      f.resource.edit("Поздняя правка");
      assert.deepEqual(f.state.applied, []);
      assert.equal(f.state.context.draft, "Мой вопрос");
      f.resource.dispose();
    },
  );
}

test("a pending read for another thread never publishes even without component disposal", async () => {
  const f = fixture();
  const wait = deferred();
  const reading = f.resource.select({
    name: "late.txt",
    size: 1,
    arrayBuffer: () => wait.promise,
  });
  f.state.context = { ...f.state.context, threadId: "22" };
  const count = f.state.views.length;
  wait.reject(new Error("Late private read error"));
  await reading;
  assert.equal(f.state.views.length, count);
  assert.deepEqual(f.state.applied, []);
  f.resource.dispose();
});

test("confirmation uses current draft edits, checks their combined length and keeps the preview editable on failure", async () => {
  const f = fixture("Начальный вопрос");
  await f.resource.select(file("x".repeat(100)));
  f.state.context = {
    ...f.state.context,
    draft: "Новая формулировка ".repeat(220),
  };
  assert.equal(f.resource.confirm(), false);
  assert.deepEqual(f.state.applied, []);
  assert.equal(f.state.view.phase, "preview");
  f.state.context = { ...f.state.context, draft: "Мой новый вопрос" };
  f.resource.edit("Отредактированный материал");
  assert.equal(f.resource.confirm(), true);
  assert.deepEqual(f.state.applied, [
    "Мой новый вопрос\n\nМатериал:\nОтредактированный материал",
  ]);
  f.resource.dispose();
});

test("overlong edited previews report an error without truncating or clearing either draft", async () => {
  const f = fixture();
  await f.resource.select(file("Материал"));
  const edited = "🧳".repeat(2001);
  f.resource.edit(edited);
  assert.equal(f.resource.confirm(), false);
  assert.ok(f.state.view.phase === "preview" && f.state.view.text === edited);
  assert.equal(f.state.context.draft, "Мой вопрос");
  assert.deepEqual(f.state.applied, []);
  f.resource.dispose();
});
