import EngagementPage from "@/app/(with-auth)/dashboard/engagement/page";
import { APIError } from "@/lib/api/core";
import {
  approveCampaign,
  createEngagementCampaign,
  dryRunCampaign,
  getEngagementCampaign,
  getEngagementSettings,
  listEngagementCampaigns,
  listEngagementTemplates,
  queueDueCampaignRecipients,
  submitCampaignForApproval,
  type EngagementCampaign,
  type EngagementPagination,
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
  listEngagementCampaigns: jest.fn(),
  listEngagementTemplates: jest.fn(),
  getEngagementCampaign: jest.fn(),
}));

const PAGINATION: EngagementPagination = {
  page: 1,
  limit: 50,
  total: 0,
  totalPages: 1,
  hasNext: false,
  hasPrev: false,
};

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
    (listEngagementCampaigns as jest.Mock).mockResolvedValue({
      campaigns: [],
      pagination: PAGINATION,
    });
    (listEngagementTemplates as jest.Mock).mockResolvedValue({
      templates: [],
      pagination: PAGINATION,
    });
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

    // pending_approval: approval still requires a recorded reason.
    const approveButton = screen.getByRole("button", {
      name: "Approve campaign",
    });
    expect(approveButton).toBeDisabled();
    fireEvent.change(
      screen.getByLabelText(
        "Approval reason (required to approve; optional on submit)",
      ),
      { target: { value: "Audience and consent dry-run reviewed" } },
    );
    await waitFor(() => expect(approveButton).toBeEnabled());
    expect(
      screen.getByRole("button", { name: "Queue due recipients" }),
    ).toBeDisabled();
    fireEvent.click(approveButton);
    expect(approveCampaign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approveCampaign).toHaveBeenCalledWith(
        11,
        "Audience and consent dry-run reviewed",
      ),
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

// ---------------------------------------------------------------------------
// The listing wiring: without it a campaign parked in `pending_approval` was
// reachable only from the browser session that submitted it, so the approver —
// who is not the author — could not find the thing they had to approve.
// ---------------------------------------------------------------------------
describe("<EngagementPage /> campaign listing", () => {
  const SUBMITTED_ELSEWHERE: EngagementCampaign = {
    ...CAMPAIGN,
    id: 77,
    objective: "Submitted from another admin's session",
    status: "pending_approval",
    submitted_at: "2026-08-21T09:00:00.000Z",
    updated_at: "2026-08-21T09:00:00.000Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getEngagementSettings as jest.Mock).mockResolvedValue(SETTINGS);
    (listEngagementTemplates as jest.Mock).mockResolvedValue({
      templates: [],
      pagination: PAGINATION,
    });
    (listEngagementCampaigns as jest.Mock).mockResolvedValue({
      campaigns: [SUBMITTED_ELSEWHERE],
      pagination: { ...PAGINATION, total: 1 },
    });
    (approveCampaign as jest.Mock).mockResolvedValue({
      ...SUBMITTED_ELSEWHERE,
      status: "scheduled",
    });
  });

  it("lists the tenant's campaigns and reads templates back on load", async () => {
    renderPage();

    expect(await screen.findByText("#77")).toBeInTheDocument();
    expect(
      screen.getByText("Submitted from another admin's session"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(listEngagementCampaigns).toHaveBeenCalledWith({ limit: 50 }),
    );
    expect(listEngagementTemplates).toHaveBeenCalledWith({ limit: 100 });
  });

  it("opens a campaign this session never created and lets an approver act on it", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Review #77" }));

    // The workflow panel is now driving a campaign that came from the server.
    await screen.findByText(/Campaign #77 — appointment recall/);
    const approveButton = screen.getByRole("button", {
      name: "Approve campaign",
    });
    expect(approveButton).toBeDisabled();
    fireEvent.change(
      screen.getByLabelText(
        "Approval reason (required to approve; optional on submit)",
      ),
      { target: { value: "Reviewed by the second approver" } },
    );
    await waitFor(() => expect(approveButton).toBeEnabled());

    fireEvent.click(approveButton);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approveCampaign).toHaveBeenCalledWith(
        77,
        "Reviewed by the second approver",
      ),
    );
    // The transition re-reads the list rather than trusting local state alone.
    await waitFor(() =>
      expect(
        (listEngagementCampaigns as jest.Mock).mock.calls.length,
      ).toBeGreaterThan(1),
    );
  });

  it("opens a campaign by number even when the current filter excludes it", async () => {
    // The approver was handed a campaign number; the list is showing drafts.
    const OFF_PAGE: EngagementCampaign = {
      ...SUBMITTED_ELSEWHERE,
      id: 4021,
      objective: "Not on the page the list is showing",
    };
    (getEngagementCampaign as jest.Mock).mockResolvedValue(OFF_PAGE);
    renderPage();
    await screen.findByText("#77");

    fireEvent.change(screen.getByLabelText("Open campaign by number"), {
      target: { value: "4021" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(getEngagementCampaign).toHaveBeenCalledWith(4021),
    );
    await screen.findByText(/Campaign #4021 — appointment recall/);
  });

  it("surfaces a by-id lookup refusal verbatim", async () => {
    (getEngagementCampaign as jest.Mock).mockRejectedValue(
      new APIError("Engagement campaign not found", 404, {
        code: "ENGAGEMENT_CAMPAIGN_NOT_FOUND",
      }),
    );
    renderPage();
    await screen.findByText("#77");

    fireEvent.change(screen.getByLabelText("Open campaign by number"), {
      target: { value: "999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(
      await screen.findByText("Engagement campaign not found"),
    ).toBeInTheDocument();
  });

  it("passes the chosen status filter to the backend", async () => {
    renderPage();
    await screen.findByText("#77");

    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "pending_approval" },
    });

    await waitFor(() =>
      expect(listEngagementCampaigns).toHaveBeenCalledWith({
        status: "pending_approval",
        limit: 50,
      }),
    );
  });

  it("surfaces a listing failure instead of pretending the tenant has no campaigns", async () => {
    (listEngagementCampaigns as jest.Mock).mockRejectedValue(
      new APIError("Tenant context is required", 400, {
        code: "ENGAGEMENT_TENANT_REQUIRED",
      }),
    );
    renderPage();

    expect(
      await screen.findByText(
        /Could not load campaigns: Tenant context is required/,
      ),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Templates now come from the server too, so a template authored in an earlier
// session is selectable. The backend refuses a campaign built on an unapproved
// template (ENGAGEMENT_TEMPLATE_NOT_APPROVED), so approval state has to be
// visible before the operator submits.
// ---------------------------------------------------------------------------
describe("<EngagementPage /> template listing", () => {
  const APPROVED = {
    id: 4,
    tenant_id: SETTINGS.tenant_id,
    notification_template_id: 12,
    template_kind: "appointment_recall" as const,
    channel: "push" as const,
    variables_schema: {},
    allowed_variables: ["first_name"],
    phi_classification: "non_phi",
    locale: "en-IN",
    approved_by: "someone",
    approved_at: "2026-08-19T10:00:00.000Z",
    retired_at: null,
    created_by: null,
    created_at: "2026-08-19T09:00:00.000Z",
    updated_at: "2026-08-19T10:00:00.000Z",
  };
  const UNAPPROVED = {
    ...APPROVED,
    id: 5,
    approved_by: null,
    approved_at: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getEngagementSettings as jest.Mock).mockResolvedValue(SETTINGS);
    (listEngagementCampaigns as jest.Mock).mockResolvedValue({
      campaigns: [],
      pagination: PAGINATION,
    });
    (listEngagementTemplates as jest.Mock).mockResolvedValue({
      templates: [APPROVED, UNAPPROVED],
      pagination: { ...PAGINATION, total: 2 },
    });
  });

  it("marks which templates the backend will accept for a campaign", async () => {
    renderPage();

    // Wait for the template list itself: until it loads the composer shows
    // the free-text id fallback rather than a picker.
    await screen.findByText(/#4 · appointment recall/);
    const picker = document.getElementById(
      "campaign-template-id",
    ) as HTMLSelectElement;
    expect(picker.tagName).toBe("SELECT");
    const labels = Array.from(picker.querySelectorAll("option")).map(
      (option) => option.textContent,
    );

    expect(
      labels.some((l) => l?.includes("#4") && !l.includes("not approved")),
    ).toBe(true);
    expect(
      labels.some((l) => l?.includes("#5") && l.includes("not approved")),
    ).toBe(true);
  });

  it("labels an unapproved template as such rather than borrowing campaign wording", async () => {
    renderPage();

    await screen.findByText(/#5 · appointment recall/);
    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.getByText("not approved")).toBeInTheDocument();
    // "scheduled" is a CAMPAIGN status. It may appear in the campaign status
    // filter's options, but never as a pill on a template row.
    expect(
      screen
        .queryAllByText("scheduled")
        .every((element) => element.tagName === "OPTION"),
    ).toBe(true);
  });
});
