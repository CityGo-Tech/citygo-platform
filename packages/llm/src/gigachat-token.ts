import { randomUUID } from "node:crypto";
import { gigaAuthUrl, type GigaPost } from "./gigachat-http.js";

export const gigaScopes = [
  "GIGACHAT_API_PERS",
  "GIGACHAT_API_B2B",
  "GIGACHAT_API_CORP",
] as const;
export type GigaScope = (typeof gigaScopes)[number];
type Token = { value: string; expiresAt: number };
type Refresh = {
  promise: Promise<Token>;
  controller: AbortController;
  waiters: number;
};

async function readTokenJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new Error("Missing OAuth body");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error("OAuth body too large");
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class GigaTokenCache {
  private cached?: Token;
  private pending?: Refresh;
  constructor(
    private readonly credentials: string,
    private readonly scope: GigaScope,
    private readonly post: GigaPost,
    private readonly now = Date.now,
  ) {}

  invalidate(token: Token) {
    // A late 401 from an older request must not erase a newer token.
    if (this.cached === token) this.cached = undefined;
  }

  async get(signal: AbortSignal): Promise<Token> {
    signal.throwIfAborted();
    if (this.cached && this.cached.expiresAt > this.now() + 60000)
      return this.cached;
    if (!this.pending) {
      const controller = new AbortController();
      const refresh: Refresh = {
        controller,
        waiters: 0,
        promise: this.refresh(
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        )
          .then((token) => {
            if (!controller.signal.aborted) this.cached = token;
            return token;
          })
          .finally(() => {
            if (this.pending === refresh) this.pending = undefined;
          }),
      };
      this.pending = refresh;
    }
    const refresh = this.pending;
    refresh.waiters++;
    return new Promise<Token>((resolve, reject) => {
      let settled = false;
      const finish = (token?: Token, error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        refresh.waiters--;
        if (!refresh.waiters && this.pending === refresh) {
          this.pending = undefined;
          refresh.controller.abort();
        }
        if (token) resolve(token);
        else reject(error);
      };
      const abort = () =>
        finish(undefined, new Error("GigaChat authorization interrupted"));
      signal.addEventListener("abort", abort, { once: true });
      refresh.promise.then(
        (token) => (signal.aborted ? abort() : finish(token)),
        (error) => finish(undefined, error),
      );
      if (signal.aborted) abort();
    });
  }

  private async refresh(signal: AbortSignal): Promise<Token> {
    const response = await this.post(gigaAuthUrl, {
      signal,
      headers: {
        Authorization: `Basic ${this.credentials}`,
        RqUID: randomUUID(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ scope: this.scope }).toString(),
    });
    if (
      response.status !== 200 ||
      response.headers.get("content-type")?.split(";")[0]?.trim() !==
        "application/json"
    ) {
      await response.body?.cancel();
      throw new Error("GigaChat authorization failed");
    }
    const value = await readTokenJson(response, signal);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid GigaChat token");
    const token = value as Record<string, unknown>;
    // GigaChat SDK's AccessToken contract defines expires_at in milliseconds.
    if (
      typeof token.access_token !== "string" ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(token.access_token) ||
      token.access_token.length > 16384 ||
      typeof token.expires_at !== "number" ||
      !Number.isSafeInteger(token.expires_at) ||
      token.expires_at <= this.now() + 60000 ||
      token.expires_at > this.now() + 24 * 60 * 60 * 1000
    )
      throw new Error("Invalid GigaChat token");
    return { value: token.access_token, expiresAt: token.expires_at };
  }
}
