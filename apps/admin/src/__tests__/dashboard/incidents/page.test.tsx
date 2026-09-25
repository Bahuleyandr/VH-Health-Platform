import IncidentsPage from "@/app/(with-auth)/dashboard/incidents/page";
import { getIncidents, getIncidentStats } from "@/lib/api/reports";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

jest.mock("@/lib/api/reports", () => ({
  getIncidents: jest.fn(),
  getIncidentStats: jest.fn(),
  updateIncident: jest.fn(),
}));

const mockRealtime = jest.fn((..._args: unknown[]) => ({
  connected: false,
  subscribed: false,
  denied: null as string | null,
  lastEventAt: null as number | null,
}));
jest.mock("@/hooks/useRealtimeInvalidation", () => ({
  useRealtimeInvalidation: (...args: unknown[]) => mockRealtime(...args),
}));

const mockedGetIncidents = getIncidents as jest.MockedFunction<
  typeof getIncidents
>;
const mockedGetIncidentStats = getIncidentStats as jest.MockedFunction<
  typeof getIncidentStats
>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<IncidentsPage />", () => {
  const incident = {
    id: 1,
    report_number: "INC-001",
    incident_type: "patient_fall",
    severity: "moderate",
    title: "Ward fall",
    description: "Incident description",
    incident_date: "2026-09-25T12:00:00Z",
    status: "submitted",
    priority: "normal",
    patient_involved: false,
    is_anonymous: true,
    created_at: "2026-09-25T12:00:00Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({
      connected: false,
      subscribed: false,
      denied: null,
      lastEventAt: null,
    });
    mockedGetIncidents.mockResolvedValue({ incidents: [], total: 0 } as never);
    mockedGetIncidentStats.mockResolvedValue({
      summary: {
        new_count: "0",
        active_count: "0",
        sentinel_count: "0",
        severe_count: "0",
        this_week: "0",
        this_month: "0",
        total: "0",
      },
      by_type: [],
    } as never);
  });

  it("subscribes to staff:incidents on both roots and shows ○ Offline when disconnected", async () => {
    renderWithQuery(<IncidentsPage />);
    const ind = await screen.findByTestId("incidents-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:incidents", [
      ["incidents"],
      ["incident-stats"],
    ]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({
      connected: true,
      subscribed: true,
      denied: null,
      lastEventAt: Date.now(),
    });
    renderWithQuery(<IncidentsPage />);
    const ind = await screen.findByTestId("incidents-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });

  it("opens the named incident dialog by keyboard and returns focus after closing", async () => {
    const user = userEvent.setup();
    mockedGetIncidents.mockResolvedValue({ incidents: [incident], total: 1 } as never);
    renderWithQuery(<IncidentsPage />);

    const opener = await screen.findByRole("button", {
      name: "Review incident INC-001: Ward fall",
    });
    opener.focus();
    await user.keyboard("{Enter}");

    const dialog = screen.getByRole("dialog", { name: "Ward fall" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = within(dialog).getByRole("button", {
      name: "Close incident details",
    });
    expect(close).toHaveFocus();

    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "Save Changes" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes the incident dialog with Escape and returns focus to its review button", async () => {
    const user = userEvent.setup();
    mockedGetIncidents.mockResolvedValue({ incidents: [incident], total: 1 } as never);
    renderWithQuery(<IncidentsPage />);

    const opener = await screen.findByRole("button", {
      name: "Review incident INC-001: Ward fall",
    });
    opener.focus();
    await user.keyboard(" ");
    expect(screen.getByRole("dialog", { name: "Ward fall" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
