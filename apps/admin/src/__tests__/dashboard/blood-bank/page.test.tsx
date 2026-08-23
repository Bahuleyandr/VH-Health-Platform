import BloodBankPage from "@/app/(with-auth)/dashboard/blood-bank/page";
import { postJSONEnvelope } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn().mockResolvedValue({ data: [] }),
  postJSON: jest.fn().mockResolvedValue({}),
  postJSONEnvelope: jest.fn().mockResolvedValue({ success: true, data: {} }),
  putJSON: jest.fn().mockResolvedValue({}),
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

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<BloodBankPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({
      connected: false,
      subscribed: false,
      denied: null,
      lastEventAt: null,
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('subscribes to staff:blood-bank on the ["blood-bank"] root and shows ○ Offline when down', async () => {
    renderWithQuery(<BloodBankPage />);
    const ind = await screen.findByTestId("blood-bank-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:blood-bank", [
      ["blood-bank"],
    ]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({
      connected: true,
      subscribed: true,
      denied: null,
      lastEventAt: Date.now(),
    });
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

  it("reuses the blood request idempotency key after an ambiguous failure", async () => {
    const postRequest = jest.mocked(postJSONEnvelope);
    postRequest
      .mockRejectedValueOnce(new Error("Service unavailable"))
      .mockResolvedValueOnce({ success: true, data: {} });
    const alertSpy = jest
      .spyOn(window, "alert")
      .mockImplementation(() => undefined);
    renderWithQuery(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: "New Request" }));
    fireEvent.change(screen.getByPlaceholderText("Patient UID"), {
      target: { value: "a9999999-9999-4999-8999-999999999a03" },
    });
    fireEvent.change(screen.getByPlaceholderText("Clinical indication"), {
      target: { value: "Symptomatic anaemia Hb 6.2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Request" }));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith("Service unavailable"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Request" }));

    await waitFor(() => expect(postRequest).toHaveBeenCalledTimes(2));
    const firstKey = (postRequest.mock.calls[0][3] as Record<string, string>)[
      "Idempotency-Key"
    ];
    const retryKey = (postRequest.mock.calls[1][3] as Record<string, string>)[
      "Idempotency-Key"
    ];
    expect(retryKey).toBe(firstKey);
  });

  it("rotates the blood request idempotency key when the logical payload changes", async () => {
    const postRequest = jest.mocked(postJSONEnvelope);
    postRequest
      .mockRejectedValueOnce(new Error("Service unavailable"))
      .mockResolvedValueOnce({ success: true, data: {} });
    const alertSpy = jest
      .spyOn(window, "alert")
      .mockImplementation(() => undefined);
    renderWithQuery(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: "New Request" }));
    fireEvent.change(screen.getByPlaceholderText("Patient UID"), {
      target: { value: "a9999999-9999-4999-8999-999999999a03" },
    });
    fireEvent.change(screen.getByPlaceholderText("Clinical indication"), {
      target: { value: "Symptomatic anaemia Hb 6.2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Request" }));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith("Service unavailable"),
    );
    fireEvent.change(screen.getByPlaceholderText("Clinical indication"), {
      target: { value: "Active bleeding with haemodynamic instability" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Request" }));

    await waitFor(() => expect(postRequest).toHaveBeenCalledTimes(2));
    const firstKey = (postRequest.mock.calls[0][3] as Record<string, string>)[
      "Idempotency-Key"
    ];
    const changedPayloadKey = (
      postRequest.mock.calls[1][3] as Record<string, string>
    )["Idempotency-Key"];
    expect(changedPayloadKey).not.toBe(firstKey);
  });

  it("rotates the blood request idempotency key after success", async () => {
    const postRequest = jest.mocked(postJSONEnvelope);
    renderWithQuery(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: "New Request" }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.change(screen.getByPlaceholderText("Patient UID"), {
        target: { value: "a9999999-9999-4999-8999-999999999a03" },
      });
      fireEvent.change(screen.getByPlaceholderText("Clinical indication"), {
        target: { value: "Symptomatic anaemia Hb 6.2" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create Request" }));
      await waitFor(() =>
        expect(postRequest).toHaveBeenCalledTimes(attempt + 1),
      );
    }

    const firstKey = (postRequest.mock.calls[0][3] as Record<string, string>)[
      "Idempotency-Key"
    ];
    const newIntentKey = (
      postRequest.mock.calls[1][3] as Record<string, string>
    )["Idempotency-Key"];
    expect(newIntentKey).not.toBe(firstKey);
  });
});
