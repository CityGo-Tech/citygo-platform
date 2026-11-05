import {
  validateWebSourcesForAnswer,
  type Message,
  type WebSources,
} from "@citygo/contracts";
import type { SessionTicket } from "@citygo/api-client";

/** Saved complete answers only; never infer search provenance from Markdown. */
export function mobileMessageSources(
  message: Message,
): WebSources["citations"] {
  if (
    message.role !== "assistant" ||
    message.status !== "complete" ||
    !message.generation?.webSources
  )
    return [];
  try {
    return validateWebSourcesForAnswer(
      message.generation.webSources,
      message.content,
    ).citations;
  } catch {
    return [];
  }
}

/** The destination opens only after a current-session explicit press. No probe,
 * preview load, retry, provider call or persistent source cache belongs here. */
export async function openMobileMessageSource(
  message: Message,
  index: number,
  ticket: SessionTicket,
  open: (url: string) => Promise<unknown>,
) {
  if (!ticket.active() || !Number.isInteger(index) || index < 0) return false;
  const source = mobileMessageSources(message)[index];
  if (!source || !ticket.active()) return false;
  try {
    await open(source.url);
    return ticket.active();
  } catch {
    if (!ticket.active()) return false;
    throw new Error("Не удалось открыть источник. Повторите попытку.");
  }
}
