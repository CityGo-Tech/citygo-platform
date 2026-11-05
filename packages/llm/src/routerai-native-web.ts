import {
  validateWebSourcesForAnswer,
  type ModelUsage,
  type WebSources,
} from "@citygo/contracts";

const invalid = () => new Error("Invalid RouterAI native search response");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
};

const readUsage = (value: unknown): ModelUsage => {
  const usage = object(value),
    input = usage.prompt_tokens,
    output = usage.completion_tokens;
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isSafeInteger(output) ||
    output < 0 ||
    (usage.total_tokens !== undefined &&
      (!Number.isSafeInteger(usage.total_tokens) ||
        usage.total_tokens !== input + output))
  )
    throw invalid();
  return { inputTokens: input, outputTokens: output };
};

/** One complete, non-streaming gateway response. No partial text or annotations
 * are published before the entire bounded response has passed validation. */
export async function readNativeWebResponse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onGeneration: (id: unknown) => Promise<void>,
): Promise<{ text: string; usage?: ModelUsage; webSources: WebSources }> {
  const reader = body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1024 * 1024) throw invalid();
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = object(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown,
  );
  // Preserve the generation identity before rejecting a later model, choice,
  // completion or citation field. A malformed result must never trigger a retry.
  await onGeneration(result.id);
  signal.throwIfAborted();
  if (
    result.error != null ||
    result.model !== "openai/gpt-6.1-sol" ||
    (result.object !== undefined && result.object !== "chat.completion") ||
    !Array.isArray(result.choices) ||
    result.choices.length !== 1
  )
    throw invalid();
  const choice = object(result.choices[0]),
    message = object(choice.message);
  if (
    choice.index !== 0 ||
    choice.finish_reason !== "stop" ||
    choice.error != null ||
    message.role !== "assistant" ||
    message.tool_calls != null ||
    message.function_call != null ||
    (message.refusal != null && message.refusal !== "") ||
    typeof message.content !== "string" ||
    !message.content.trim() ||
    message.content.length > 128000 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      message.content,
    ) ||
    !Array.isArray(message.annotations) ||
    !message.annotations.length ||
    message.annotations.length > 256
  )
    throw invalid();
  const sources = new Map<string, WebSources["citations"][number]>();
  for (const raw of message.annotations) {
    const annotation = object(raw);
    if (annotation.type !== "url_citation") throw invalid();
    const source = object(annotation.url_citation);
    // Offsets are deliberately not interpreted: the documented gateway shape
    // does not establish their character convention for this candidate adapter.
    // Validate every occurrence, including a repeated URL's discarded title.
    // The separate source list keeps the first title for its canonical URL.
    const citation = validateWebSourcesForAnswer(
      {
        version: "routerai_native_v1",
        citations: [{ url: source.url, title: source.title }],
      },
      message.content,
    ).citations[0]!;
    if (!sources.has(citation.url)) sources.set(citation.url, citation);
    if (sources.size > 10) throw invalid();
  }
  const webSources = validateWebSourcesForAnswer(
    { version: "routerai_native_v1", citations: [...sources.values()] },
    message.content,
  );
  const usage =
    result.usage === undefined ? undefined : readUsage(result.usage);
  signal.throwIfAborted();
  return { text: message.content, ...(usage ? { usage } : {}), webSources };
}
