import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import ContinuityReconciliationPage from "@/app/(with-auth)/dashboard/continuity-reconciliation/page";
import {
  checkClinicalContinuityClosure,
  loadClinicalContinuityWorkbench,
} from "@/lib/api/clinicalContinuityReconciliation";

jest.mock("@/lib/api/clinicalContinuityReconciliation", () => ({
  approveClinicalContinuityIdentityMatch: jest.fn(),
  attestClinicalContinuityClosure: jest.fn(),
  checkClinicalContinuityClosure: jest.fn(),
  closeClinicalContinuityIncident: jest.fn(),
  decideClinicalContinuityReconciliationItem: jest.fn(),
  executeClinicalContinuityIdentityMatch: jest.fn(),
  loadClinicalContinuityWorkbench: jest.fn(),
  proposeClinicalContinuityIdentityMatch: jest.fn(),
  recordClinicalContinuityDeviceOffset: jest.fn(),
  recordClinicalContinuityInterfaceRequirement: jest.fn(),
  recordClinicalContinuityRangeDisposition: jest.fn(),
  transitionClinicalContinuityIncident: jest.fn(),
}));

const mockedLoad = loadClinicalContinuityWorkbench as jest.MockedFunction<
  typeof loadClinicalContinuityWorkbench
>;
const mockedClosure = checkClinicalContinuityClosure as jest.MockedFunction<
  typeof checkClinicalContinuityClosure
>;
const incidentId = "11111111-1111-4111-8111-111111111111";

const workbench = {
  incidents: [
    {
      id: incidentId,
      facility_id: 17,
      packet_id: "22222222-2222-4222-8222-222222222222",
      commander_uid: "33333333-3333-4333-8333-333333333333",
      commander_role: "CMO",
      lifecycle_state: "reconciling" as const,
      version: 7,
      declared_at: "2026-08-01T01:00:00.000Z",
    },
  ],
  packets: [],
  paper_ranges: [],
  paper_items: [],
  reconciliation_items: [],
  temporary_identities: [],
  device_offsets: [],
  interfaces: [],
};

describe("continuity reconciliation workbench", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedLoad.mockResolvedValue(workbench);
    mockedClosure.mockResolvedValue({
      eligible: false,
      incident: workbench.incidents[0],
      predicate_snapshot_hash: "a".repeat(64),
      blockers: [{ code: "CONTINUITY_CLOSURE_PAPER_RANGE_UNACCOUNTED" }],
      attestations: [],
    });
  });

  it("is explicitly validation-only and exposes no activation action", () => {
    render(<ContinuityReconciliationPage />);
    expect(screen.getByText("Validation-only lane.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /activate/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the signed context in memory and renders the server-authoritative lanes", async () => {
    render(<ContinuityReconciliationPage />);
    fireEvent.change(screen.getByLabelText("Facility ID"), {
      target: { value: "17" },
    });
    fireEvent.change(screen.getByLabelText("Signed facility context"), {
      target: { value: "signed-envelope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load workbench" }));

    await waitFor(() =>
      expect(mockedLoad).toHaveBeenCalledWith({
        facilityId: 17,
        facilityContext: "signed-envelope",
      }),
    );
    expect(
      screen.getByText("Signed packets and paper ranges"),
    ).toBeInTheDocument();
    expect(screen.getByText("Typed reconciliation queues")).toBeInTheDocument();
    expect(screen.getByText("HIM temporary identities")).toBeInTheDocument();
    expect(
      screen.getByText("Interface recovery requirements"),
    ).toBeInTheDocument();
    expect(screen.getByText("Two-key closure")).toBeInTheDocument();
  });

  it("shows server closure blockers and disables both keys and close", async () => {
    render(<ContinuityReconciliationPage />);
    fireEvent.change(screen.getByLabelText("Facility ID"), {
      target: { value: "17" },
    });
    fireEvent.change(screen.getByLabelText("Signed facility context"), {
      target: { value: "signed-envelope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load workbench" }));
    await screen.findByText("Two-key closure");
    fireEvent.click(
      screen.getByRole("button", { name: "Recompute locked predicate" }),
    );

    expect(
      await screen.findByText("CONTINUITY_CLOSURE_PAPER_RANGE_UNACCOUNTED"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Operational attest" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Clinical attest" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Close incident" }),
    ).toBeDisabled();
  });

  it("permits both server-checked keys when attestations are the only blockers", async () => {
    mockedClosure.mockResolvedValue({
      eligible: false,
      incident: workbench.incidents[0],
      predicate_snapshot_hash: "b".repeat(64),
      blockers: [
        { code: "CONTINUITY_CLOSURE_COMMANDER_ATTESTATION_REQUIRED" },
        { code: "CONTINUITY_CLOSURE_CLINICAL_ATTESTATION_REQUIRED" },
      ],
      attestations: [],
    });
    render(<ContinuityReconciliationPage />);
    fireEvent.change(screen.getByLabelText("Facility ID"), {
      target: { value: "17" },
    });
    fireEvent.change(screen.getByLabelText("Signed facility context"), {
      target: { value: "signed-envelope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load workbench" }));
    await screen.findByText("Two-key closure");
    fireEvent.click(
      screen.getByRole("button", { name: "Recompute locked predicate" }),
    );

    expect(
      await screen.findByText(
        "CONTINUITY_CLOSURE_COMMANDER_ATTESTATION_REQUIRED",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Operational attest" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Clinical attest" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Close incident" }),
    ).toBeDisabled();
  });
});
