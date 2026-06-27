import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { useRealtimeChannel } from "@/hooks/useRealtimeChannel";

// Mock the underlying WS hook so no real socket/ticket fetch happens in jsdom.
// We capture the onEvent callback + control connected/subscribed.
jest.mock("@/hooks/useRealtimeChannel", () => ({
  useRealtimeChannel: jest.fn(),
}));
const mockedChannel = useRealtimeChannel as jest.MockedFunction<typeof useRealtimeChannel>;

let capturedOnEvent: ((msg: { channel: string; data: unknown; receivedAt: number }) => void) | undefined;

function setChannelState(state: { connected: boolean; subscribed: boolean; denied?: string | null }) {
  mockedChannel.mockImplementation((_channel, opts) => {
    capturedOnEvent = opts?.onEvent as typeof capturedOnEvent;
    return {
      lastMessage: null,
      connected: state.connected,
      subscribed: state.subscribed,
      denied: state.denied ?? null,
      latencyMs: null,
    };
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useRealtimeInvalidation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnEvent = undefined;
  });

  it("subscribes to the given channel and returns connection state", () => {
    setChannelState({ connected: true, subscribed: true });
    const { result } = renderHook(() => useRealtimeInvalidation("admin:beds", [["beds"]]), { wrapper });
    expect(mockedChannel).toHaveBeenCalledWith("admin:beds", expect.objectContaining({ enabled: true }));
    expect(result.current.connected).toBe(true);
    expect(result.current.subscribed).toBe(true);
  });

  it("invalidates exactly the passed query keys on each event", () => {
    setChannelState({ connected: true, subscribed: true });
    const invalidateSpy = jest.spyOn(QueryClient.prototype, "invalidateQueries");
    renderHook(() => useRealtimeInvalidation("admin:beds", [["beds"], ["foo", 1]]), { wrapper });

    capturedOnEvent?.({ channel: "admin:beds", data: { event: "patient-admitted" }, receivedAt: Date.now() });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["beds"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["foo", 1] });
    invalidateSpy.mockRestore();
  });

  it("does not subscribe when enabled is false", () => {
    setChannelState({ connected: false, subscribed: false });
    renderHook(() => useRealtimeInvalidation("admin:beds", [["beds"]], { enabled: false }), { wrapper });
    expect(mockedChannel).toHaveBeenCalledWith("admin:beds", expect.objectContaining({ enabled: false }));
  });
});
