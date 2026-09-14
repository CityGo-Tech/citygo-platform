import type {
  ModelMessage,
  ModelStreamEvent,
  StreamingProvider,
  ModelRetryGuard,
} from "./provider.js";
import { readChatCompletion } from "./chat-completion.js";
import { createGigaPost, gigaChatUrl, type GigaPost } from "./gigachat-http.js";
import {
  GigaTokenCache,
  gigaScopes,
  type GigaScope,
} from "./gigachat-token.js";

type GigaChatOptions = {
  scope: string;
  caBundleFile?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  post?: GigaPost;
  now?: () => number;
};

export class GigaChatProvider implements StreamingProvider {
  readonly name = "gigachat" as const;
  private readonly post: GigaPost;
  private readonly tokens: GigaTokenCache;
  constructor(
    credentials: string,
    readonly model: string,
    private readonly options: GigaChatOptions,
  ) {
    if (
      !credentials ||
      credentials.length > 4096 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(credentials)
    )
      throw new Error(
        "GIGACHAT_CREDENTIALS must be the Base64 authorization key without Basic prefix",
      );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(model))
      throw new Error("GIGACHAT_MODEL must be an explicit model ID");
    if (!gigaScopes.includes(options.scope as GigaScope))
      throw new Error(
        "GIGACHAT_SCOPE must be GIGACHAT_API_PERS, GIGACHAT_API_B2B or GIGACHAT_API_CORP",
      );
    if (model === "GigaChat-3-Ultra" && options.scope !== "GIGACHAT_API_PERS")
      throw new Error("GigaChat-3-Ultra requires GIGACHAT_API_PERS");
    this.post = options.post ?? createGigaPost(options.caBundleFile);
    this.tokens = new GigaTokenCache(
      credentials,
      options.scope as GigaScope,
      this.post,
      options.now,
    );
  }

  async *stream(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
    retryGuard?: ModelRetryGuard,
  ): AsyncIterable<ModelStreamEvent> {
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 60000),
    ]);
    try {
      deadline.throwIfAborted();
      let token = await this.tokens.get(deadline);
      const request = () => {
        deadline.throwIfAborted();
        return this.post(gigaChatUrl, {
          signal: deadline,
          headers: {
            Authorization: `Bearer ${token.value}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: "system", content: instructions }, ...messages],
            stream: true,
            max_tokens: this.options.maxOutputTokens ?? 1400,
          }),
        });
      };
      let response = await request();
      if (response.status === 401) {
        await response.body?.cancel();
        this.tokens.invalidate(token);
        token = await this.tokens.get(deadline);
        // Exactly one auth recovery, only before a successful SSE response.
        await retryGuard?.beforeRetry();
        deadline.throwIfAborted();
        response = await request();
      }
      if (response.status === 401) this.tokens.invalidate(token);
      if (
        response.status !== 200 ||
        !response.body ||
        response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "text/event-stream"
      ) {
        await response.body?.cancel();
        throw new Error("Invalid GigaChat HTTP response");
      }
      yield* readChatCompletion(response.body, deadline);
    } catch {
      throw new Error("GigaChat generation failed or was interrupted");
    }
  }
}
