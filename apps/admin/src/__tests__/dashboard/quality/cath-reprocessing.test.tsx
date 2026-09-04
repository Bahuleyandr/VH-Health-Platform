// The cath reprocessing-policy editor.
//
// Two rules matter more than the layout: an implant category must never be
// markable reprocessable (CATH_REPROCESSING_IMPLANT_FORBIDDEN), and the save
// must carry ALL nine categories — upsertCategoryPolicies deletes nothing, so
// an omitted row would keep its old policy while the screen claimed to have
// saved the whole screen.

import ReprocessingPolicyTab from "@/app/(with-auth)/dashboard/quality/cath/components/ReprocessingPolicyTab";
import * as api from "@/lib/api/cathDevices";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotencyKey";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/cathDevices", () => ({
  ...jest.requireActual("@/lib/api/cathDevices"),
  getCathReprocessingSettings: jest.fn(),
  listCathReprocessingPolicies: jest.fn(),
  updateCathReprocessingPolicies: jest.fn(),
  updateCathReprocessingSettings: jest.fn(),
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
  default: { success: jest.fn(), error: jest.fn() },
}));

const SETTINGS = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  reactive_patient_rule: "discard",
  unknown_serology_rule: "warn",
  serology_validity_days: 90,
  reviewed_by: null,
  reviewed_at: null,
  updated_by: null,
  created_at: null,
  updated_at: null,
  configured: false,
} as unknown as api.CathReprocessingSettings;

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReprocessingPolicyTab />
    </QueryClientProvider>,
  );
}

describe("Reprocessing policy tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(api.getCathReprocessingSettings)
      .mockResolvedValue({ settings: SETTINGS });
    jest
      .mocked(api.listCathReprocessingPolicies)
      .mockResolvedValue({ policies: [], count: 0 } as never);
    jest
      .mocked(api.updateCathReprocessingPolicies)
      .mockResolvedValue({ policies: [], count: 0 } as never);
    jest
      .mocked(api.updateCathReprocessingSettings)
      .mockResolvedValue({ settings: SETTINGS });
  });

  it("disables the reprocessable toggle for implant categories", async () => {
    renderTab();
    for (const implant of ["stent", "pacemaker", "lead", "closure_device"]) {
      expect(
        await screen.findByLabelText(`${implant} reprocessable`),
      ).toBeDisabled();
    }
    expect(screen.getByLabelText("balloon reprocessable")).toBeEnabled();
  });

  it("saves the full nine-category set with an idempotency key", async () => {
    renderTab();
    fireEvent.click(await screen.findByLabelText("catheter reprocessable"));
    fireEvent.change(screen.getByLabelText("catheter max cycles"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByLabelText("catheter allows eto"));
    fireEvent.click(screen.getByLabelText("catheter function check required"));
    fireEvent.click(screen.getByText("Save category policies"));

    await waitFor(() =>
      expect(api.updateCathReprocessingPolicies).toHaveBeenCalled(),
    );
    const [sent, key] = jest.mocked(api.updateCathReprocessingPolicies).mock
      .calls[0];
    expect(sent).toHaveLength(9);
    expect(sent.find((policy) => policy.category === "catheter")).toMatchObject(
      {
        reprocessable: true,
        max_cycles: 3,
        allowed_cycle_types: ["eto"],
        function_check_required: true,
      },
    );
    // An untouched category still travels, because the backend upserts the set
    // it receives and never deletes what the caller omitted.
    expect(sent.find((policy) => policy.category === "stent")).toMatchObject({
      reprocessable: false,
    });
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(key).toMatch(/^cath-reprocessing-policy:/);
  });

  it("refuses to send a reprocessable category with no cycle budget", async () => {
    renderTab();
    // The backend rejects the WHOLE put on the first offender, so an unguarded
    // save would lose every other row's edits over one blank cell.
    fireEvent.click(await screen.findByLabelText("balloon reprocessable"));
    fireEvent.click(screen.getByText("Save category policies"));

    expect(
      await screen.findByText(
        /needs a max-cycle count and at least one cycle/i,
      ),
    ).toBeInTheDocument();
    expect(api.updateCathReprocessingPolicies).not.toHaveBeenCalled();
  });

  it("saves the blood-borne marker rules with an idempotency key", async () => {
    renderTab();
    fireEvent.change(await screen.findByLabelText("Reactive patient rule"), {
      target: { value: "override_allowed" },
    });
    fireEvent.change(screen.getByLabelText("Serology validity days"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByText("Save settings"));

    await waitFor(() =>
      expect(api.updateCathReprocessingSettings).toHaveBeenCalledWith(
        {
          reactive_patient_rule: "override_allowed",
          unknown_serology_rule: "warn",
          serology_validity_days: 30,
        },
        expect.stringMatching(IDEMPOTENCY_KEY_PATTERN),
      ),
    );
  });

  it("surfaces a backend refusal instead of claiming the save worked", async () => {
    jest
      .mocked(api.updateCathReprocessingPolicies)
      .mockRejectedValue(
        new Error(
          "stent is an implant category and can never be reprocessable",
        ),
      );
    renderTab();
    fireEvent.click(await screen.findByText("Save category policies"));
    expect(
      await screen.findByText(
        /implant category and can never be reprocessable/,
      ),
    ).toBeInTheDocument();
  });
});
