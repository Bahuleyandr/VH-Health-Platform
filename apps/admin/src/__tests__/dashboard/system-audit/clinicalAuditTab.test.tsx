import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import SystemAuditPage from "@/app/(with-auth)/dashboard/system-audit/page";
import { getJSON } from "@/lib/api/core";
import { exportCsvText } from "@/lib/exportToCsv";

jest.mock("@/lib/api/core", () => ({
  getJSON: jest.fn(),
  fetchAdminAPI: jest.fn(),
}));

jest.mock("@/lib/exportToCsv", () => ({
  exportCsvText: jest.fn(),
}));

const getJSONMock = getJSON as jest.Mock;

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    source: "clinical",
    id: "event-101",
    occurred_at: "2026-07-10T10:15:00.000Z",
    recorded_at: "2026-07-10T10:15:01.000Z",
    actor_uid: "doc-1",
    actor_name: "Dr Meera Rao",
    actor_role: "DOCTOR",
    department_id: "cardiology",
    patient_uid: "pat-9",
    patient_name: "Arun Kumar",
    encounter_id: "enc-1",
    admission_id: null,
    action: "prescription.signed",
    outcome: "success",
    resource_type: "prescription",
    resource_id: "555",
    request_id: "req-1",
    integrity_status: "verified",
    summary: "Prescription signed",
    ...overrides,
  };
}

function eventList(
  events: Array<Record<string, unknown>>,
  pagination: { next_cursor?: string | null; has_more?: boolean } = {},
) {
  return {
    events,
    pagination: {
      next_cursor: pagination.next_cursor ?? null,
      has_more: pagination.has_more ?? false,
      limit: 50,
    },
  };
}

const auditHealthWarning = {
  generated_at: "2026-07-10T10:20:00.000Z",
  total_events: 120,
  completeness: { total_events: 120, actor_attributed: 118, patient_attributed: 112, request_correlated: 109 },
  canonical_write_coverage: { coverage_percent: 98.5 },
  integrity: {
    total_events: 120,
    missing_hash_count: "1",
    hash_mismatch_count: 0,
    continuity_break_count: 1,
    first_problem_seq: 81,
    first_problem_id: "audit-problem-81",
    first_missing_hash_id: "audit-missing-17",
    intact: false,
  },
  resource_completeness: [
    {
      resource_table: "clinical_notes",
      resource_rows: 50,
      audited_resource_rows: 49,
      orphan_resource_rows: 1,
      audit_event_count: 76,
      dangling_audit_events: 2,
      coverage_percent: 98,
    },
    {
      resource_table: "clinical_orders",
      resource_rows: 30,
      audited_resource_rows: 30,
      orphan_resource_rows: 0,
      audit_event_count: 44,
      dangling_audit_events: 0,
      coverage_percent: 100,
    },
  ],
  anomalies: {
    denied_attempts: 3,
    break_glass_accesses: 1,
    after_hours_accesses: 4,
    audit_exports: 2,
    after_hours_timezone: "Asia/Kolkata",
    after_hours_window: "20:00-07:00",
    high_patient_access_threshold: 20,
    high_patient_access_actors: 1,
    high_patient_access_actor_details: [
      {
        actor_uid: "doc-broad-access",
        actor_role: "DOCTOR",
        distinct_patient_count: 24,
        access_event_count: 67,
      },
    ],
  },
  sources: [
    {
      source: "clinical",
      status: "healthy",
      event_count: 80,
      missing_actor_count: 0,
      missing_request_id_count: 1,
      latest_event_at: "2026-07-10T10:15:00.000Z",
    },
  ],
};

const auditHealthHealthy = {
  ...auditHealthWarning,
  canonical_write_coverage: { coverage_percent: 100 },
  integrity: {
    ...auditHealthWarning.integrity,
    missing_hash_count: 0,
    continuity_break_count: 0,
    first_problem_seq: null,
    first_problem_id: null,
    first_missing_hash_id: null,
    intact: true,
  },
  resource_completeness: auditHealthWarning.resource_completeness.map((resource) => ({
    ...resource,
    audited_resource_rows: resource.resource_rows,
    orphan_resource_rows: 0,
    dangling_audit_events: 0,
    coverage_percent: 100,
  })),
  anomalies: {
    ...auditHealthWarning.anomalies,
    denied_attempts: 0,
    break_glass_accesses: 0,
    after_hours_accesses: 0,
    high_patient_access_actors: 0,
    high_patient_access_actor_details: [],
  },
  sources: auditHealthWarning.sources.map((source) => ({
    ...source,
    missing_actor_count: 0,
    missing_request_id_count: 0,
  })),
};

function installApiMock(
  firstList = eventList([]),
  secondList: ReturnType<typeof eventList> | null = null,
  healthResponse: Record<string, unknown> = auditHealthWarning,
) {
  let listCalls = 0;
  getJSONMock.mockImplementation((path: string) => {
    if (path === "/api/v1/admin/audit/events") {
      listCalls += 1;
      return Promise.resolve(listCalls === 1 || !secondList ? firstList : secondList);
    }
    if (path.startsWith("/api/v1/admin/audit/events/")) {
      return Promise.resolve({
        event: {
          ...makeEvent(),
          before_state: { status: "draft", password: "should-not-render" },
          after_state: { status: "signed" },
          metadata: { workflow: "cpoe", authorization: "Bearer secret" },
        },
        redactions: ["password", "authorization"],
      });
    }
    if (path === "/api/v1/admin/audit/export") {
      return Promise.resolve("Time,Actor,Action\r\n2026-07-10,doc-1,prescription.signed");
    }
    if (path === "/api/v1/admin/audit/health") {
      return Promise.resolve(healthResponse);
    }
    return Promise.resolve(null);
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SystemAuditPage />
    </QueryClientProvider>,
  );
}

function openAuditWorkspace() {
  fireEvent.click(screen.getByRole("button", { name: /Clinical Audit/ }));
}

describe("<SystemAuditPage /> accountability workspace", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installApiMock();
  });

  it("loads the cursor event API and presents staff, patient, outcome, and UTC context", async () => {
    installApiMock(eventList([makeEvent()]));
    renderPage();
    openAuditWorkspace();

    await waitFor(() =>
      expect(getJSONMock).toHaveBeenCalledWith(
        "/api/v1/admin/audit/events",
        expect.objectContaining({ limit: 50 }),
      ),
    );

    expect(await screen.findByText("Dr Meera Rao")).toBeInTheDocument();
    expect(screen.getByText("pat-9")).toBeInTheDocument();
    expect(screen.getByText("A••• K••••")).toBeInTheDocument();
    expect(screen.getByText(/2026-07-10 10:15:00\.000Z/)).toBeInTheDocument();
    expect(screen.getByText("success")).toBeInTheDocument();
  });

  it("provides dedicated doctor and patient filters with exact ISO date-time bounds", async () => {
    renderPage();
    openAuditWorkspace();

    fireEvent.click(screen.getByRole("tab", { name: "Doctor activity" }));
    await waitFor(() =>
      expect(getJSONMock).toHaveBeenCalledWith(
        "/api/v1/admin/audit/events",
        expect.objectContaining({ actor_role: "DOCTOR_GROUP" }),
      ),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Patient audit" }));
    fireEvent.change(screen.getByLabelText("Filter by patient UID"), {
      target: { value: "pat-42" },
    });
    fireEvent.change(screen.getByLabelText("Events from date and time"), {
      target: { value: "2026-07-01T10:00" },
    });
    fireEvent.change(screen.getByLabelText("Events to date and time"), {
      target: { value: "2026-07-01T12:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() =>
      expect(getJSONMock).toHaveBeenCalledWith(
        "/api/v1/admin/audit/events",
        expect.objectContaining({
          patient_uid: "pat-42",
          from: new Date("2026-07-01T10:00").toISOString(),
          to: new Date("2026-07-01T12:30").toISOString(),
        }),
      ),
    );
  });

  it("uses opaque cursor pagination instead of an offset", async () => {
    installApiMock(
      eventList([makeEvent()], { next_cursor: "opaque-next", has_more: true }),
      eventList([makeEvent({ id: "event-202", action: "note.signed" })]),
    );
    renderPage();
    openAuditWorkspace();

    const nextButton = await screen.findByRole("button", { name: "Next audit page" });
    await waitFor(() => expect(nextButton).toBeEnabled());
    fireEvent.click(nextButton);

    await waitFor(() =>
      expect(getJSONMock).toHaveBeenCalledWith(
        "/api/v1/admin/audit/events",
        expect.objectContaining({ cursor: "opaque-next", limit: 50 }),
      ),
    );
    expect(await screen.findByText("note · signed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous audit page" })).toBeEnabled();
  });

  it("loads a safe event detail and never renders sensitive values", async () => {
    installApiMock(eventList([makeEvent()]));
    renderPage();
    openAuditWorkspace();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "View details for prescription.signed",
      }),
    );

    expect(await screen.findByRole("dialog", { name: "Audit event details" })).toBeInTheDocument();
    await screen.findByText("cpoe");
    expect(screen.getAllByText("Redacted in admin view")).toHaveLength(2);
    expect(screen.queryByText("should-not-render")).not.toBeInTheDocument();
    expect(screen.queryByText("Bearer secret")).not.toBeInTheDocument();
  });

  it("shows integrity, canonical resource gaps, and actionable access warnings", async () => {
    renderPage();
    openAuditWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "Audit health" }));

    expect(await screen.findByText("Audit source status")).toBeInTheDocument();
    expect(screen.getByText("98.5%")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("Audit health requires attention")).toBeInTheDocument();
    expect(screen.getByText("Hash chain requires attention")).toBeInTheDocument();
    expect(screen.getByText("Canonical resource completeness")).toBeInTheDocument();
    expect(screen.getByText("Clinical Notes")).toBeInTheDocument();
    expect(screen.getByText("Review gaps")).toBeInTheDocument();
    expect(screen.getByText(/audit-problem-81/)).toBeInTheDocument();
    expect(screen.getByText("doc-broad-access")).toBeInTheDocument();
    expect(screen.getByText("Threshold: 20 distinct patients in the selected window.")).toBeInTheDocument();
    expect(getJSONMock).toHaveBeenCalledWith("/api/v1/admin/audit/health");
  });

  it("shows a healthy state when integrity, coverage, and review signals are clear", async () => {
    installApiMock(eventList([]), null, auditHealthHealthy);
    renderPage();
    openAuditWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "Audit health" }));

    expect(await screen.findByText("Audit evidence is healthy")).toBeInTheDocument();
    expect(screen.getByText("Hash chain verified")).toBeInTheDocument();
    expect(screen.getAllByText("Complete")).toHaveLength(2);
    expect(screen.queryByText("Audit health requires attention")).not.toBeInTheDocument();
  });

  it("requests a server-audited CSV export for the current filters", async () => {
    renderPage();
    openAuditWorkspace();
    fireEvent.change(screen.getByLabelText("Filter by staff UID"), {
      target: { value: "doc-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Export filtered CSV" }));

    await waitFor(() =>
      expect(getJSONMock).toHaveBeenCalledWith(
        "/api/v1/admin/audit/export",
        expect.objectContaining({ actor_uid: "doc-1", limit: 500 }),
      ),
    );
    expect(exportCsvText).toHaveBeenCalledWith(
      expect.stringMatching(/^vh-health-audit-\d{4}-\d{2}-\d{2}\.csv$/),
      expect.stringContaining("prescription.signed"),
    );
  });
});
