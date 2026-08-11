import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import BloodBankPage from "@/app/(with-auth)/dashboard/blood-bank/page";
import { postJSONEnvelope } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn().mockResolvedValue({ data: [] }),
  postJSON: jest.fn().mockResolvedValue({}),
  postJSONEnvelope: jest.fn().mockResolvedValue({ success: true, data: {} }),
  putJSON: jest.fn().mockResolvedValue({}),
}));

const mockRealtime = jest.fn(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (..._args: unknown[]) => ({
    connected: false,
    subscribed: false,
    denied: null as string | null,
    lastEventAt: null as number | null,
  }),
);
jest.mock("@/hooks/useRealtimeInvalidation", () => ({
  useRealtimeInvalidation: (...args: unknown[]) => mockRealtime(...args),
}));

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<BloodBankPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
  });

  it("subscribes to staff:blood-bank on the [\"blood-bank\"] root and shows ○ Offline when down", async () => {
    renderWithQuery(<BloodBankPage />);
    const ind = await screen.findByTestId("blood-bank-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:blood-bank", [["blood-bank"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<BloodBankPage />);
    const ind = await screen.findByTestId("blood-bank-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });

  it("creates a blood request with the route's required idempotency key", async () => {
    renderWithQuery(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: "New Request" }));
    fireEvent.change(screen.getByPlaceholderText("Patient UID"), {
      target: { value: "a9999999-9999-4999-8999-999999999a03" },
    });
    fireEvent.change(screen.getByPlaceholderText("Clinical indication"), {
      target: { value: "Symptomatic anaemia Hb 6.2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Request" }));

    await waitFor(() => expect(postJSONEnvelope).toHaveBeenCalledTimes(1));
    expect(postJSONEnvelope).toHaveBeenCalledWith(
      "/api/v1/blood-bank/request",
      expect.objectContaining({
        patient_uid: "a9999999-9999-4999-8999-999999999a03",
        clinical_indication: "Symptomatic anaemia Hb 6.2",
      }),
      true,
      {
        "Idempotency-Key": expect.stringMatching(/^[A-Za-z0-9_\-:.]{1,200}$/),
      },
    );
  });
});
