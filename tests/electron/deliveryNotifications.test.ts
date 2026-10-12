import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startDeliveryNotifications,
  type DeliveryNotificationDeps,
} from "../../src/electron/libs/deliveryNotifications";
import type { ServiceEvent } from "../../src/electron/libs/deliveryService";

/** Map-backed KeyValueStore stand-in. */
function fakeKv() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => void map.set(key, value),
    delete: async (key: string) => void map.delete(key),
    map,
  };
}

const event = (seq: number, kind: ServiceEvent["kind"], extra: Partial<ServiceEvent> = {}): ServiceEvent => ({
  seq,
  kind,
  at: "2026-10-12T00:00:00Z",
  conversationId: kind === "problem" ? null : "c-1",
  agentId: "a-1",
  messageId: null,
  stepId: null,
  errorType: null,
  requestId: null,
  summary: null,
  ...extra,
});

type Recording = {
  deps: DeliveryNotificationDeps;
  notifications: { title: string; body: string; onClick: () => void }[];
  broadcasts: unknown[];
  logs: string[];
  poll: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<DeliveryNotificationDeps> = {}): Recording {
  const notifications: Recording["notifications"] = [];
  const broadcasts: unknown[] = [];
  const logs: string[] = [];
  const register = vi.fn(async () => ({ id: "d-1" }));
  const poll = vi.fn(async () => ({ events: [], latest: 0 }));
  const deps: DeliveryNotificationDeps = {
    kv: fakeKv(),
    register,
    poll,
    notify: (title, body, onClick) => notifications.push({ title, body, onClick }),
    broadcast: (event) => broadcasts.push(event),
    log: (message) => logs.push(message),
    intervalMs: 30_000,
    ...overrides,
  };
  return { deps, notifications, broadcasts, logs, poll, register };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startDeliveryNotifications", () => {
  it("creates the install identity once and reuses it", async () => {
    const first = makeDeps();
    await startDeliveryNotifications(first.deps);
    const firstKv = first.deps.kv as unknown as { map: Map<string, string> };
    const stored = firstKv.map.get("letta.delivery.deviceToken");
    expect(stored).toBeTruthy();
    first.register.mock.calls.forEach(([tokenArg]) => expect(tokenArg).toBe(stored));

    const second = makeDeps();
    (second.deps.kv as unknown as { map: Map<string, string> }).map.set(
      "letta.delivery.deviceToken",
      stored!,
    );
    await startDeliveryNotifications(second.deps);
    expect(second.register.mock.calls[0]![0]).toBe(stored);
  });

  it("approvals and problems notify; completions are silent", async () => {
    const recording = makeDeps();
    recording.poll.mockResolvedValue({
      events: [
        event(1, "approval", { summary: "Approve rm -rf?" }),
        event(2, "problem", { errorType: "llm_api_error" }),
        event(3, "outcome"),
      ],
      latest: 3,
    });
    await startDeliveryNotifications(recording.deps);
    expect(recording.notifications.map((item) => item.title)).toEqual(["Needs you", "Problem"]);
    expect(recording.notifications[0]!.body).toBe("Approve rm -rf?");
    expect(recording.notifications[1]!.body).toBe("llm_api_error");
  });

  it("notification clicks route to the conversation, or home for agent-scoped events", async () => {
    const recording = makeDeps();
    recording.poll.mockResolvedValue({
      events: [event(1, "approval"), event(2, "problem")],
      latest: 2,
    });
    await startDeliveryNotifications(recording.deps);
    recording.notifications[0]!.onClick();
    recording.notifications[1]!.onClick();
    expect(
      recording.broadcasts.filter(
        (item) => (item as { type: string }).type === "delivery.openConversation",
      ),
    ).toEqual([
      { type: "delivery.openConversation", conversationId: "c-1" },
      { type: "delivery.openConversation", conversationId: null },
    ]);
  });

  it("broadcasts every batch to the renderer and advances the persisted cursor", async () => {
    const recording = makeDeps();
    const events = [event(1, "outcome")];
    recording.poll.mockResolvedValue({ events, latest: 1 });
    await startDeliveryNotifications(recording.deps);
    expect(recording.broadcasts).toContainEqual({ type: "delivery.events", events });
    expect(
      (recording.deps.kv as unknown as { map: Map<string, string> }).map.get(
        "letta.delivery.eventCursor",
      ),
    ).toBe("1");
  });

  it("resumes from the persisted cursor across restarts", async () => {
    const recording = makeDeps();
    (recording.deps.kv as unknown as { map: Map<string, string> }).map.set(
      "letta.delivery.eventCursor",
      "7",
    );
    await startDeliveryNotifications(recording.deps);
    expect(recording.poll.mock.calls[0]![1]).toBe(7);
  });

  it("an unreachable service is honest quiet — logged, no poller, no crash", async () => {
    const recording = makeDeps();
    recording.register.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const poller = await startDeliveryNotifications(recording.deps);
    expect(poller).toBeNull();
    expect(recording.logs[0]).toContain("ECONNREFUSED");
    expect(recording.poll).not.toHaveBeenCalled();
  });

  it("a failed poll logs and keeps the loop alive", async () => {
    const recording = makeDeps();
    recording.poll.mockRejectedValueOnce(new Error("503"));
    recording.poll.mockResolvedValue({ events: [event(1, "outcome")], latest: 1 });
    const poller = await startDeliveryNotifications(recording.deps);
    expect(recording.logs[0]).toContain("503");
    expect(
      (recording.deps.kv as unknown as { map: Map<string, string> }).map.get(
        "letta.delivery.eventCursor",
      ),
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      (recording.deps.kv as unknown as { map: Map<string, string> }).map.get(
        "letta.delivery.eventCursor",
      ),
    ).toBe("1");
    poller?.stop();
  });

  it("stop ends the loop — while-running only, no zombie intervals", async () => {
    const recording = makeDeps();
    const poller = await startDeliveryNotifications(recording.deps);
    poller?.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(recording.poll).toHaveBeenCalledTimes(1); // only the startup tick
  });
});
