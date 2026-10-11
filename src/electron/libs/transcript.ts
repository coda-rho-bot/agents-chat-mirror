import {
  createTranscriptAccumulator,
  type LettaConversationMessage,
  type TranscriptRow,
} from "@letta-ai/letta-agent-sdk";
import type { AttachmentView, ChatRow } from "../types.js";

// Phase 2 wire-up: terminal doctrine comes from the shared core (one
// implementation, two shells). Projection stays local for now — desktop's
// accumulator-narrowing differs from Android's reducer projection; unify in
// the follow-up extraction pass.
export { classifyResult, classifyStreamError } from "@angus/letta-client-core";

/**
 * Projection from the SDK's transcript rows to what the renderer draws.
 *
 * The SDK's transcript accumulator owns reconciliation (joining streamed
 * fragments, pairing tool calls with results, replaying history). This file
 * only narrows its rows and handles the details the accumulator leaves to the
 * application.
 */

const MAX_TOOL_OUTPUT_CHARS = 20_000;

/**
 * Letta injects environment context into user messages as `<system-reminder>`
 * blocks. They are part of the prompt, not something the user typed.
 */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;

function clip(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const hidden = text.length - MAX_TOOL_OUTPUT_CHARS;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n... ${hidden.toLocaleString()} more characters`;
}

export function toChatRow(row: TranscriptRow, images?: AttachmentView[]): ChatRow {
  if (row.kind === "tool_call") {
    return {
      kind: "tool_call",
      key: row.key,
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      toolInput: row.toolInput,
      status: row.status,
      ...(row.result
        ? { result: { content: clip(row.result.content), isError: row.result.isError } }
        : {}),
    };
  }
  return {
    kind: row.kind,
    key: row.key,
    text: row.kind === "user" ? row.text.replace(SYSTEM_REMINDER, "").trim() : row.text,
    ...(row.otid ? { otid: row.otid } : {}),
    ...(row.kind === "user" && images && images.length > 0 ? { images } : {}),
  };
}

/**
 * Identity used to reconcile a row across the live stream, restored history,
 * and the optimistic user row the renderer draws before Letta has seen it.
 * Keep in sync with `rowIdentity` in src/ui/lib/rows.ts.
 */
export function rowIdentity(row: ChatRow): string {
  return row.kind !== "tool_call" && row.otid ? `${row.kind}:otid:${row.otid}` : row.key;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Tool calls the user refused. A refusal is recorded as an
 * `approval_response_message`, which is not transcript content, so without
 * this a denied call would restore as one still waiting for its result.
 */
function deniedToolCallIds(messages: readonly LettaConversationMessage[]): Set<string> {
  const denied = new Set<string>();
  for (const message of messages) {
    const source = asRecord(message);
    if (source?.message_type !== "approval_response_message") continue;

    const approvals = Array.isArray(source.approvals) ? source.approvals : [source];
    for (const entry of approvals) {
      const approval = asRecord(entry);
      const toolCallId = approval?.tool_call_id;
      if (typeof toolCallId !== "string") continue;
      if (approval?.approve === false || approval?.status === "error") denied.add(toolCallId);
    }
  }
  return denied;
}

/** Images a persisted user message carries, keyed by message id and otid. */
function messageImages(messages: readonly LettaConversationMessage[]): {
  byId: Map<string, AttachmentView[]>;
  byOtid: Map<string, AttachmentView[]>;
} {
  const byId = new Map<string, AttachmentView[]>();
  const byOtid = new Map<string, AttachmentView[]>();
  for (const message of messages) {
    const source = asRecord(message);
    if (source?.message_type !== "user_message") continue;
    const content = Array.isArray(source.content) ? source.content : [];
    const images: AttachmentView[] = [];
    content.forEach((part, index) => {
      const record = asRecord(part);
      const image = record?.type === "image" ? asRecord(record.source) : undefined;
      if (!image || typeof image.data !== "string") return;
      const data = image.data;
      const id = source.id ?? source.otid ?? `message-${index}`;
      images.push({
        id: `att-${id}-${index}`,
        // The wire part carries no filename or pixel size — only what the
        // renderer needs to draw it. Zero size means "no aspect hint".
        name: "image.jpg",
        data,
        mediaType: (typeof image.media_type === "string"
          ? image.media_type
          : "image/jpeg") as AttachmentView["mediaType"],
        width: 0,
        height: 0,
      });
    });
    if (images.length === 0) continue;
    if (typeof source.id === "string") byId.set(source.id, images);
    if (typeof source.otid === "string") byOtid.set(source.otid, images);
  }
  return { byId, byOtid };
}

/**
 * An images-only user message extracts no text, so the accumulator would
 * drop it and the send would vanish on reload. Give those a blank text part
 * before the rebase so the row survives; toChatRow trims it back to "".
 */
function withBlankTextPart(message: LettaConversationMessage): LettaConversationMessage {
  const source = asRecord(message);
  if (source?.message_type !== "user_message" || !Array.isArray(source.content)) return message;
  const parts = source.content as unknown[];
  const hasText = parts.some((part) => typeof part === "string" || asRecord(part)?.text);
  const hasImage = parts.some((part) => asRecord(part)?.type === "image");
  if (hasText || !hasImage) return message;
  // Message is a union of envelope shapes; only the user_message variant
  // reaches here, and the spread keeps its other envelope fields intact.
  return { ...message, content: [...parts, { type: "text", text: " " }] } as LettaConversationMessage;
}

/** Envelope otids present in a history page, for pending-state cleanup. */
export function historyOtids(messages: readonly LettaConversationMessage[]): Set<string> {
  const otids = new Set<string>();
  for (const message of messages) {
    const otid = asRecord(message)?.otid;
    if (typeof otid === "string") otids.add(otid);
  }
  return otids;
}

/** Project a persisted history page (newest first) into renderer rows. */
export function projectHistory(messages: readonly LettaConversationMessage[]): ChatRow[] {
  const rows = createTranscriptAccumulator().rebase(messages.map(withBlankTextPart), {
    order: "desc",
  });
  const denied = deniedToolCallIds(messages);
  const { byId, byOtid } = messageImages(messages);

  const projected: ChatRow[] = [];
  for (const source of rows) {
    // Join by message id first (row.uuid is the envelope id the accumulator
    // recorded); otid is the fallback for rows the stream left without one.
    const images =
      source.kind !== "tool_call"
        ? (source.uuid !== undefined ? byId.get(source.uuid) : undefined) ??
          (source.otid !== undefined ? byOtid.get(source.otid) : undefined)
        : undefined;
    const row = toChatRow(source, images);
    if (row.kind === "tool_call") {
      projected.push(
        !row.result && denied.has(row.toolCallId)
          ? { ...row, status: "complete", result: { content: "Denied", isError: true } }
          : row,
      );
    } else if (row.text || row.images) {
      projected.push(row);
    }
  }
  return projected;
}

/** History rows first, then rows that only exist in the live stream. */
export function mergeHistory(history: ChatRow[], live: ChatRow[]): ChatRow[] {
  const seen = new Set(history.map(rowIdentity));
  return [...history, ...live.filter((row) => !seen.has(rowIdentity(row)))];
}

/**
 * Runtime errors arrive as JSON nested inside JSON strings. Dig out the
 * innermost human-readable message.
 */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  let best = raw;

  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      const start = trimmed.search(/[{[]/);
      if (start >= 0) {
        try {
          visit(JSON.parse(trimmed.slice(start)), depth + 1);
          return;
        } catch {
          // Not JSON after all - treat it as the message.
        }
      }
      if (trimmed) best = trimmed;
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const key of ["error", "detail", "message"]) {
      if (record[key] !== undefined) {
        visit(record[key], depth + 1);
        return;
      }
    }
  };

  visit(raw, 0);
  return best || "Something went wrong.";
}
