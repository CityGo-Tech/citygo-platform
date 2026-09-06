import OpenAI from "openai";
export type ModelMessage = { role: "user" | "assistant"; content: string };
export interface StreamingProvider {
  readonly name: "openai";
  stream(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
  ): AsyncIterable<string>;
}
export class OpenAIProvider implements StreamingProvider {
  readonly name = "openai" as const;
  private client: OpenAI;
  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey, timeout: 60000, maxRetries: 1 });
  }
  async *stream(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
  ) {
    const stream = await this.client.responses.create(
      {
        model: this.model,
        instructions,
        input: messages,
        stream: true,
        store: false,
        max_output_tokens: 1400,
      },
      { signal },
    );
    let completed = false;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") yield event.delta;
      if (event.type === "response.completed") completed = true;
      if (
        event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        event.type === "error"
      )
        throw new Error("Provider did not complete the response");
    }
    if (!completed) throw new Error("Provider stream interrupted");
  }
}
