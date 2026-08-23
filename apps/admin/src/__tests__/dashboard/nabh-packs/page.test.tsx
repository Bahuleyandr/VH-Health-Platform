import NabhPacksPage from "@/app/(with-auth)/dashboard/nabh-packs/page";
import { APIError } from "@/lib/api/core";
import {
  freezeNabhPeriodPack,
  getFrozenNabhPeriodPack,
  getNabhIndicators,
  listNabhSnapshots,
  type NabhFrozenPeriodPack,
  type NabhIndicatorPack,
} from "@/lib/api/nabhPacks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/nabhPacks", () => ({
  getNabhIndicators: jest.fn(),
  freezeNabhPeriodPack: jest.fn(),
  getFrozenNabhPeriodPack: jest.fn(),
  saveNabhSnapshot: jest.fn(),
  listNabhSnapshots: jest.fn(),
  downloadNabhPeriodPack: jest.fn(),
  downloadNabhIndicatorsCsv: jest.fn(),
}));

const EXPORT_CONTRACT = {
  pack_type: "NABH_PERIOD_PACK",
  canonical_format_status: "pending_assessor_format",
  evidence_control_code: "NABH_AUDIT_EXPORT",
  supported_formats: ["json", "csv", "pdf"],
  phi_policy:
    "Aggregate quality indicators only; no patient identifiers or raw clinical payloads.",
  acceptance_boundary:
    "Hospital owner must confirm the assessor-required file format before marking evidence accepted.",
};

const INDICATOR_PACK: NabhIndicatorPack = {
  period: { from: "2026-07-01", to: "2026-07-31" },
  export_contract: EXPORT_CONTRACT,
  indicator_dictionary: {},
  indicators: [
    {
      code: "ama_lama_discharge_pct",
      label: "Discharges against medical advice (AMA/LAMA)",
      unit: "%",
      value: 3.12,
      numerator: 4,
      denominator: 128,
      available: true,
      definition: { chapter: "QPS" },
      details: {},
    },
    {
      code: "hai_rate_per_1000_patient_days",
      label: "hai_rate_per_1000_patient_days",
      unit: null,
      value: null,
      numerator: null,
      denominator: null,
      available: false,
      details: { error: "source_table_missing" },
    },
  ],
};

const FROZEN_PACK: NabhFrozenPeriodPack = {
  ...INDICATOR_PACK,
  pack_type: "NABH_PERIOD_PACK",
  status: "frozen",
  tenant_id: "00000000-0000-4000-8000-000000000001",
  frozen_at: "2026-08-01T04:30:00.000Z",
  generated_at: "2026-08-01T04:30:05.000Z",
  evidence_attachment: {
    control_code: "NABH_AUDIT_EXPORT",
    status: "pending_operator_acceptance",
    evidence_table: "india_compliance_evidence",
    attach_files: ["json", "csv", "pdf"],
    note: EXPORT_CONTRACT.acceptance_boundary,
  },
  indicator_count: 12,
  expected_indicator_count: 13,
  missing_indicator_codes: ["hai_rate_per_1000_patient_days"],
  snapshot_saved: 12,
};

const NOT_FROZEN = new APIError(
  "NABH period pack has not been frozen for this period",
  404,
  { code: "NABH_PERIOD_PACK_NOT_FROZEN" },
);

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NabhPacksPage />
    </QueryClientProvider>,
  );
}

async function computePeriod() {
  fireEvent.change(screen.getByLabelText("Period from"), {
    target: { value: "2026-07-01" },
  });
  fireEvent.change(screen.getByLabelText("Period to"), {
    target: { value: "2026-07-31" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Compute indicators" }));
}

describe("<NabhPacksPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listNabhSnapshots as jest.Mock).mockResolvedValue({
      snapshots: [],
      count: 0,
    });
    (getNabhIndicators as jest.Mock).mockResolvedValue(INDICATOR_PACK);
    (getFrozenNabhPeriodPack as jest.Mock).mockRejectedValue(NOT_FROZEN);
  });

  it("computes indicators for the picked period and marks unavailable ones", async () => {
    renderPage();
    await computePeriod();

    await waitFor(() =>
      expect(getNabhIndicators).toHaveBeenCalledWith({
        from: "2026-07-01",
        to: "2026-07-31",
      }),
    );
    expect(
      await screen.findByText("Discharges against medical advice (AMA/LAMA)"),
    ).toBeInTheDocument();
    expect(screen.getByText("3.12 %")).toBeInTheDocument();
    expect(screen.getByText("unavailable")).toBeInTheDocument();
    expect(screen.getByText("source_table_missing")).toBeInTheDocument();
    // An unfrozen period renders as an informational state, not an error.
    expect(await screen.findByText("Not frozen yet")).toBeInTheDocument();
  });

  it("freezes a period pack only after confirmation and renders the returned summary", async () => {
    (freezeNabhPeriodPack as jest.Mock).mockResolvedValue(FROZEN_PACK);
    renderPage();
    await computePeriod();
    await screen.findByText("Not frozen yet");

    fireEvent.click(
      screen.getByRole("button", { name: "Freeze period pack" }),
    );
    expect(freezeNabhPeriodPack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Freeze pack" }));

    await waitFor(() =>
      expect(freezeNabhPeriodPack).toHaveBeenCalledWith({
        from: "2026-07-01",
        to: "2026-07-31",
      }),
    );
    expect(await screen.findByText("12 of 13")).toBeInTheDocument();
    expect(
      screen.getByText(/Missing from this frozen pack:/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Aggregate quality indicators only; no patient identifiers or raw clinical payloads.',
      ),
    ).toBeInTheDocument();
  });

  it("lists persisted snapshots read-only", async () => {
    (listNabhSnapshots as jest.Mock).mockResolvedValue({
      snapshots: [
        {
          period_start: "2026-07-01",
          period_end: "2026-07-31",
          indicator_code: "ama_lama_discharge_pct",
          label: "Discharges against medical advice (AMA/LAMA)",
          value: 3.12,
          numerator: 4,
          denominator: 128,
          unit: "%",
          details: {},
          computed_at: "2026-08-01T04:30:00.000Z",
        },
      ],
      count: 1,
    });
    renderPage();

    expect(await screen.findByText("Snapshots (1)")).toBeInTheDocument();
    expect(
      screen.getByText("Discharges against medical advice (AMA/LAMA)"),
    ).toBeInTheDocument();
    expect(screen.getByText("ama_lama_discharge_pct")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01 → 2026-07-31")).toBeInTheDocument();
  });
});
