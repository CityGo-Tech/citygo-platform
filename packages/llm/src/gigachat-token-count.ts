import type { ModelInputTokenCounts, ModelMessage } from "./provider.js";

// These are CityGo transport bounds, not limits promised by the provider.
const maxRequestBytes = 2 * 1024 * 1024;
const maxResponseBytes = 64 * 1024;
const maxInputItems = 256;

export function gigaTokenCountBody(
  model: string,
  instructions: string,
  messages: readonly ModelMessage[],
) {
  if (
    typeof instructions !== "string" ||
    !Array.isArray(messages) ||
    messages.length + 1 > maxInputItems ||
    messages.some(
      (message) =>
        !message ||
        !["user", "assistant"].includes(message.role) ||
        typeof message.content !== "string",
    )
  )
    throw new Error("Invalid GigaChat token count input");
  // Snapshot plain strings before OAuth or any other await. A caller cannot
  // change which private text is sent while authorization is in flight.
  const input = [instructions, ...messages.map((message) => message.content)];
  let bytes = Buffer.byteLength(JSON.stringify({ model, input: [] }), "utf8");
  for (const [index, text] of input.entries()) {
    if (
      text.length > maxRequestBytes ||
      Buffer.byteLength(text) > maxRequestBytes
    )
      throw new Error("GigaChat token count input too large");
    bytes += Buffer.byteLength(JSON.stringify(text)) + (index > 0 ? 1 : 0);
    if (bytes > maxRequestBytes)
      throw new Error("GigaChat token count input too large");
  }
  const body = JSON.stringify({ model, input });
  if (Buffer.byteLength(body) !== bytes)
    throw new Error("Invalid GigaChat token count input");
  return { body, input };
}

export async function readGigaTokenCounts(
  response: Response,
  input: readonly string[],
  signal: AbortSignal,
): Promise<ModelInputTokenCounts> {
  if (
    response.status !== 200 ||
    !response.body ||
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Invalid GigaChat token count response");
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)
  ) {
    await response.body.cancel().catch(() => {});
    throw new Error("Invalid GigaChat token count response");
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes)
        throw new Error("GigaChat token count response too large");
      chunks.push(value);
    }
    const result: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!Array.isArray(result) || result.length !== input.length)
      throw new Error("Invalid GigaChat token count response");
    let total = 0;
    const counts = result.map((entry: unknown, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("Invalid GigaChat token count response");
      const row = entry as Record<string, unknown>;
      if (
        typeof row.tokens !== "number" ||
        !Number.isSafeInteger(row.tokens) ||
        row.tokens < 0 ||
        (input[index]!.length > 0 && row.tokens === 0) ||
        (row.object !== undefined && row.object !== "tokens") ||
        (row.characters !== undefined &&
          (typeof row.characters !== "number" ||
            !Number.isSafeInteger(row.characters) ||
            row.characters < 0))
      )
        throw new Error("Invalid GigaChat token count response");
      total += row.tokens;
      if (!Number.isSafeInteger(total))
        throw new Error("Invalid GigaChat token count response");
      return row.tokens;
    });
    // The endpoint counts text strings, not the complete chat wire format.
    // Role delimiters, output allowance and any further safety margin belong
    // to the immutable execution/context planner, never to this response.
    return { instructions: counts[0]!, messages: counts.slice(1) };
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
