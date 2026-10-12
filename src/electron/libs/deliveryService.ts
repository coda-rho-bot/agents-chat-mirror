/**
 * Client for the fleet delivery service (coda/delivery-service). The desktop
 * POLLS the service for events (D6: while-running only — this is a consumer,
 * not a daemon). Typed against the service's documented contract
 * (delivery-service PR #2): minimal structural typing, honest throws — the
 * poll loop decides what a failure means, never this client.
 */

/** One delivery event, as the service serves it (seq = the poll cursor). */
export type ServiceEvent = {
  seq: number;
  kind: "outcome" | "problem" | "approval";
  at: string;
  conversationId: string | null;
  agentId: string;
  messageId: string | null;
  stepId: string | null;
  errorType: string | null;
  requestId: string | null;
  summary: string | null;
};

export type ServiceDevice = { id: string; userId: string; pushToken: string; platform: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Register this install as a device. The desktop has no push token — it
 * POLLS — so the "token" is our stable per-install identity (a UUID in the
 * profiles.json kv); the service dedupes re-registration by it.
 */
export async function registerDevice(
  baseUrl: string,
  userId: string,
  deviceToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<ServiceDevice> {
  const response = await fetchImpl(`${baseUrl}/devices?userId=${encodeURIComponent(userId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pushToken: deviceToken, platform: "web" }),
  });
  if (!response.ok) {
    throw new Error(`Delivery service rejected device registration (${response.status}).`);
  }
  const device = (await response.json()) as Partial<ServiceDevice>;
  if (typeof device.id !== "string") {
    throw new Error("Unexpected device response from delivery service.");
  }
  return { id: device.id, userId, pushToken: deviceToken, platform: "web" };
}

/** Events for this device since the cursor. Mute filtering is server-side. */
export async function getEvents(
  baseUrl: string,
  deviceId: string,
  since: number,
  fetchImpl: FetchLike = fetch,
): Promise<{ events: ServiceEvent[]; latest: number }> {
  const response = await fetchImpl(
    `${baseUrl}/events?deviceId=${encodeURIComponent(deviceId)}&since=${since}`,
  );
  if (!response.ok) {
    throw new Error(`Delivery service events poll failed (${response.status}).`);
  }
  const body = (await response.json()) as { events?: unknown; latest?: unknown };
  if (!Array.isArray(body.events) || typeof body.latest !== "number") {
    throw new Error("Unexpected events response from delivery service.");
  }
  return { events: body.events as ServiceEvent[], latest: body.latest };
}
