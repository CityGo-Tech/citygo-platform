import assert from "node:assert/strict";
import test from "node:test";
import { clearChatDrafts, readChatDraft, writeChatDraft } from "./chat-drafts";

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

test("unsent drafts survive reconstruction only for the exact owner and thread, with no automatic transport", () => {
  const s = storage();
  const text = "  Последний вопрос 🧳\nЕщё не отправлен  ";
  assert.equal(writeChatDraft("101", "9007199254740993", text, s, 1000), true);
  assert.equal(readChatDraft("101", "9007199254740993", s, 1100), text);
  assert.equal(readChatDraft("102", "9007199254740993", s, 1100), "");
  assert.equal(readChatDraft("101", "9007199254740994", s, 1100), "");
  assert.equal(writeChatDraft("101", "9007199254740993", "", s, 1200), true);
  assert.equal(readChatDraft("101", "9007199254740993", s, 1300), "");
});

test("logout clears all tab draft owners without removing unrelated browser preferences", () => {
  const s = storage();
  writeChatDraft("101", "20", "A", s);
  writeChatDraft("102", "21", "B", s);
  s.setItem("citygo:conversation:101", "20");
  clearChatDrafts(s);
  assert.deepEqual([...s.data], [["citygo:conversation:101", "20"]]);
});

test("expired, future, corrupt and oversized drafts are discarded; disabled storage does not block composing", () => {
  const s = storage();
  writeChatDraft("101", "20", "A", s, 1000);
  assert.equal(readChatDraft("101", "20", s, 1000 + 86400000), "");
  assert.equal(s.length, 0);
  writeChatDraft("101", "20", "A", s, 2000);
  assert.equal(readChatDraft("101", "20", s, 1000), "");
  for (const raw of [
    "{",
    JSON.stringify({ text: 123, savedAt: 1000 }),
    JSON.stringify({ text: "x".repeat(4001), savedAt: 1000 }),
    "x".repeat(25001),
  ]) {
    s.setItem("citygo:chat-draft:v1:101:20", raw);
    assert.equal(readChatDraft("101", "20", s, 1001), "");
    assert.equal(s.length, 0);
  }
  assert.equal(writeChatDraft("101\n", "20", "A", s), false);
  assert.equal(writeChatDraft("101", "9223372036854775808", "A", s), false);
  assert.equal(writeChatDraft("101", "20", "x".repeat(4001), s), false);
  const denied = {
    ...s,
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(readChatDraft("101", "20", denied), "");
  assert.equal(writeChatDraft("101", "20", "A", denied), false);
  assert.doesNotThrow(() => clearChatDrafts(denied));
  assert.equal(writeChatDraft("101", "20", "A", null), false);
});
