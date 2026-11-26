import { afterEach, describe, expect, test } from "bun:test";

import { testConnection } from "./testConnection";

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
});

describe("cloud test connection", () => {
  test("ok on 200", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const result = await testConnection("cloud", "https://api.letta.com", "sk-test");
    expect(result.ok).toBe(true);
  });

  test("unauthorized on 401", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const result = await testConnection("cloud", "https://api.letta.com", "sk-bad");
    expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  test("unreachable on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await testConnection("cloud", "https://api.letta.com", "sk-test");
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  test("invalid URL is caught before any request", async () => {
    const result = await testConnection("cloud", "not a url", "sk-test");
    expect(result).toMatchObject({ ok: false, reason: "invalid_url" });
  });
});

describe("remote test connection", () => {
  test("uses the single-socket URL and preserves unrelated query parameters", async () => {
    let usedUrl = "";
    let headers: Record<string, string> | undefined;
    class FakeSocket {
      onopen: (() => void) | null = null;
      onclose = null;
      onerror = null;
      constructor(url: string, _protocols: unknown, options: { headers: Record<string, string> }) {
        usedUrl = url;
        headers = options.headers;
        queueMicrotask(() => this.onopen?.());
      }
      close() {}
    }
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const result = await testConnection("remote", "ws://localhost:18140/ws?example=1", "demo");
    expect(result.ok).toBe(true);
    expect(usedUrl).toBe("ws://localhost:18140/ws?example=1");
    expect(headers).toEqual({ Authorization: "Bearer demo" });
  });
  test("rejects non-websocket schemes", async () => {
    const result = await testConnection("remote", "ftp://server", "tok");
    expect(result).toMatchObject({ ok: false, reason: "invalid_url" });
  });
});
