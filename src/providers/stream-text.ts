import type { ProviderEvent } from "../types.ts";

/**
 * VISIBLE TEXT FROM A PROVIDER EVENT STREAM, ONE EVENT AT A TIME.
 *
 * Each CLI streams the model's reply in its own shape:
 *
 *   Claude stream-json + --include-partial-messages
 *     {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}
 *     followed by the complete {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
 *   Claude stream-json without partial messages
 *     only the complete "assistant" messages
 *   Codex --json
 *     {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *     (item.started / item.updated for the same item are never forwarded, or text doubles up)
 *
 * `createProviderTextStream()` returns a stateful reader for ONE run: feed it every event and it
 * returns the text to append (or undefined). Claude deltas stream as they arrive and the complete
 * assistant message that follows them is skipped; without deltas the complete message is used.
 * Separate messages (commentary before a tool call, then the answer) are joined by a blank line.
 * Sub-agent traffic (Claude events carrying a parent_tool_use_id), tool calls, tool results,
 * reasoning, and command output are never visible text. A legacy top-level `text` string (older
 * Claude text output and test fakes) is passed through unchanged.
 */
export type ProviderTextStream = (event: ProviderEvent) => string | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Text blocks of a complete Claude assistant message, joined; "" when it carried none. */
export function claudeAssistantText(parsed: Record<string, unknown>): string {
  const message = record(parsed.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((block) => record(block))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => String(block!.text))
    .join("");
}

/** Text of one Claude `text_delta` stream event, else undefined. */
export function claudeTextDelta(parsed: Record<string, unknown>): string | undefined {
  if (parsed.type !== "stream_event") return undefined;
  const event = record(parsed.event);
  const delta = record(event?.delta);
  return event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : undefined;
}

function isSubAgent(parsed: Record<string, unknown>): boolean {
  return typeof parsed.parent_tool_use_id === "string" && parsed.parent_tool_use_id.length > 0;
}

export function createProviderTextStream(): ProviderTextStream {
  let emittedAny = false;
  /** Deltas have streamed since the last complete assistant message, so that message is a repeat. */
  let streamedSinceMessage = false;
  /** A new message started; its first text gets a blank-line separator from earlier text. */
  let messageBoundary = false;

  const out = (text: string): string | undefined => {
    if (!text) return undefined;
    const separated = messageBoundary && emittedAny ? `\n\n${text}` : text;
    messageBoundary = false;
    emittedAny = true;
    return separated;
  };

  return (event: ProviderEvent): string | undefined => {
    const parsed = event.parsed;
    if (!parsed || event.stream !== "stdout") return undefined;
    if (isSubAgent(parsed)) return undefined;

    if (parsed.type === "stream_event") {
      const inner = record(parsed.event);
      if (inner?.type === "message_start") { messageBoundary = true; return undefined; }
      const delta = claudeTextDelta(parsed);
      if (delta === undefined) return undefined;
      streamedSinceMessage = true;
      return out(delta);
    }
    if (parsed.type === "assistant") {
      if (streamedSinceMessage) { streamedSinceMessage = false; return undefined; }
      messageBoundary = true;
      return out(claudeAssistantText(parsed));
    }
    if (parsed.type === "item.completed") {
      const item = record(parsed.item);
      if (item?.type !== "agent_message" || typeof item.text !== "string") return undefined;
      messageBoundary = true;
      return out(item.text);
    }
    // Neither CLI's structured events carry a top-level `text`; one that does is a legacy
    // per-token text event (or a test fake) and is passed through as-is.
    return typeof parsed.text === "string" ? out(parsed.text) : undefined;
  };
}

/** The whole visible reply a stream produced (used for partial output when a run is cut short). */
export function providerStreamText(events: ProviderEvent[]): string {
  const stream = createProviderTextStream();
  return events.map((event) => stream(event) ?? "").join("").trim();
}
