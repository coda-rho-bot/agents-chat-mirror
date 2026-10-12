import type { KeyValueStore } from "@angus/letta-client-core";
import type { ServiceEvent } from "./deliveryService.js";

/**
 * The while-running notification layer (D6): the desktop polls the delivery
 * service on an interval while the app is open — no tray, no daemon, no
 * always-on claims. Approvals and problems raise OS notifications;
 * completions are SILENT badge updates (the renderer refreshes its home
 * sections — the home IS the badge). All effects are injected, so the loop
 * is testable without Electron.
 */

export type DeliveryNotificationDeps = {
  /** Stable per-install store (profiles.json kv). */
  kv: KeyValueStore;
  /** Registers the install as a device (deliveryService.registerDevice). */
  register: (deviceToken: string) => Promise<{ id: string }>;
  /** Polls for events (deliveryService.getEvents). */
  poll: (deviceId: string, since: number) => Promise<{ events: ServiceEvent[]; latest: number }>;
  /** Raises one OS notification; the click callback is bound at construction. */
  notify: (title: string, body: string, onClick: () => void) => void;
  /** Renderer-bound events: silent home refresh + notification-click routing. */
  broadcast: (event: { type: "delivery.events"; events: ServiceEvent[] } | { type: "delivery.openConversation"; conversationId: string | null }) => void;
  /** Honest quiet: failures log, they do not surface or crash. */
  log: (message: string) => void;
  /** Poll cadence in ms. */
  intervalMs: number;
};

const TOKEN_KEY = "letta.delivery.deviceToken";
const CURSOR_KEY = "letta.delivery.eventCursor";

export type DeliveryPoller = { stop: () => void };

/**
 * Starts the poll loop. Registers the install (creating the identity token on
 * first run), then polls: approvals + problems notify, outcomes are silent,
 * every event advances the persisted cursor and reaches the renderer.
 */
export async function startDeliveryNotifications(
  deps: DeliveryNotificationDeps,
): Promise<DeliveryPoller | null> {
  let deviceToken = await deps.kv.get(TOKEN_KEY);
  if (!deviceToken) {
    deviceToken = crypto.randomUUID();
    await deps.kv.set(TOKEN_KEY, deviceToken);
  }
  let deviceId: string;
  try {
    deviceId = (await deps.register(deviceToken)).id;
  } catch (error) {
    // Expected until the service is deployed (S3: the key is pending) —
    // honest quiet, and the app is fully functional without notifications.
    deps.log(`delivery service unreachable, notifications off: ${String(error)}`);
    return null;
  }

  let cursor = Number.parseInt((await deps.kv.get(CURSOR_KEY)) ?? "0", 10);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  const tick = async (): Promise<void> => {
    let batch: { events: ServiceEvent[]; latest: number };
    try {
      batch = await deps.poll(deviceId, cursor);
    } catch (error) {
      deps.log(`delivery poll failed: ${String(error)}`);
      return;
    }
    for (const event of batch.events) {
      if (event.kind === "approval" || event.kind === "problem") {
        deps.notify(
          event.kind === "approval"
            ? "Needs you"
            : "Problem",
          event.kind === "approval"
            ? event.summary ?? "An agent is waiting for approval"
            : event.errorType ?? "An agent hit a failure",
          () =>
            deps.broadcast({
              type: "delivery.openConversation",
              conversationId: event.conversationId,
            }),
        );
      }
      // Outcomes are silent: the renderer's home refresh is the badge update.
    }
    if (batch.events.length > 0) {
      deps.broadcast({ type: "delivery.events", events: batch.events });
    }
    if (batch.latest > cursor) {
      cursor = batch.latest;
      await deps.kv.set(CURSOR_KEY, String(cursor));
    }
  };

  await tick();
  const timer = setInterval(() => void tick(), deps.intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
