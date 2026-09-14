import test from "node:test";
import assert from "node:assert/strict";
import { readSseData } from "./sse.js";

const signal = () => new AbortController().signal;
function body(text: string) {
  return new Response(text).body!;
}
async function collect(input: AsyncIterable<string>) {
  const result: string[] = [];
  for await (const value of input) result.push(value);
  return result;
}

test("SSE keeps the default 1 MiB total cap but accepts bounded larger streams", async () => {
  const frame = "data: " + "x".repeat(1024) + "\n\n";
  const wire = frame.repeat(1100);
  assert.ok(Buffer.byteLength(wire) > 1024 * 1024);
  await assert.rejects(collect(readSseData(body(wire), signal())), {
    message: "SSE response too large",
  });
  const result = await collect(
    readSseData(body(wire), signal(), { maxStreamBytes: 16 * 1024 * 1024 }),
  );
  assert.equal(result.length, 1100);
  assert.ok(result.every((value) => value === "x".repeat(1024)));
});

test("SSE enforces the selected byte boundary and the absolute 16 MiB ceiling", async () => {
  const wire = "data: я\n\n";
  const bytes = Buffer.byteLength(wire);
  assert.deepEqual(
    await collect(readSseData(body(wire), signal(), { maxStreamBytes: bytes })),
    ["я"],
  );
  await assert.rejects(
    collect(readSseData(body(wire), signal(), { maxStreamBytes: bytes - 1 })),
    { message: "SSE response too large" },
  );
  await assert.rejects(
    collect(
      readSseData(
        new Response(new Uint8Array(16 * 1024 * 1024 + 1)).body!,
        signal(),
        { maxStreamBytes: 16 * 1024 * 1024 },
      ),
    ),
    { message: "SSE response too large" },
  );
});

test("larger streams retain the 128 KiB per-frame guard and reject invalid limits", async () => {
  await assert.rejects(
    collect(
      readSseData(body("data: " + "x".repeat(128 * 1024) + "\n\n"), signal(), {
        maxStreamBytes: 16 * 1024 * 1024,
      }),
    ),
    { message: "SSE frame too large" },
  );
  for (const maxStreamBytes of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    16 * 1024 * 1024 + 1,
  ])
    await assert.rejects(
      collect(readSseData(body("data: ok\n\n"), signal(), { maxStreamBytes })),
      { message: "Invalid SSE stream limit" },
    );
});
