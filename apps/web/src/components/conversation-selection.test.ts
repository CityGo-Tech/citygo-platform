import assert from "node:assert/strict";
import test from "node:test";
import {
  readConversationSelection,
  writeConversationSelection,
} from "./conversation-selection";

test("only valid int64 conversation IDs are remembered, separately for each owner", () => {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
  writeConversationSelection("101", "9223372036854775807", storage);
  writeConversationSelection("102", "25", storage);
  assert.equal(
    readConversationSelection("101", storage),
    "9223372036854775807",
  );
  assert.equal(readConversationSelection("102", storage), "25");
  assert.equal(readConversationSelection("103", storage), null);
  for (const invalid of [
    "0",
    "-1",
    "1e2",
    "01",
    "9223372036854775808",
    "<script>",
    " ",
    "1".repeat(10000),
  ]) {
    storage.setItem("citygo:conversation:101", invalid);
    assert.equal(readConversationSelection("101", storage), null);
    writeConversationSelection("102", invalid, storage);
    assert.equal(readConversationSelection("102", storage), "25");
  }
  writeConversationSelection("102", null, storage);
  assert.equal(readConversationSelection("102", storage), null);
});

test("disabled or absent preference storage cannot prevent authorized navigation", () => {
  const storage = {
    getItem: () => {
      throw new Error("disabled");
    },
    setItem: () => {
      throw new Error("disabled");
    },
    removeItem: () => {
      throw new Error("disabled");
    },
  };
  for (const unavailable of [storage, null]) {
    assert.equal(readConversationSelection("101", unavailable), null);
    assert.doesNotThrow(() =>
      writeConversationSelection("101", "20", unavailable),
    );
    assert.doesNotThrow(() =>
      writeConversationSelection("101", null, unavailable),
    );
  }
});
