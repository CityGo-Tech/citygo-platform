import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@citygo/api-client";
import {
  createConversationTitleEditor,
  type TitleEditorState,
} from "./conversation-title-editor-state";
const value = {
  userId: "1",
  threadId: "2",
  title: null,
  revision: "0",
  updatedAt: null,
};
test("title editor serializes saves, uses exact CAS and requires explicit reload after conflict", async () => {
  let state: TitleEditorState | undefined,
    reads = 0,
    writes = 0;
  let resolve: () => void = () => {};
  const gate = new Promise<void>((r) => (resolve = r));
  const editor = createConversationTitleEditor(
    {
      conversationTitle: async () => {
        reads++;
        return value;
      },
      updateConversationTitle: async (_id, input) => {
        writes++;
        assert.equal(input.expectedRevision, "0");
        await gate;
        throw new ApiError(409, "conflict");
      },
    },
    "1",
    "2",
    new AbortController().signal,
    (s) => (state = s),
    () => assert.fail(),
  );
  await editor.load();
  const pending = editor.save("Жильё");
  assert.equal(await editor.save("Дубликат"), false);
  resolve();
  assert.equal(await pending, false);
  assert.equal(writes, 1);
  assert.equal(state!.conflict, true);
  assert.equal(await editor.save("Ещё"), false);
  await editor.load();
  assert.equal(reads, 2);
  assert.equal(state!.conflict, false);
});
test("late title read/save or auth denial after session abort/close never reaches a new account", async () => {
  for (const close of [false, true]) {
    const signal = new AbortController();
    let release: (v: typeof value) => void = () => {};
    const gate = new Promise<typeof value>((r) => (release = r));
    const seen: TitleEditorState[] = [];
    let denied = 0;
    const editor = createConversationTitleEditor(
      {
        conversationTitle: () => gate,
        updateConversationTitle: async () => value,
      },
      "1",
      "2",
      signal.signal,
      (s) => seen.push(s),
      () => denied++,
    );
    const pending = editor.load();
    if (close) editor.close();
    else signal.abort();
    const count = seen.length;
    release(value);
    await pending;
    assert.equal(seen.length, count);
    assert.equal(denied, 0);
  }
});
test("forged response identity is rejected without putting another account's title in state", async () => {
  let state: TitleEditorState | undefined;
  const editor = createConversationTitleEditor(
    {
      conversationTitle: async () => ({
        ...value,
        userId: "9",
        title: "private",
      }),
      updateConversationTitle: async () => value,
    },
    "1",
    "2",
    new AbortController().signal,
    (s) => (state = s),
    () => assert.fail(),
  );
  assert.equal(await editor.load(), false);
  assert.equal(state!.value, null);
  assert.ok(state!.error);
});
