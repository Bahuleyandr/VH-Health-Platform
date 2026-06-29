import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import AppointmentsPage from "@/app/(with-auth)/dashboard/appointments/page";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn().mockResolvedValue({ data: [] }) }));
jest.mock("@/lib/api/appointments", () => ({
  getTodayQueueAdmin: jest.fn().mockResolvedValue([]),
  getAvailableSlots: jest.fn().mockResolvedValue({ available: true, slots: [] }),
  confirmAppointmentAdmin: jest.fn(), completeAppointmentAdmin: jest.fn(),
  markNoShowAdmin: jest.fn(), cancelAppointmentAdmin: jest.fn(),
  getAppointmentSlaDashboard: jest.fn().mockResolvedValue({ sla_metrics: [], pending_appointments: [] }),
}));

// Mock SlaOverviewTab to avoid complex rendering in default overview tab
jest.mock(
  "@/app/(with-auth)/dashboard/appointments/components/SlaOverviewTab",
  () => ({ SlaOverviewTab: () => <div data-testid="sla-stub">SLA</div> }),
);

const mockRealtime = jest.fn(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (..._args: unknown[]) => ({ connected: false, subscribed: false, denied: null as string | null, lastEventAt: null as number | null }),
);
jest.mock("@/hooks/useRealtimeInvalidation", () => ({
  useRealtimeInvalidation: (...args: unknown[]) => mockRealtime(...args),
}));

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<AppointmentsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
  });
  it("subscribes to staff:appointments on [appointments]+[queue] roots and shows ○ Offline when down", async () => {
    renderWithQuery(<AppointmentsPage />);
    const ind = await screen.findByTestId("appointments-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:appointments", [["appointments"], ["queue"]]);
  });
  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<AppointmentsPage />);
    expect(await screen.findByTestId("appointments-realtime-indicator")).toHaveTextContent("Live");
  });
});
