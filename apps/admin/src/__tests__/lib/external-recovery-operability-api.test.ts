import {
  authorizeExternalRecoveryResume,
  loadExternalRecoveryWorkbench,
  registerExternalRecoveryOffset,
  type ExternalRecoveryRegisterRequest,
} from "@/lib/api/externalRecoveryOperability";
import { fetchAdminAPI } from "@/lib/api/core";

jest.mock("@/lib/api/core", () => ({
  fetchAdminAPI: jest.fn(),
}));

const mockedFetch = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

const registration: ExternalRecoveryRegisterRequest = {
  interface_family: "I10",
  source_partition: "cold-chain:facility-41",
  generation: 2,
  facility_id: 41,
  initial_position: "17",
  initial_token: "source-token-17",
  retained_from_position: "1",
  retained_from_token: "source-token-1",
  policy_version: "owner-policy-v3",
  policy_signature: "signed-policy-evidence",
  retention_policy: "tenant-signed-retention",
  retention_until: "2027-08-05T00:00:00.000Z",
  owner_evidence_reference: "owner-packet-bv-41",
  owner_evidence_signature: "signed-owner-evidence",
  reason_code: "initial_marker_reconciled",
  reason_detail: "The exact source marker was reconciled with the owner.",
};

describe("external-recovery operability Admin API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetch.mockResolvedValue({} as never);
  });

  it("normalizes only read-only family and state filters", async () => {
    await loadExternalRecoveryWorkbench({
      interfaceFamily: " i10 ",
      recoveryState: " PAUSED ",
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      "/admin/continuity/external-recovery/workbench?interface_family=I10&recovery_state=paused",
    );
  });

  it("registers one exact partition with a bounded idempotency key", async () => {
    await registerExternalRecoveryOffset("external-register-41", registration);

    expect(mockedFetch).toHaveBeenCalledWith(
      "/admin/continuity/external-recovery/offsets",
      {
        method: "POST",
        headers: { "Idempotency-Key": "external-register-41" },
        body: registration,
      },
    );
    expect(JSON.stringify(mockedFetch.mock.calls[0])).not.toMatch(
      /scope_kind|facility_scope|recovery_state|command_class|apply_all|start_at_current|actor_uid|role/i,
    );
  });

  it("authorizes only the exact encoded offset and state fingerprint", async () => {
    await authorizeExternalRecoveryResume(
      "11111111-1111-4111-8111-111111111111",
      "external-resume-41",
      {
        expected_state_fingerprint: "a".repeat(64),
        resume_cutoff_position: "25",
        resume_cutoff_token: "source-token-25",
        owner_evidence_reference: "owner-packet-bv-41",
        owner_evidence_signature: "signed-owner-evidence",
        reason_code: "resume_cutoff_reconciled",
        reason_detail: "The exact replay cutoff was reconciled with the source.",
      },
    );

    expect(mockedFetch).toHaveBeenCalledWith(
      "/admin/continuity/external-recovery/offsets/11111111-1111-4111-8111-111111111111/resume-authorizations",
      expect.objectContaining({
        method: "POST",
        headers: { "Idempotency-Key": "external-resume-41" },
        body: expect.objectContaining({
          expected_state_fingerprint: "a".repeat(64),
          resume_cutoff_position: "25",
        }),
      }),
    );
  });

  it("rejects an invalid idempotency key before a request can leave the browser", () => {
    expect(() => registerExternalRecoveryOffset("bulk resume all", registration)).toThrow(
      "bounded Idempotency-Key",
    );
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
