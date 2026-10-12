import { describe, expect, it, vi } from "vitest";
import { getEvents, registerDevice } from "../../src/electron/libs/deliveryService";

/** A fetch stand-in recording calls and replaying a canned response. */
function fakeFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify(body), { status });
    },
  );
  return fetchMock;
}

describe("registerDevice", () => {
  it("registers the install identity with the service and returns the device", async () => {
    const fetchMock = fakeFetch(201, { id: "d-1", userId: "operator", pushToken: "tok", platform: "web" });
    const device = await registerDevice("http://svc", "operator", "tok", fetchMock);
    expect(device.id).toBe("d-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://svc/devices?userId=operator");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ pushToken: "tok", platform: "web" });
  });

  it("throws honestly when the service rejects registration", async () => {
    await expect(
      registerDevice("http://svc", "operator", "tok", fakeFetch(500, { error: "boom" })),
    ).rejects.toThrow("rejected device registration");
  });

  it("throws honestly on an unexpected response shape", async () => {
    await expect(
      registerDevice("http://svc", "operator", "tok", fakeFetch(201, { nope: true })),
    ).rejects.toThrow("Unexpected device response");
  });
});

describe("getEvents", () => {
  it("polls with the device cursor and returns the batch", async () => {
    const fetchMock = fakeFetch(200, {
      events: [{ seq: 3, kind: "outcome", at: "2026-10-12T00:00:00Z", conversationId: "c-1", agentId: "a-1", messageId: "m-1", stepId: null, errorType: null, requestId: null, summary: null }],
      latest: 3,
    });
    const batch = await getEvents("http://svc", "d-1", 2, fetchMock);
    expect(batch.latest).toBe(3);
    expect(batch.events[0]?.seq).toBe(3);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://svc/events?deviceId=d-1&since=2");
  });

  it("throws honestly on a failed poll", async () => {
    await expect(getEvents("http://svc", "d-1", 0, fakeFetch(503, {}))).rejects.toThrow(
      "events poll failed",
    );
  });

  it("throws honestly on an unexpected batch shape", async () => {
    await expect(getEvents("http://svc", "d-1", 0, fakeFetch(200, { events: [] }))).rejects.toThrow(
      "Unexpected events response",
    );
  });
});
