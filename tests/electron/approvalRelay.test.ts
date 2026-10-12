import { describe, expect, it } from "vitest";
import { startApprovalRelay, toIngest, type ApprovalIngest } from "../../src/electron/libs/approvalRelay.js";
import type { HomeProbedApproval } from "../../src/electron/types.js";

/** A probed approval with the given requestId (agent-tagged by default). */
function probed(requestId: string, agentId: string | null = "agent-1"): HomeProbedApproval {
  return {
    conversationId: "conv-1",
    agentId,
    request: {
      requestId,
      toolCallId: null,
      toolName: "Bash",
      input: {},
      suggestions: [],
    },
    receivedAt: Date.now(),
  };
}

/** In-memory kv matching the profiles.json kv surface the relay uses. */
function memoryKv() {
  const store = new Map<string, string>();
  return {
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => void store.set(key, value),
    },
    store,
  };
}

describe("approvalRelay", () => {
  it("projects a probed approval to the service's ingestion shape", () => {
    const ingest = toIngest(probed("r-1"));
    expect(ingest.kind).toBe("approval");
    expect(ingest.conversationId).toBe("conv-1");
    expect(ingest.agentId).toBe("agent-1");
    expect(ingest.requestId).toBe("r-1");
    expect(ingest.summary).toBe("Bash is waiting for your decision");
    expect(typeof ingest.at).toBe("string");
  });

  it("relays every discovered approval on the first cycle, then only NEW ones", async () => {
    const kv = memoryKv();
    const sent: ApprovalIngest[] = [];
    let pending = [probed("r-1"), probed("r-2")];
    const relay = await startApprovalRelay({
      probe: async () => pending,
      send: async (event) => void sent.push(event),
      kv: kv.kv,
      log: () => {},
      intervalMs: 60_000,
    });
    expect(sent.map((e) => e.requestId)).toEqual(["r-1", "r-2"]);
    // Second discovery of the SAME approvals: nothing new is sent.
    pending = [probed("r-1"), probed("r-2"), probed("r-3")];
    relay.stop();
    // Drive a second cycle by starting a fresh relay over the same kv —
    // the persisted relayed set suppresses r-1/r-2 and sends only r-3.
    const sent2: ApprovalIngest[] = [];
    const relay2 = await startApprovalRelay({
      probe: async () => pending,
      send: async (event) => void sent2.push(event),
      kv: kv.kv,
      log: () => {},
      intervalMs: 60_000,
    });
    expect(sent2.map((e) => e.requestId)).toEqual(["r-3"]);
    relay2.stop();
    // The relayed set persisted: r-3 is now in the kv store.
    const persisted = JSON.parse(kv.store.get("letta.delivery.relayedApprovals") ?? "{}");
    expect(Object.keys(persisted).sort()).toEqual(["r-1", "r-2", "r-3"]);
  });

  it("a failed send leaves the approval unmarked — it retries on the next cycle", async () => {
    const kv = memoryKv();
    let fail = true;
    const sent: string[] = [];
    const relay = await startApprovalRelay({
      probe: async () => [probed("r-flaky")],
      send: async (event) => {
        if (fail) throw new Error("service down");
        sent.push(event.requestId);
      },
      kv: kv.kv,
      log: () => {},
      intervalMs: 60_000,
    });
    expect(sent).toEqual([]);
    relay.stop();
    fail = false;
    const relay2 = await startApprovalRelay({
      probe: async () => [probed("r-flaky")],
      send: async (event) => void sent.push(event.requestId),
      kv: kv.kv,
      log: () => {},
      intervalMs: 60_000,
    });
    expect(sent).toEqual(["r-flaky"]);
    relay2.stop();
  });

  it("a failed probe is honest-quiet and retries on the next cycle", async () => {
    const kv = memoryKv();
    const logs: string[] = [];
    let fail = true;
    const relay = await startApprovalRelay({
      probe: async () => {
        if (fail) throw new Error("runtime did not respond");
        return [probed("r-after-failure")];
      },
      send: async () => {},
      kv: kv.kv,
      log: (message) => void logs.push(message),
      intervalMs: 60_000,
    });
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("probe failed");
    relay.stop();
    fail = false;
    const relay2 = await startApprovalRelay({
      probe: async () => [probed("r-after-failure")],
      send: async () => {},
      kv: kv.kv,
      log: () => {},
      intervalMs: 60_000,
    });
    const persisted = JSON.parse(kv.store.get("letta.delivery.relayedApprovals") ?? "{}");
    expect(Object.keys(persisted)).toEqual(["r-after-failure"]);
    relay2.stop();
  });

  it("skips untagged approvals honestly — no garbage reaches the service", async () => {
    const kv = memoryKv();
    const logs: string[] = [];
    const sent: string[] = [];
    const relay = await startApprovalRelay({
      probe: async () => [probed("r-untagged", null)],
      send: async (event) => void sent.push(event.requestId),
      kv: kv.kv,
      log: (message) => void logs.push(message),
      intervalMs: 60_000,
    });
    expect(sent).toEqual([]);
    expect(logs[0]).toContain("untagged");
    relay.stop();
  });

  it("prunes relayed entries older than the window — a 7-day-old relay does not suppress a recurrence", async () => {
    const kv = memoryKv();
    // Seed the kv with a 7-day-old relay of r-old.
    const stale = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await kv.kv.set("letta.delivery.relayedApprovals", JSON.stringify({ "r-old": stale }));
    const sent: string[] = [];
    const relay = await startApprovalRelay({
      probe: async () => [probed("r-old")],
      send: async (event) => void sent.push(event.requestId),
      kv: kv.kv,
      log: () => {},
      intervalMs: 60_000,
      pruneMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(sent).toEqual(["r-old"]);
    relay.stop();
  });

  it("corrupt kv is treated as empty — the relay starts fresh, not broken", async () => {
    const kv = memoryKv();
    await kv.kv.set("letta.delivery.relayedApprovals", "{not json");
    const sent: string[] = [];
    const relay = await startApprovalRelay({
      probe: async () => [probed("r-fresh")],
      send: async (event) => void sent.push(event.requestId),
      kv: kv.kv,
      log: () => {},
      intervalMs: 60_000,
    });
    expect(sent).toEqual(["r-fresh"]);
    relay.stop();
  });
});
