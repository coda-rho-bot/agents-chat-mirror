import type { CompletedRow } from "../types.js";

/**
 * The "Completed since you last looked" projection (§3.1/§3.5): material
 * outcomes only. A turn's lifecycle — assistant output, tool calls, steps,
 * subagent activity — collapses to ONE row per conversation showing the
 * latest outcome. The row's data path is the EXISTING SDK message surface
 * (conversations.listMessages, REST-backed); no new REST surface.
 */

/** The minimal structural view of a message the walk consumes. */
export type WalkMessage = {
  id: string;
  message_type?: string | null;
  /** Wire content: a string or content parts (text, images, …). */
  content?: unknown;
  date?: string | null;
};

/** Best-effort text of a message's content (string or content parts). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * The new assistant messages since the cursor, newest-first page order.
 * Walks until the cursor's message id (everything before it is new);
 * a cursor id outside the page means the whole page is newer (bounded by
 * the page size). Tool calls, reasoning, and system messages are the
 * technical lifecycle — only assistant messages are material outcomes.
 */
export function newOutcomesSince(
  messages: readonly WalkMessage[],
  cursorMessageId: string | null,
): WalkMessage[] {
  const found: WalkMessage[] = [];
  for (const message of messages) {
    if (cursorMessageId && message.id === cursorMessageId) break;
    if (message.message_type === "assistant_message") found.push(message);
  }
  return found;
}

/** One row per conversation: the latest new outcome (§3.1 — one row, not one per event). */
export function toCompletedRow(
  conversationId: string,
  agentId: string,
  outcomes: readonly WalkMessage[],
): CompletedRow | null {
  const latest = outcomes[0];
  if (!latest) return null;
  const preview = contentText(latest.content).trim();
  return {
    conversationId,
    agentId,
    messageId: latest.id,
    preview: preview.length > 0 ? preview : "Finished a turn",
    completedAt: latest.date ?? new Date().toISOString(),
  };
}
