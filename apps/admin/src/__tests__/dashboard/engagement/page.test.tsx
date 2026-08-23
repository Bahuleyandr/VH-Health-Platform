import EngagementPage from "@/app/(with-auth)/dashboard/engagement/page";
import { APIError } from "@/lib/api/core";
import {
  approveCampaign,
  createEngagementCampaign,
  dryRunCampaign,
  getEngagementSettings,
  queueDueCampaignRecipients,
  submitCampaignForApproval,
  type EngagementCampaign,
  type EngagementSettings,
} from "@/lib/api/engagement";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "react-hot-toast";

jest.mock("@/lib/api/engagement", () => ({
  ENGAGEMENT_CAMPAIGN_TYPES: [
    "appointment_recall",
    "no_show_recall",
    "feedback_nps_request",
    "generic_follow_up_reminder",
    "rpm_enrollment_reminder",
  ],
  ENGAGEMENT_CHANNELS: ["push", "sms", "whatsapp", "email", "inapp"],
  ENGAGEMENT_TEMPLATE_VARIABLES: [
    "first_name",
    "salutation",
    "appointment_window",
    "department_name",
    "clinic_name",
    "call_to_action_url",
    "support_phone",
    "campaign_token",
    "feedback_link",
    "tenant_name",
  ],
  ENGAGEMENT_CAMPAIGN_STATUSES: [
    "draft",
    "dry_run",
    "pending_approval",
    "scheduled",
    "running",
    "paused",
    "completed",
    "archived",
    "cancelled",
  ],
  getEngagementSettings: jest.fn(),
  updateEngagementSettings: jest.fn(),
  createEngagementTemplate: jest.fn(),
  createEngagementCampaign: jest.fn(),
  dryRunCampaign: jest.fn(),
  materializeCampaignRecipients: jest.fn(),
  submitCampaignForApproval: jest.fn(),
  approveCampaign: jest.fn(),
  queueDueCampaignRecipients: jest.fn(),
}));

const SETTINGS: EngagementSettings = {
  tenant_id: "00000000-0000-4000-8000-000000000001",
  enabled: true,
  acceptance_snapshot: { accepted: true },
  emergency_stop: false,
  quiet_hours_start: "21:00",
  quiet_hours_end: "08:00",
  tenant_daily_cap: 250,
  per_patient_cooldown_hours: 48,
  consent_max_age_days: 365,
  channel_caps: { sms: 100 },
  default_consent_map: { appointment_recall: "care_reminder_whatsapp" },
};

const CAMPAIGN: EngagementCampaign = {
  id: 11,
  tenant_id: SETTINGS.tenant_id,
  campaign_type: "appointment_recall",
  objective: "Recall lapsed OP follow-ups",
  status: "draft",
  template_id: 4,
  channels: ["push"],
  schedule_policy: {},
  rate_policy: {},
  audience_kind: "cohort",
  approval_required_role: "care_team",
  scheduled_at: null,
  created_at: "2026-08-20T10:00:00.000Z",
  updated_at: "2026-08-20T10:00:00.000Z",
};

const PATIENT_A = "22222222-2222-4222-8222-222222222222";
const PATIENT_B = "33333333-3333-4333-8333-333333333333";

const DRY_RUN_RESULT = {
  snapshot: {
    id: 91,
    tenant_id: SETTINGS.tenant_id,
    campaign_id: 11,
    snapshot_kind: "dry_run" as const,
    cohort_source: {},
    cohort_hash: "abc",
    materialized_count: 2,
    eligible_count: 1,
    suppressed_count: 1,
    source_tables: [],
    minimum_cohort_size: 1,
    created_by: null,
    created_at: "2026-08-20T10:05:00.000Z",
  },
  counts: { materialized: 2, eligible: 1, suppressed: 1 },
  recipients: [
    {
      eligible: true,
      reason: null,
      patient_uid: PATIENT_A,
      channel: "push" as const,
      required_consent_type: "care_reminder_whatsapp",
    },
    {
      eligible: false,
      reason: "missing_consent",
      patient_uid: PATIENT_B,
      channel: "push" as const,
      required_consent_type: "care_reminder_whatsapp",
    },
  ],
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EngagementPage />
    </QueryClientProvider>,
  );
}

async function createDraftCampaign() {
  fireEvent.change(await screen.findByLabelText("Template id"), {
    target: { value: "4" },
  });
  fireEvent.change(screen.getByLabelText("Objective"), {
    target: { value: "Recall lapsed OP follow-ups" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Create draft campaign" }),
  );
  await screen.findByText(/Campaign #11 — appointment recall/);
}

describe("<EngagementPage /> authoring safety order", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getEngagementSettings as jest.Mock).mockResolvedValue(SETTINGS);
    (createEngagementCampaign as jest.Mock).mockResolvedValue(CAMPAIGN);
    (dryRunCampaign as jest.Mock).mockResolvedValue(DRY_RUN_RESULT);
  });

  it("walks dry-run → approval → queue in order and never enables a later step early", async () => {
    (submitCampaignForApproval as jest.Mock).mockResolvedValue({
      ...CAMPAIGN,
      status: "pending_approval",
    });
    (approveCampaign as jest.Mock).mockResolvedValue({
      ...CAMPAIGN,
      status: "scheduled",
    });
    (queueDueCampaignRecipients as jest.Mock).mockResolvedValue({
      claimed: 1,
      queued: 1,
      suppressed: 0,
      failed: 0,
    });
    renderPage();
    await createDraftCampaign();

    // Draft: every later step is locked.
    expect(
      screen.getByRole("button", { name: "Submit for approval" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Approve campaign" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Queue due recipients" }),
    ).toBeDisabled();

    // Dry run against explicit candidates.
    fireEvent.change(
      screen.getByLabelText("Candidate patient UIDs (one per line)"),
      { target: { value: `${PATIENT_A}\n${PATIENT_B}` } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Run dry run" }));
    await waitFor(() =>
      expect(dryRunCampaign).toHaveBeenCalledWith(11, {
        patients: [{ patient_uid: PATIENT_A }, { patient_uid: PATIENT_B }],
      }),
    );

    // The preview surfaces the API's per-candidate verdicts.
    expect(await screen.findByText("missing consent")).toBeInTheDocument();
    expect(
      screen.getByText(/1 eligible \/ 1 suppressed of 2/),
    ).toBeInTheDocument();

    // dry_run: submit unlocks, approve/queue still locked.
    const submitButton = screen.getByRole("button", {
      name: "Submit for approval",
    });
    await waitFor(() => expect(submitButton).toBeEnabled());
    expect(
      screen.getByRole("button", { name: "Approve campaign" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Queue due recipients" }),
    ).toBeDisabled();

    fireEvent.click(submitButton);
    await waitFor(() =>
      expect(submitCampaignForApproval).toHaveBeenCalledWith(11, undefined),
    );

    // pending_approval: approve unlocks behind a confirmation dialog.
    const approveButton = screen.getByRole("button", {
      name: "Approve campaign",
    });
    await waitFor(() => expect(approveButton).toBeEnabled());
    expect(
      screen.getByRole("button", { name: "Queue due recipients" }),
    ).toBeDisabled();
    fireEvent.click(approveButton);
    expect(approveCampaign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approveCampaign).toHaveBeenCalledWith(11, undefined),
    );

    // scheduled: queueing unlocks, also behind a confirmation dialog.
    const queueButton = screen.getByRole("button", {
      name: "Queue due recipients",
    });
    await waitFor(() => expect(queueButton).toBeEnabled());
    fireEvent.click(queueButton);
    expect(queueDueCampaignRecipients).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Queue for delivery" }));
    await waitFor(() =>
      expect(queueDueCampaignRecipients).toHaveBeenCalledWith(11, 50),
    );
  });

  it("surfaces a backend refusal verbatim and keeps the campaign in its prior state", async () => {
    const refusal =
      "Invalid status transition from draft to pending_approval. Allowed transitions: dry_run";
    (submitCampaignForApproval as jest.Mock).mockRejectedValue(
      new APIError(refusal, 400, { code: "INVALID_TRANSITION" }),
    );
    renderPage();
    await createDraftCampaign();

    fireEvent.change(
      screen.getByLabelText("Candidate patient UIDs (one per line)"),
      { target: { value: PATIENT_A } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Run dry run" }));
    const submitButton = screen.getByRole("button", {
      name: "Submit for approval",
    });
    await waitFor(() => expect(submitButton).toBeEnabled());

    fireEvent.click(submitButton);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(refusal));
    expect(screen.getByRole("alert")).toHaveTextContent(
      `Backend refused: ${refusal}`,
    );
    // Still locked: the refusal must not advance the workflow.
    expect(
      screen.getByRole("button", { name: "Approve campaign" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Queue due recipients" }),
    ).toBeDisabled();
  });

  it("keeps queueing locked while a campaign is only dry-run even after materialization becomes possible", async () => {
    renderPage();
    await createDraftCampaign();

    fireEvent.change(
      screen.getByLabelText("Candidate patient UIDs (one per line)"),
      { target: { value: PATIENT_A } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Run dry run" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Materialize recipients" }),
      ).toBeEnabled(),
    );
    expect(
      screen.getByRole("button", { name: "Queue due recipients" }),
    ).toBeDisabled();
  });
});
