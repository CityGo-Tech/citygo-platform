import { streamEventSchema, type StreamEvent } from "@citygo/contracts";
import {
  ApiError,
  readBytes,
  type ClientLimits,
  type Operation,
} from "./transport.js";

// Line framing follows WHATWG (CR, LF, CRLF; optional space; multiline data).
// CityGo is a finite POST stream, not EventSource: no reconnection/retry hints.
export async function readEvents(
  response: Response,
  op: Operation,
  limits: ClientLimits,
  onEvent: (event: StreamEvent) => void,
) {
  const lineBytes = new Uint8Array(limits.maxFrameBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let lineSize = 0,
    frameSize = 0,
    eventCount = 0;
  let skipLF = false,
    firstLine = true;
  let data: string[] = [],
    eventType = "";
  const invalid = () =>
    new ApiError(
      0,
      "Сервер вернул некорректное событие чата",
      "invalid_stream",
    );
  function line(): boolean {
    let text: string;
    try {
      text = decoder.decode(lineBytes.subarray(0, lineSize));
    } catch {
      throw invalid();
    }
    lineSize = 0;
    if (firstLine) {
      text = text.replace(/^\uFEFF/, "");
      firstLine = false;
    }
    if (!text) {
      frameSize = 0;
      const type = eventType;
      eventType = "";
      if (!data.length) return false;
      if (++eventCount > limits.maxStreamEvents)
        throw new ApiError(
          0,
          "Слишком много событий чата",
          "response_too_large",
        );
      if (type && type !== "message") throw invalid();
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.join("\n"));
      } catch {
        throw invalid();
      }
      data = [];
      const result = streamEventSchema.safeParse(parsed);
      if (!result.success) throw invalid();
      op.check();
      onEvent(result.data);
      op.check();
      if (result.data.type === "error")
        throw new ApiError(0, result.data.message, "stream_error");
      return result.data.type === "done";
    }
    if (text.startsWith(":")) return false;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "event") eventType = value;
    return false;
  }
  for await (const bytes of readBytes(response, op, limits.maxStreamBytes)) {
    for (const byte of bytes) {
      if (skipLF) {
        skipLF = false;
        if (byte === 10) {
          // Count both bytes of an interior CRLF, not just the CR.
          if (frameSize > 0 && ++frameSize > limits.maxFrameBytes)
            throw new ApiError(
              0,
              "Событие чата превышает допустимый размер",
              "response_too_large",
            );
          continue;
        }
      }
      if (++frameSize > limits.maxFrameBytes)
        throw new ApiError(
          0,
          "Событие чата превышает допустимый размер",
          "response_too_large",
        );
      if (byte === 10 || byte === 13) {
        if (line()) return; // Validated done is terminal; do not wait for network EOF.
        skipLF = byte === 13;
      } else {
        lineBytes[lineSize++] = byte;
      }
    }
  }
  // Neither EOF nor an incomplete/invalid done frame can imply success.
  throw new ApiError(
    0,
    "Соединение прервано до завершения ответа",
    "stream_interrupted",
  );
}
