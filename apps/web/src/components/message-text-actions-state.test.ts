import test from "node:test";
import assert from "node:assert/strict";
import {
  createMessageTextActions,
  isMessageTextActionCurrent,
  type MessageTextContext,
  type MessageTextView,
} from "./message-text-actions-state";
function fixture() {
  const session = new AbortController();
  let current: MessageTextContext = {
    userId: "101",
    threadId: "10",
    messageId: "9007199254741101",
    text: "Точный текст 😀\n<script>literal</script>\n**Ответ**",
    sessionSignal: session.signal,
    enabled: true,
  };
  const views: MessageTextView[] = [],
    writes: string[] = [],
    downloads: string[][] = [];
  let clipboard: (text: string) => Promise<void> = async (text) => {
    writes.push(text);
  };
  let failDownload = false;
  const actions = createMessageTextActions({
    scope: { ...current },
    current: () => current,
    publish: (view) => views.push(view),
    writeClipboard: (text) => clipboard(text),
    download: (text, name) => {
      if (failDownload) throw new Error("local-only");
      downloads.push([text, name]);
    },
  });
  return {
    session,
    actions,
    views,
    writes,
    downloads,
    current: () => current,
    update: (patch: Partial<MessageTextContext>) => {
      current = { ...current, ...patch };
    },
    clipboard: (fn: typeof clipboard) => {
      clipboard = fn;
    },
    failDownload: () => {
      failDownload = true;
    },
  };
}
test("message text actions copy and download exact Unicode/plain text without truncation", async () => {
  const f = fixture();
  await f.actions.copy();
  f.actions.download();
  assert.deepEqual(f.writes, [f.current().text]);
  assert.deepEqual(f.downloads, [
    [f.current().text, "citygo-message-9007199254741101.txt"],
  ]);
  assert.deepEqual(
    f.views.map((v) => v.phase),
    ["copying", "copied", "downloaded"],
  );
});
test("message text actions use manual copy after clipboard denial", async () => {
  const f = fixture();
  f.clipboard(async () => {
    throw new Error("permission");
  });
  await f.actions.copy();
  assert.equal(f.views.at(-1)?.phase, "manual");
  f.actions.download();
  assert.equal(f.downloads.length, 1);
});
for (const [name, change] of Object.entries({
  owner: { userId: "102" },
  thread: { threadId: "11" },
  message: { messageId: "12" },
  content: { text: "changed" },
  disabled: { enabled: false },
  signal: { sessionSignal: new AbortController().signal },
})) {
  test("message text actions reject stale " + name + " handlers", async () => {
    const f = fixture();
    f.update(change);
    await f.actions.copy();
    f.actions.download();
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.views, []);
  });
}
test("message text actions discard late copy completion and block double clicks", async () => {
  const f = fixture();
  let release!: () => void;
  f.clipboard(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = f.actions.copy();
  await f.actions.copy();
  f.actions.download();
  assert.deepEqual(
    f.views.map((v) => v.phase),
    ["copying"],
  );
  assert.deepEqual(f.downloads, []);
  f.update({ userId: "102" });
  release();
  await first;
  assert.deepEqual(
    f.views.map((v) => v.phase),
    ["copying"],
  );
});
test("message text actions abort/disposal never copy, export, or publish", async () => {
  for (const end of ["abort", "dispose"]) {
    const f = fixture();
    if (end === "abort") f.session.abort();
    else f.actions.dispose();
    await f.actions.copy();
    f.actions.download();
    assert.deepEqual(f.views, []);
  }
});
test("message text actions report local download failure without upstream details", () => {
  const f = fixture();
  f.failDownload();
  f.actions.download();
  assert.deepEqual(f.views, [{ phase: "error" }]);
});

test("message text action render callbacks cannot dispatch replacement private text", async () => {
  const f = fixture();
  const renderedScope = { ...f.current() };
  const oldClick = () => {
    if (isMessageTextActionCurrent(renderedScope, f.current()))
      f.actions.download();
  };
  f.update({
    text: "replacement content",
    sessionSignal: new AbortController().signal,
  });
  oldClick();
  assert.deepEqual(f.downloads, []);
});
