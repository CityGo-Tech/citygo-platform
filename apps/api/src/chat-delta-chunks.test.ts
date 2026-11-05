import assert from "node:assert/strict";
import test from "node:test";
import { chatDeltaChunks } from "./chat-delta-chunks.js";

test("large completed Unicode answers become bounded v1 SSE frames without text loss", () => {
  const text = 'Москва 🏘️ \n\t\0"\\'.repeat(12_000).slice(0, 128_000);
  const chunks = [...chatDeltaChunks(text)];
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) {
    const frame =
      "data: " + JSON.stringify({ type: "delta", text: chunk }) + "\n\n";
    assert.ok(Buffer.byteLength(frame, "utf8") < 256 * 1024);
    assert.equal(JSON.parse(frame.slice(6)).text, chunk);
  }
});

test("a surrogate pair crossing a frame boundary stays intact", () => {
  const text = "x".repeat(16_383) + "🏠" + "я".repeat(17_000);
  const chunks = [...chatDeltaChunks(text)];
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.ok(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/.test(chunk)));
  assert.deepEqual([...chatDeltaChunks("Обычный ответ")], ["Обычный ответ"]);
  assert.deepEqual([...chatDeltaChunks("")], []);
});
