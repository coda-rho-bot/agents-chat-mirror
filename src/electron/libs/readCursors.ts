import type { KeyValueStore } from "@angus/letta-client-core";

/**
 * App-owned read cursors (§3.3/§3.6): what the user has already seen, per
 * profile (user) and conversation. Read state lives in OUR storage — the
 * profiles.json metadata store — NEVER agent memory. "New" is decided by
 * comparing message ids against the cursor, never inferred from absence.
 *
 * The cursor records the newest message seen (messageId) plus that
 * message's SERVER-side date (serverAt). The id drives the new-message
 * walk; the date lets the scan skip conversations that have not changed
 * since the last look without a client/server clock comparison.
 */

export type ReadCursor = {
  /** Newest message id seen; null when the conversation had no messages. */
  messageId: string | null;
  /** Server-side date (ISO) of that message; null when unknown. */
  serverAt: string | null;
};

const key = (profileId: string, conversationId: string) =>
  `letta.read.${profileId}.${conversationId}`;

/** The stored cursor, or null when this conversation has never been looked at. */
export async function readCursor(
  store: KeyValueStore,
  profileId: string,
  conversationId: string,
): Promise<ReadCursor | null> {
  const raw = await store.get(key(profileId, conversationId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReadCursor>;
    return {
      messageId: typeof parsed.messageId === "string" ? parsed.messageId : null,
      serverAt: typeof parsed.serverAt === "string" ? parsed.serverAt : null,
    };
  } catch {
    // A corrupt cursor is an unset cursor: the next look re-establishes it.
    return null;
  }
}

/** Persist the cursor (idempotent — same message, same value). */
export async function writeCursor(
  store: KeyValueStore,
  profileId: string,
  conversationId: string,
  cursor: ReadCursor,
): Promise<void> {
  await store.set(key(profileId, conversationId), JSON.stringify(cursor));
}
