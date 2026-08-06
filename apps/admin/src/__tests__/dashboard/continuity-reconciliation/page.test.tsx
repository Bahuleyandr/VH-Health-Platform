import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import ContinuityReconciliationPage from "@/app/(with-auth)/dashboard/continuity-reconciliation/page";
import {
  attestClinicalContinuityHeldMessageRelease,
  checkClinicalContinuityClosure,
  loadClinicalContinuityWorkbench,
  releaseClinicalContinuityHeldMessage,
} from "@/lib/api/clinicalContinuityReconciliation";
import { loadExternalRecoveryWorkbench } from "@/lib/api/externalRecoveryOperability";

jest.mock("@/lib/api/clinicalContinuityReconciliation", () => ({
  approveClinicalContinuityIdentityMatch: jest.fn(),
  attestClinicalContinuityHeldMessageRelease: jest.fn(),
  attestClinicalContinuityClosure: jest.fn(),
  bindClinicalContinuityHeldMessage: jest.fn(),
  checkClinicalContinuityClosure: jest.fn(),
  closeClinicalContinuityIncident: jest.fn(),
  decideClinicalContinuityReconciliationItem: jest.fn(),
  executeClinicalContinuityIdentityMatch: jest.fn(),
  loadClinicalContinuityWorkbench: jest.fn(),
  proposeClinicalContinuityIdentityMatch: jest.fn(),
  recordClinicalContinuityDeviceOffset: jest.fn(),
  recordClinicalContinuityInterfaceRequirement: jest.fn(),
  recordClinicalContinuityRangeDisposition: jest.fn(),
  releaseClinicalContinuityHeldMessage: jest.fn(),
  transitionClinicalContinuityIncident: jest.fn(),
}));

jest.mock("@/lib/api/externalRecoveryOperability", () => ({
  authorizeExternalRecoveryResume: jest.fn(),
  loadExternalRecoveryWorkbench: jest.fn(),
  registerExternalRecoveryOffset: jest.fn(),
}));

const mockedLoad = loadClinicalContinuityWorkbench as jest.MockedFunction<
  typeof loadClinicalContinuityWorkbench
>;
const mockedClosure = checkClinicalContinuityClosure as jest.MockedFunction<
  typeof checkClinicalContinuityClosure
>;
const mockedAttest =
  attestClinicalContinuityHeldMessageRelease as jest.MockedFunction<
    typeof attestClinicalContinuityHeldMessageRelease
  >;
const mockedRelease = releaseClinicalContinuityHeldMessage as jest.MockedFunction<
  typeof releaseClinicalContinuityHeldMessage
>;
const mockedExternalLoad =
  loadExternalRecoveryWorkbench as jest.MockedFunction<
    typeof loadExternalRecoveryWorkbench
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
    mockedAttest.mockResolvedValue({} as never);
    mockedRelease.mockResolvedValue({} as never);
    mockedExternalLoad.mockResolvedValue({
      offsets: [],
      count: 0,
      capabilities: {
        can_register_exact_partition: true,
        supports_predicate_bulk_mutation: false,
      },
    });
  });

  it("is explicitly validation-only and exposes no activation action", () => {
    render(<ContinuityReconciliationPage />);
    expect(screen.getByText("Validation-only lane.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /activate/i }),
    ).not.toBeInTheDocument();
  });

  it("offers I03 on both exact-partition external-recovery controls", async () => {
    render(<ContinuityReconciliationPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "External recovery" }),
    );

    await waitFor(() =>
      expect(mockedExternalLoad).toHaveBeenCalledWith({
        interfaceFamily: "",
        recoveryState: "",
      }),
    );

    expect(
      within(screen.getByLabelText("Family filter")).getByRole("option", {
        name: "I03",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Interface family")).getByRole("option", {
        name: "I03",
      }),
    ).toBeInTheDocument();
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

  it("renders only server-authorized single-message release actions and excludes I18", async () => {
    mockedLoad.mockResolvedValue({
      ...workbench,
      capabilities: { can_bind: true },
      reconciliation_items: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          incident_id: incidentId,
          queue_type: "interface",
          disposition: "open",
          reason_code: "recovery_backlog_held",
          owner_principal: "role:INTERFACE_OWNER",
          assigned_to_uid: "55555555-5555-4555-8555-555555555555",
          version: 4,
          safety_critical: true,
          interface_item_kind: "held_message_release",
          interface_family: "I05",
          interop_message_id: 47,
          hold_safety_class: "safety_critical",
          source_state_fingerprint: "a".repeat(64),
          source_safe_evidence: { status: "quarantined" },
          release_attestation_id: "66666666-6666-4666-8666-666666666666",
          can_attest_release: true,
          can_release: true,
        },
      ],
      interfaces: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          incident_id: incidentId,
          offset_id: "99999999-9999-4999-8999-999999999999",
          interface_family: "I05",
          direction: "outbound",
          source_partition: "ADT-1",
          required_generation: 1,
          required_high_water_position: null,
          required_high_water_token: null,
          disposition: "pending",
          owner_principal: "role:INTERFACE_OWNER",
          version: 2,
        },
        {
          id: "88888888-8888-4888-8888-888888888888",
          incident_id: incidentId,
          offset_id: null,
          interface_family: "I18",
          direction: "outbound",
          source_partition: "SUB-1",
          required_generation: 1,
          required_high_water_position: null,
          required_high_water_token: null,
          disposition: "pending",
          owner_principal: "role:INTERFACE_OWNER",
          version: 1,
        },
      ],
    } as never);

    render(<ContinuityReconciliationPage />);
    fireEvent.change(screen.getByLabelText("Facility ID"), {
      target: { value: "17" },
    });
    fireEvent.change(screen.getByLabelText("Signed facility context"), {
      target: { value: "signed-envelope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load workbench" }));

    expect(await screen.findByText("I05 held message 47")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Attest exact release" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Release send authority" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /I18/ })).not.toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText(
        "Release detail 44444444-4444-4444-8444-444444444444",
      ),
      { target: { value: "Downstream evidence was reviewed." } },
    );
    fireEvent.change(
      screen.getByLabelText(
        "Release idempotency key 44444444-4444-4444-8444-444444444444",
      ),
      { target: { value: "held-release-47" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Release send authority" }),
    );

    await waitFor(() =>
      expect(mockedRelease).toHaveBeenCalledWith(
        { facilityId: 17, facilityContext: "signed-envelope" },
        "44444444-4444-4444-8444-444444444444",
        "held-release-47",
        expect.objectContaining({ expected_version: 4 }),
      ),
    );
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
