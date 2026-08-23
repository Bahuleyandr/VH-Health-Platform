import MigrationToolkitPage from "@/app/(with-auth)/dashboard/migration-toolkit/page";
import {
  commitImportJob,
  getRehearsalReport,
  listImportJobs,
  listMappingProfiles,
  rehearseImportJob,
} from "@/lib/api/migrationToolkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/migrationToolkit", () => ({
  IMPORT_KINDS: ["patient", "encounter", "opening_ar", "mixed", "hl7_adt"],
  FILE_KINDS: ["patient", "encounter", "opening_ar"],
  listImportJobs: jest.fn(),
  createImportJob: jest.fn(),
  listMappingProfiles: jest.fn(),
  upsertMappingProfile: jest.fn(),
  profileSourceFile: jest.fn(),
  rehearseImportJob: jest.fn(),
  getRehearsalReport: jest.fn(),
  commitImportJob: jest.fn(),
  importHl7AdtBatch: jest.fn(),
  getAcceptanceReport: jest.fn(),
}));

jest.mock("react-hot-toast", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const JOB = {
  id: 1,
  uid: "job-uid-1",
  tenant_id: "35353535-3535-4353-8535-353535353503",
  job_name: "Legacy HIS wave 1",
  source_system: "legacy-his",
  import_kind: "mixed",
  status: "report_ready",
  dry_run_only: true,
  authoritative_write_enabled: false,
  redaction_mode: "strict",
  row_counts: { total: 2 },
  created_by: null,
  created_at: "2026-08-22T05:00:00.000Z",
  updated_at: "2026-08-22T06:00:00.000Z",
  completed_at: null,
  metadata: {},
};

const REPORT = {
  id: 5,
  uid: "report-uid-5",
  tenant_id: JOB.tenant_id,
  job_id: 1,
  status: "report_ready",
  phi_redacted: true,
  summary: {
    job_id: 1,
    import_kind: "mixed",
    source_files: [
      {
        id: 11,
        file_kind: "patient",
        source_filename: "patients.csv",
        content_sha256: "abcdef0123456789abcdef0123456789",
        row_count: 2,
      },
    ],
    row_counts: { total: 2, valid: 2, warning: 0, error: 0, patient: 2 },
  },
  validation_summary: {
    total: 0,
    by_severity: { info: 0, warning: 0, error: 0 },
    by_code: {},
  },
  duplicate_summary: {
    duplicate_groups: 0,
    duplicate_rows: 0,
    existing_patient_candidates: 0,
  },
  no_write_proof: {
    dry_run_only: true,
    authoritative_write_enabled: false,
    authoritative_tables_blocked: ["users", "encounters", "billing_invoices"],
    source_raw_content_persisted: false,
    toolkit_tables_written: ["migration_rehearsal_reports"],
  },
  generated_by: null,
  created_at: "2026-08-22T06:00:00.000Z",
  metadata: {},
};

const COMMIT_RESULT = {
  batch: {
    id: 9,
    uid: "batch-uid-9",
    tenant_id: JOB.tenant_id,
    job_id: 1,
    status: "committed",
    idempotency_key: "commit-job-1",
    acceptance_summary: null,
    opening_balance_totals: null,
    rollback_plan: null,
    replay_proof: null,
    committed_at: "2026-08-22T07:00:00.000Z",
  },
  report: {
    id: 21,
    uid: "acc-uid-21",
    tenant_id: JOB.tenant_id,
    job_id: 1,
    commit_batch_id: 9,
    status: "final",
    phi_redacted: true,
    report_json: {},
    acceptance_summary: {
      total: 2,
      by_target_kind: {},
      by_status: {},
      by_action: {},
    },
    opening_balance_totals: {
      amount_paise: 0,
      amount: "0.00",
      committed_rows: 0,
    },
    rollback_proof: {},
    replay_proof: {},
    generated_by: null,
    created_at: "2026-08-22T07:00:00.000Z",
    metadata: {},
  },
  replayed: false,
  records: [],
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MigrationToolkitPage />
    </QueryClientProvider>,
  );
}

async function openJobWorkspace() {
  renderPage();
  await screen.findByText("Legacy HIS wave 1");
  fireEvent.click(screen.getByRole("button", { name: /^Open$/ }));
  await screen.findByTestId("rehearsal-report");
}

function fillOneSourceFile(csv: string) {
  fireEvent.click(screen.getByRole("button", { name: /Add source file/ }));
  fireEvent.change(screen.getByLabelText("CSV content #1"), {
    target: { value: csv },
  });
}

describe("<MigrationToolkitPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listImportJobs as jest.Mock).mockResolvedValue({ jobs: [JOB], count: 1 });
    (listMappingProfiles as jest.Mock).mockResolvedValue({
      profiles: [],
      count: 0,
    });
    (getRehearsalReport as jest.Mock).mockResolvedValue(REPORT);
    (rehearseImportJob as jest.Mock).mockResolvedValue({
      report: REPORT,
      files: [],
      findings: [],
    });
    (commitImportJob as jest.Mock).mockResolvedValue(COMMIT_RESULT);
  });

  it("renders jobs and the API-returned rehearsal report without synthesizing values", async () => {
    await openJobWorkspace();

    // Report content comes straight from the mocked API payload.
    expect(screen.getByText("patients.csv")).toBeInTheDocument();
    expect(screen.getByText(/PHI redacted: yes/)).toBeInTheDocument();
    expect(
      screen.getByText("No-write proof (dry-run evidence)"),
    ).toBeInTheDocument();
  });

  it("runs a rehearsal with the entered source files", async () => {
    await openJobWorkspace();
    fillOneSourceFile("name,phone\nA,9999999999");

    fireEvent.click(
      screen.getByRole("button", { name: /Run rehearsal \(dry run\)/ }),
    );

    await waitFor(() =>
      expect(rehearseImportJob).toHaveBeenCalledWith(1, [
        {
          file_kind: "patient",
          source_filename: "source-1.csv",
          csv_text: "name,phone\nA,9999999999",
        },
      ]),
    );
  });

  it("commits only after a confirmation that restates the two-phase contract", async () => {
    await openJobWorkspace();
    fillOneSourceFile("name,phone\nA,9999999999");

    fireEvent.click(
      screen.getByRole("button", { name: /Commit to live tables/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/phase 2 of the two-phase contract/i);
    expect(dialog).toHaveTextContent(/re-submitted and re-validated/i);
    expect(commitImportJob).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Commit batch$/ }));

    await waitFor(() =>
      expect(commitImportJob).toHaveBeenCalledWith(1, {
        files: [
          {
            file_kind: "patient",
            source_filename: "source-1.csv",
            csv_text: "name,phone\nA,9999999999",
          },
        ],
        idempotency_key: "commit-job-1",
      }),
    );
    await screen.findByTestId("commit-result");
  });

  it("keeps commit disabled when no source files are entered", async () => {
    await openJobWorkspace();

    const commitButton = screen.getByRole("button", {
      name: /Commit to live tables/,
    });
    expect(commitButton).toBeDisabled();
    fireEvent.click(commitButton);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(commitImportJob).not.toHaveBeenCalled();
  });
});
