import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useRealtimeData } from "@/hooks/useRealtimeData";
import { useRealtimeChannel } from "@/hooks/useRealtimeChannel";

jest.mock("@/hooks/useRealtimeChannel", () => ({ useRealtimeChannel: jest.fn() }));
const mockedChannel = useRealtimeChannel as jest.MockedFunction<typeof useRealtimeChannel>;

describe("useRealtimeData", () => {
  it("writes the latest message payload into the query cache", () => {
    const qc = new QueryClient();
    const setSpy = jest.spyOn(qc, "setQueryData");
    mockedChannel.mockReturnValue({
      lastMessage: { channel: "admin:daily-ops", data: { opd_today: 9 }, receivedAt: 123 },
      connected: true,
      subscribed: true,
      denied: null,
      latencyMs: null,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    renderHook(() => useRealtimeData("admin:daily-ops", ["dashboards", "daily-ops"]), { wrapper });
    expect(setSpy).toHaveBeenCalledWith(["dashboards", "daily-ops"], { opd_today: 9 });
  });
});
