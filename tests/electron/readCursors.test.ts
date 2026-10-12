import { describe, expect, it } from "vitest";
import { readCursor, writeCursor } from "../../src/electron/libs/readCursors";
import type { KeyValueStore } from "@angus/letta-client-core";

/** In-memory stand-in for the profiles.json store. */
const memoryStore = (): KeyValueStore => {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
};

describe("read cursors", () => {
  it("roundtrips a cursor through the store", async () => {
    const store = memoryStore();
    await writeCursor(store, "p-1", "conv-1", {
      messageId: "message-9",
      serverAt: "2026-10-12T00:30:00Z",
    });
    expect(await readCursor(store, "p-1", "conv-1")).toEqual({
      messageId: "message-9",
      serverAt: "2026-10-12T00:30:00Z",
    });
  });

  it("keys cursors per profile — read state never crosses users", async () => {
    const store = memoryStore();
    await writeCursor(store, "p-1", "conv-1", { messageId: "m-1", serverAt: null });
    expect(await readCursor(store, "p-2", "conv-1")).toBeNull();
  });

  it("returns null for a conversation never looked at", async () => {
    expect(await readCursor(memoryStore(), "p-1", "conv-1")).toBeNull();
  });

  it("treats a corrupt cursor as unset — the next look re-establishes it", async () => {
    const store = memoryStore();
    await store.set("letta.read.p-1.conv-1", "{not json");
    expect(await readCursor(store, "p-1", "conv-1")).toBeNull();
  });
});
