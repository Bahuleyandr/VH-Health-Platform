/**
 * Tests for the NL13-P1f cath quality views:
 *  - DoseRollupTab fails closed: thresholds_pending banner + "pending" breach
 *    cells until the owner configures thresholds; configured data shows counts.
 *  - ComplicationRegistryTab renders registry rows and posts review updates.
 */

import ComplicationRegistryTab from "@/app/(with-auth)/dashboard/quality/cath/components/ComplicationRegistryTab";
import DoseRollupTab from "@/app/(with-auth)/dashboard/quality/cath/components/DoseRollupTab";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn(),
}));

import { fetchAdminAPI } from "@/lib/api";

const fetchAdminAPIMock = fetchAdminAPI as jest.Mock;

function withQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const pendingSettings = {
  thresholds_status: "thresholds_pending",
  configured: false,
  settings: null,
};

const configuredSettings = {
  thresholds_status: "configured",
  configured: true,
  settings: {
    fluoro_time_alert_min: 30,
    dap_alert_gy_cm2: 300,
    air_kerma_alert_mgy: 2000,
    contrast_volume_alert_ml: 200,
  },
};

function rollupResponse(thresholdsStatus: string, breachCount: number | null) {
  return {
    period: { from: "2026-03-01", to: "2026-08-31" },
    group_by: "month",
    thresholds_status: thresholdsStatus,
    thresholds: thresholdsStatus === "configured" ? configuredSettings.settings : null,
    rows: [
      {
        bucket: "2026-08",
        case_count: 4,
        record_count: 6,
        total_fluoro_time_min: 120,
        avg_fluoro_time_min: 20,
        total_dap_gy_cm2: 900,
        avg_dap_gy_cm2: 150,
        total_air_kerma_mgy: 5400,
        total_contrast_ml: 800,
        avg_contrast_ml: 133.3,
        breach_count: breachCount,
      },
    ],
  };
}

describe("<DoseRollupTab />", () => {
  beforeEach(() => fetchAdminAPIMock.mockReset());

  it("fails closed to thresholds_pending until the owner configures limits", async () => {
    fetchAdminAPIMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/quality/cath/dose-settings")) {
        return Promise.resolve(pendingSettings);
      }
      return Promise.resolve(rollupResponse("thresholds_pending", null));
    });

    render(withQueryClient(<DoseRollupTab />));

    expect(await screen.findByText(/Thresholds pending/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Configure thresholds/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText("2026-08")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText(/No default dose limits are assumed/)).toBeInTheDocument();
  });

  it("shows breach counts once thresholds are configured", async () => {
    fetchAdminAPIMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/quality/cath/dose-settings")) {
        return Promise.resolve(configuredSettings);
      }
      return Promise.resolve(rollupResponse("configured", 2));
    });

    render(withQueryClient(<DoseRollupTab />));

    expect(await screen.findByText("2026-08")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("pending")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edit thresholds/ })).toBeInTheDocument();
  });

  it("saves owner thresholds through the quality/cath endpoint", async () => {
    const user = userEvent.setup();
    fetchAdminAPIMock.mockImplementation((endpoint: string, init?: { method?: string }) => {
      if (endpoint.startsWith("/quality/cath/dose-settings")) {
        if (init?.method === "PUT") {
          return Promise.resolve({ settings: configuredSettings.settings });
        }
        return Promise.resolve(pendingSettings);
      }
      return Promise.resolve(rollupResponse("thresholds_pending", null));
    });

    render(withQueryClient(<DoseRollupTab />));
    await user.click(await screen.findByRole("button", { name: /Configure thresholds/ }));
    const inputs = screen.getAllByPlaceholderText("unset");
    await user.type(inputs[0], "30");
    await user.click(screen.getByRole("button", { name: /Save thresholds/ }));

    await waitFor(() => {
      expect(fetchAdminAPIMock).toHaveBeenCalledWith(
        "/quality/cath/dose-settings",
        expect.objectContaining({
          method: "PUT",
          body: expect.objectContaining({ fluoro_time_alert_min: 30 }),
        }),
      );
    });
  });
});

describe("<ComplicationRegistryTab />", () => {
  beforeEach(() => fetchAdminAPIMock.mockReset());

  const entry = {
    id: 11,
    case_id: 42,
    procedure_log_id: 7,
    patient_uid: "11111111-1111-4111-8111-111111111111",
    patient_name: "Asha Rao",
    complication_code: "OWNER-7",
    complication_category: "vascular_access",
    description: "Access-site hematoma",
    severity: "minor",
    outcome: null,
    review_status: "open",
    review_notes: null,
    reviewed_at: null,
    occurred_at: "2026-08-03T06:15:00.000Z",
    source: "procedure_log",
    created_at: "2026-08-03T06:20:00.000Z",
    requested_procedure: "Primary PCI",
    urgency: "emergency",
  };

  it("renders registry entries with severity and review state", async () => {
    fetchAdminAPIMock.mockResolvedValue({ entries: [entry], count: 1 });

    render(withQueryClient(<ComplicationRegistryTab />));

    expect(await screen.findByText("Asha Rao")).toBeInTheDocument();
    // Scope to the table — the filter dropdowns carry the same option labels.
    const table = screen.getByRole("table");
    expect(within(table).getByText("vascular_access")).toBeInTheDocument();
    expect(within(table).getByText("minor")).toBeInTheDocument();
    expect(within(table).getByText("open")).toBeInTheDocument();
  });

  it("posts a review transition for an entry", async () => {
    const user = userEvent.setup();
    fetchAdminAPIMock.mockImplementation((endpoint: string, init?: { method?: string }) => {
      if (endpoint.includes("/review") && init?.method === "POST") {
        return Promise.resolve({ entry: { ...entry, review_status: "reviewed" } });
      }
      return Promise.resolve({ entries: [entry], count: 1 });
    });

    render(withQueryClient(<ComplicationRegistryTab />));
    await user.click(await screen.findByRole("button", { name: /Review/ }));
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(fetchAdminAPIMock).toHaveBeenCalledWith(
        "/quality/cath/complication-registry/11/review",
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({ review_status: "reviewed" }),
        }),
      );
    });
  });

  it("shows the empty state when no complications are registered", async () => {
    fetchAdminAPIMock.mockResolvedValue({ entries: [], count: 0 });

    render(withQueryClient(<ComplicationRegistryTab />));

    expect(
      await screen.findByText(/No complication registry entries/),
    ).toBeInTheDocument();
  });
});
