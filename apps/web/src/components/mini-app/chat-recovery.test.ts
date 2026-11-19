import assert from "node:assert/strict";
import test from "node:test";
import {
  clearMiniChatMarkers,
  miniChatMarkerKey,
  readMiniChatMarker,
  writeMiniChatMarker,
} from "./chat-recovery";

function storageFixture(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (index) => Array.from(data.keys())[index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
  };
}

test("ambiguous send markers are tab-local and scoped to the account and conversation", () => {
  const storage = storageFixture();
  const key = miniChatMarkerKey("101", "20")!;
  const marker = {
    requestId: "bb9af44a-8a7c-479c-8f24-1c63de882303",
    mode: "maximum",
  } as const;
  writeMiniChatMarker(storage, key, marker);
  assert.deepEqual(readMiniChatMarker(storage, key), marker);
  assert.equal(
    readMiniChatMarker(storage, miniChatMarkerKey("102", "20")!),
    null,
  );
  assert.equal(
    readMiniChatMarker(storage, miniChatMarkerKey("101", "21")!),
    null,
  );
  assert.equal(miniChatMarkerKey("not-an-owner", "20"), null);
  storage.setItem("citygo:another-feature", "keep");
  clearMiniChatMarkers(storage);
  assert.equal(readMiniChatMarker(storage, key), null);
  assert.equal(storage.getItem("citygo:another-feature"), "keep");
});

test("malformed and unsupported mini-app recovery markers never restore sending", () => {
  const storage = storageFixture();
  const key = miniChatMarkerKey("101", "20")!;
  for (const value of [
    "{",
    '{"requestId":"bad","mode":"maximum"}',
    '{"requestId":"bb9af44a-8a7c-479c-8f24-1c63de882303","mode":"fallback"}',
  ]) {
    storage.setItem(key, value);
    assert.equal(readMiniChatMarker(storage, key), null);
  }
});
