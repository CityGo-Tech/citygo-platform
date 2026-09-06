// Small, bounded SSE reader for the Chat Completions transport. A transport EOF
// is deliberately not converted into a provider completion event.
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let frameSize = 0;
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      bytes += chunk.value?.byteLength ?? 0;
      if (bytes > 1024 * 1024) throw new Error("SSE response too large");
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      for (;;) {
        const index = buffer.search(/[\r\n]/);
        if (
          index < 0 ||
          (buffer[index] === "\r" && index === buffer.length - 1 && !chunk.done)
        )
          break;
        const line = buffer.slice(0, index);
        const width =
          buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(index + width);
        frameSize += line.length + width;
        if (frameSize > 128 * 1024) throw new Error("SSE frame too large");
        if (!line) {
          frameSize = 0;
          if (data.length) {
            const event = data.join("\n");
            data = [];
            yield event;
          }
        } else if (line === "data" || line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        } else if (
          line.startsWith("event:") &&
          line.slice(6).trim() === "error"
        ) {
          throw new Error("SSE error event");
        }
        // Comments, event names, ids and retry hints do not trigger requests.
      }
      if (frameSize + buffer.length > 128 * 1024)
        throw new Error("SSE frame too large");
      if (chunk.done) {
        if (data.length || buffer.trim())
          throw new Error("Truncated SSE frame");
        return;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
