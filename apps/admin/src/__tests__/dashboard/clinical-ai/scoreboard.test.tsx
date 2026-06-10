import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import AiOutcomeScoreboardPage from "@/app/(with-auth)/dashboard/clinical-ai/scoreboard/page";
import { getAiOutcomeScoreboard, type AiOutcomeScoreboard } from "@/lib/api/aiOutcomeScoreboard";

jest.mock("@/lib/api/aiOutcomeScoreboard", () => ({
  getAiOutcomeScoreboard: jest.fn(),
}));

const mockedGetScoreboard = getAiOutcomeScoreboard as jest.MockedFunction<typeof getAiOutcomeScoreboard>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const SCOREBOARD: AiOutcomeScoreboard = {
  tenant_id: "00000000-0000-4000-8000-000000000001",
  period_start: "2026-03-12T00:00:00.000Z",
  period_end: "2026-06-10T00:00:00.000Z",
  period_days: 90,
  module_key: "ALL",
  modules: [
    {
      module_key: "discharge_summary",
      display_name: "Discharge Summary",
      enabled: true,
      generations: { total: 10, ai_generated: 8, fallback: 2 },
      reviews: {
        total: 8,
        decided: 6,
        pending: 2,
        accepted: 3,
        edited: 2,
        rejected: 1,
        needs_revision: 0,
        acceptance_rate_pct: 50,
        used_rate_pct: 83.3,
        avg_review_latency_minutes: 42.4,
      },
      edits: { sample_count: 2, mean_edit_distance_pct: 12.5, median_edit_distance_pct: 12.5 },
      safety: {
        flagged_total: 5,
        flagged_decided: 4,
        flagged_confirmed: 3,
        flagged_overridden: 1,
        flag_precision_pct: 75,
        flag_override_rate_pct: 25,
        missed_reject_count: 2,
      },
      time_to_sign: [
        {
          note_type: "discharge",
          ai_signed_count: 6,
          ai_median_minutes: 12,
          ai_avg_minutes: 14,
          baseline_signed_count: 20,
          baseline_median_minutes: 30,
          baseline_avg_minutes: 31,
          median_delta_minutes: -18,
        },
      ],
    },
    {
      module_key: "idle_enabled_module",
      display_name: "Idle But Enabled",
      enabled: true,
      generations: { total: 0, ai_generated: 0, fallback: 0 },
      reviews: {
        total: 0,
        decided: 0,
        pending: 0,
        accepted: 0,
        edited: 0,
        rejected: 0,
        needs_revision: 0,
        acceptance_rate_pct: null,
        used_rate_pct: null,
        avg_review_latency_minutes: null,
      },
      edits: { sample_count: 0, mean_edit_distance_pct: null, median_edit_distance_pct: null },
      safety: {
        flagged_total: 0,
        flagged_decided: 0,
        flagged_confirmed: 0,
        flagged_overridden: 0,
        flag_precision_pct: null,
        flag_override_rate_pct: null,
        missed_reject_count: 0,
      },
      time_to_sign: [],
    },
  ],
  totals: {
    modules_with_activity: 1,
    generations: { total: 10, ai_generated: 8, fallback: 2 },
    reviews: {
      total: 8,
      decided: 6,
      pending: 2,
      accepted: 3,
      edited: 2,
      rejected: 1,
      needs_revision: 0,
      acceptance_rate_pct: 50,
      used_rate_pct: 83.3,
    },
    edits: { sample_count: 2, mean_edit_distance_pct: 12.5, median_edit_distance_pct: 12.5 },
    safety: {
      flagged_total: 5,
      flagged_decided: 4,
      flagged_confirmed: 3,
      flagged_overridden: 1,
      flag_precision_pct: 75,
      flag_override_rate_pct: 25,
      missed_reject_count: 2,
    },
    time_to_sign: { ai_signed_count: 6, baseline_signed_count: 20, ai_avg_minutes: 14, baseline_avg_minutes: 31 },
  },
  medication_safety: {
    finding_count: 16,
    critical_count: 3,
    blocker_count: 4,
    overridden_count: 1,
    override_rate_pct: 25,
    by_type: [
      {
        review_type: "drug_interaction",
        finding_count: 10,
        critical_count: 2,
        blocker_count: 4,
        overridden_count: 1,
        override_rate_pct: 25,
      },
      {
        review_type: "allergy",
        finding_count: 6,
        critical_count: 1,
        blocker_count: 0,
        overridden_count: 0,
        override_rate_pct: null,
      },
    ],
  },
  definitions: {
    acceptance_rate_pct: "Reviews decided accepted/signed/approved as a share of all decided reviews.",
    null_rates: "Rates are null when there is no data to rate.",
  },
  computed_at: "2026-06-10T12:00:00.000Z",
  decision_support_only: true,
  read_only: true,
};

describe("<AiOutcomeScoreboardPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetScoreboard.mockResolvedValue(SCOREBOARD);
  });

  it("renders totals, per-module rows, and medication-safety overrides", async () => {
    renderWithQuery(<AiOutcomeScoreboardPage />);

    // The mono module_key only renders in the table (options show display_name).
    await screen.findByText("discharge_summary");
    expect(mockedGetScoreboard).toHaveBeenCalledWith({ periodDays: 90 });

    // Totals cards
    expect(screen.getByText("Acceptance (90d)")).toBeInTheDocument();
    expect(screen.getAllByText("50%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("75% / 25%").length).toBeGreaterThan(0);

    // Module row details: time-to-sign delta and enabled badge
    expect(screen.getByText(/\(-18 min\)/)).toBeInTheDocument();
    expect(screen.getAllByText("enabled").length).toBe(2);

    // Idle module renders "—" honest-null rates, not 0%
    expect(screen.getByText("idle_enabled_module")).toBeInTheDocument();
    expect(screen.getAllByText("— / —").length).toBeGreaterThan(0);

    // Medication safety table
    expect(screen.getByText("drug_interaction")).toBeInTheDocument();
    const allergyRow = screen.getByText("allergy").closest("tr");
    expect(allergyRow).toHaveTextContent("0 / —");
  });

  it("refetches when the period changes", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiOutcomeScoreboardPage />);
    await screen.findByText("discharge_summary");

    await user.selectOptions(screen.getByLabelText("Period"), "30");
    await waitFor(() => expect(mockedGetScoreboard).toHaveBeenCalledWith({ periodDays: 30 }));
  });

  it("filters the table by module without refetching", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiOutcomeScoreboardPage />);
    await screen.findByText("discharge_summary");

    await user.selectOptions(screen.getByLabelText("Module filter"), "idle_enabled_module");
    // Mono module keys render only in table rows, so they prove the filter.
    expect(screen.queryByText("discharge_summary")).not.toBeInTheDocument();
    expect(screen.getByText("idle_enabled_module")).toBeInTheDocument();
    expect(mockedGetScoreboard).toHaveBeenCalledTimes(1);
  });
});
