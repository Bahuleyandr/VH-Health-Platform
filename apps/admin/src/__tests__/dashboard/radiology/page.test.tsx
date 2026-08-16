import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import RadiologyPage from "@/app/(with-auth)/dashboard/radiology/page";
import { postJSON } from "@/lib/api";

jest.mock("@/lib/api", () => {
  class APIError extends Error {
    status: number;
    data?: unknown;
    constructor(message: string, status: number, data?: unknown) {
      super(message);
      this.name = "APIError";
      this.status = status;
      this.data = data;
    }
  }
  return {
    APIError,
    fetchAdminAPI: jest.fn().mockResolvedValue({ data: [] }),
    postJSON: jest.fn().mockResolvedValue({}),
    putJSON: jest.fn().mockResolvedValue({}),
  };
});

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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

async function openNewOrderTab() {
  renderWithQuery(<RadiologyPage />);
  fireEvent.click(await screen.findByRole("button", { name: "New Order" }));
  await screen.findByText("New Radiology Order");
}

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText("Patient UID *"), {
    target: { value: "cf000000-0000-4000-8000-000000000b01" },
  });
  fireEvent.change(
    screen.getByPlaceholderText("Modality (xray, CT, MRI, ultrasound) *"),
    {
      target: { value: "ct" },
    },
  );
  fireEvent.change(
    screen.getByPlaceholderText("Body part (Chest, Abdomen) *"),
    {
      target: { value: "Abdomen" },
    },
  );
  fireEvent.change(screen.getByPlaceholderText("Clinical indication *"), {
    target: { value: "Staging CT" },
  });
}

describe("<RadiologyPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({
      connected: false,
      subscribed: false,
      denied: null,
      lastEventAt: null,
    });
  });
  it('subscribes to staff:radiology on the ["radiology"] root and shows ○ Offline when down', async () => {
    renderWithQuery(<RadiologyPage />);
    const ind = await screen.findByTestId("radiology-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:radiology", [
      ["radiology"],
    ]);
  });
  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({
      connected: true,
      subscribed: true,
      denied: null,
      lastEventAt: Date.now(),
    });
    renderWithQuery(<RadiologyPage />);
    expect(
      await screen.findByTestId("radiology-realtime-indicator"),
    ).toHaveTextContent("Live");
  });

  describe("New Order contrast flow", () => {
    it("renders the contrast plan control defaulting to server-side derivation", async () => {
      await openNewOrderTab();
      const contrastSelect = screen.getByLabelText(
        "Contrast plan",
      ) as HTMLSelectElement;
      expect(contrastSelect.value).toBe("");
      expect(
        screen.getByText(
          "Contrast: decide by modality (CT/MRI/fluoro presumed + screened)",
        ),
      ).toBeInTheDocument();
    });

    it("omits contrast fields entirely when derivation is left to the server", async () => {
      await openNewOrderTab();
      fillRequiredFields();
      fireEvent.click(screen.getByRole("button", { name: /Create Order/ }));
      await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
      const payload = (postJSON as jest.Mock).mock.calls[0][1];
      expect(payload).not.toHaveProperty("contrast_planned");
      expect(payload).not.toHaveProperty("override");
    });

    it("sends explicit negation when 'Without contrast' is chosen", async () => {
      await openNewOrderTab();
      fillRequiredFields();
      fireEvent.change(screen.getByLabelText("Contrast plan"), {
        target: { value: "false" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Create Order/ }));
      await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
      expect((postJSON as jest.Mock).mock.calls[0][1]).toMatchObject({
        contrast_planned: false,
      });
    });

    it("surfaces a contrast allergy block and resubmits with the acknowledged override", async () => {
      const { APIError } = jest.requireMock("@/lib/api");
      (postJSON as jest.Mock)
        .mockRejectedValueOnce(
          new APIError("blocked", 409, {
            code: "RADIOLOGY_CONTRAST_ALLERGY_BLOCKED",
            details: {
              blockers: [
                {
                  type: "CONTRAST_ALLERGY_CONFLICT",
                  allergy: "Iodinated contrast",
                  severity: "SEVERE",
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce({});

      await openNewOrderTab();
      fillRequiredFields();
      fireEvent.click(screen.getByRole("button", { name: /Create Order/ }));

      await screen.findByText("Contrast allergy screen blocked this order");
      expect(screen.getByText(/Iodinated contrast/)).toBeInTheDocument();

      const overrideButton = screen.getByRole("button", {
        name: /Acknowledge risk/,
      });
      expect(overrideButton).toBeDisabled();
      fireEvent.change(screen.getByPlaceholderText(/Override reason/), {
        target: { value: "Premedicated per contrast allergy protocol" },
      });
      expect(overrideButton).not.toBeDisabled();
      fireEvent.click(overrideButton);

      await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(2));
      expect((postJSON as jest.Mock).mock.calls[1][1]).toMatchObject({
        override: { reason: "Premedicated per contrast allergy protocol" },
      });
      await screen.findByText("Order created successfully.");
    });
  });
});
