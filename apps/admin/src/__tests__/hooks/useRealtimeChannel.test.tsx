/**
 * Tests for src/hooks/useRealtimeChannel.ts socket-URL resolution.
 *
 * Regression coverage for the NEXT_PUBLIC_WS_URL override being silently
 * ignored: .env.example documents the override and api-config.ts builds
 * WS_BASE_URL from it, but the hook used to derive the socket URL from
 * NEXT_PUBLIC_API_URL only. The hook must prefer the override when set and
 * keep the API-derived behavior byte-for-byte when unset.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { resolveWsUrl, useRealtimeChannel } from "@/hooks/useRealtimeChannel";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveWsUrl", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_WS_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  it("derives wss:// from NEXT_PUBLIC_API_URL when the override is unset", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.vhhealth.app";
    expect(resolveWsUrl()).toBe("wss://api.vhhealth.app/ws");
  });

  it("derives ws:// from an http NEXT_PUBLIC_API_URL when the override is unset", () => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:5000";
    expect(resolveWsUrl()).toBe("ws://localhost:5000/ws");
  });

  it("falls back to the production API host when nothing is configured", () => {
    expect(resolveWsUrl()).toBe("wss://api.vhhealth.app/ws");
  });

  it("prefers a wss:// NEXT_PUBLIC_WS_URL override over the API URL", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.vhhealth.app";
    process.env.NEXT_PUBLIC_WS_URL = "wss://realtime.vhhealth.app";
    expect(resolveWsUrl()).toBe("wss://realtime.vhhealth.app/ws");
  });

  it("prefers a ws:// NEXT_PUBLIC_WS_URL override (dev form from .env.example)", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.vhhealth.app";
    process.env.NEXT_PUBLIC_WS_URL = "ws://localhost:5000";
    expect(resolveWsUrl()).toBe("ws://localhost:5000/ws");
  });

  it("maps an http(s) override to the matching ws(s) scheme", () => {
    process.env.NEXT_PUBLIC_WS_URL = "https://realtime.vhhealth.app";
    expect(resolveWsUrl()).toBe("wss://realtime.vhhealth.app/ws");
    process.env.NEXT_PUBLIC_WS_URL = "http://realtime.local:8080";
    expect(resolveWsUrl()).toBe("ws://realtime.local:8080/ws");
  });

  it("ignores an unparseable override and falls back to the API URL", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.vhhealth.app";
    process.env.NEXT_PUBLIC_WS_URL = "not a url";
    expect(resolveWsUrl()).toBe("wss://api.vhhealth.app/ws");
  });
});

describe("useRealtimeChannel — socket opens against the resolved URL", () => {
  const openedUrls: string[] = [];

  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    url: string;
    constructor(url: string) {
      this.url = url;
      openedUrls.push(url);
    }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }

  const realWebSocket = global.WebSocket;
  const realFetch = global.fetch;

  beforeEach(() => {
    openedUrls.length = 0;
    delete process.env.NEXT_PUBLIC_WS_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://api.vhhealth.app";
    global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    // The hook acquires a realtime ticket before opening the socket.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "test-ticket" }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.WebSocket = realWebSocket;
    global.fetch = realFetch;
  });

  it("uses the NEXT_PUBLIC_WS_URL override when set", async () => {
    process.env.NEXT_PUBLIC_WS_URL = "wss://realtime.vhhealth.app";
    const { unmount } = renderHook(() => useRealtimeChannel("admin:kpi"));
    await waitFor(() => expect(openedUrls).toHaveLength(1));
    expect(openedUrls[0]).toBe("wss://realtime.vhhealth.app/ws");
    unmount();
  });

  it("uses the API-derived URL when the override is unset", async () => {
    const { unmount } = renderHook(() => useRealtimeChannel("admin:kpi"));
    await waitFor(() => expect(openedUrls).toHaveLength(1));
    expect(openedUrls[0]).toBe("wss://api.vhhealth.app/ws");
    unmount();
  });
});
