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
import { toast } from "react-hot-toast";

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
    // The labels are the humanised category names, not the wire enum: a screen
    // reader announcing "closure_device reprocessable" spells the underscore.
    for (const implant of ["Stent", "Pacemaker", "Lead", "Closure device"]) {
      expect(
        await screen.findByLabelText(`${implant} reprocessable`),
      ).toBeDisabled();
    }
    expect(screen.getByLabelText("Balloon reprocessable")).toBeEnabled();
  });

  it("saves the full nine-category set with an idempotency key", async () => {
    renderTab();
    fireEvent.click(await screen.findByLabelText("Catheter reprocessable"));
    fireEvent.change(screen.getByLabelText("Catheter max cycles"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByLabelText("Catheter allows eto"));
    fireEvent.click(screen.getByLabelText("Catheter function check required"));
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
    fireEvent.click(await screen.findByLabelText("Balloon reprocessable"));
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

  it("retries a failed policy save under the SAME idempotency key", async () => {
    jest
      .mocked(api.updateCathReprocessingPolicies)
      .mockRejectedValueOnce(new Error("Policy service is unavailable"))
      .mockResolvedValue({ policies: [], count: 0 } as never);
    renderTab();
    fireEvent.click(await screen.findByText("Save category policies"));
    await screen.findByText("Policy service is unavailable");

    fireEvent.click(screen.getByText("Save category policies"));
    await waitFor(() =>
      expect(api.updateCathReprocessingPolicies).toHaveBeenCalledTimes(2),
    );

    const calls = jest.mocked(api.updateCathReprocessingPolicies).mock.calls;
    // idempotencyMiddleware cached the 4xx under this key (and deletes the
    // claim outright on a 5xx), so the retry replays the recorded outcome or
    // runs exactly once. Re-minting on error is what lets a PUT that timed out
    // on the wire but committed on the server be written a second time.
    expect(calls[0][0]).toEqual(calls[1][0]);
    expect(calls[0][1]).toBe(calls[1][1]);
  });

  it("mints a NEW key for a second save once the first has succeeded", async () => {
    renderTab();
    fireEvent.click(await screen.findByText("Save category policies"));
    await waitFor(() =>
      expect(jest.mocked(toast.success)).toHaveBeenCalledWith(
        "Category policies saved",
      ),
    );

    fireEvent.click(screen.getByText("Save category policies"));
    await waitFor(() =>
      expect(api.updateCathReprocessingPolicies).toHaveBeenCalledTimes(2),
    );

    const calls = jest.mocked(api.updateCathReprocessingPolicies).mock.calls;
    // Identical payload, deliberately sent twice: the second save must reach
    // the backend rather than replay the first one's recorded response.
    expect(calls[0][0]).toEqual(calls[1][0]);
    expect(calls[0][1]).not.toBe(calls[1][1]);
  });

  it("offers no policy save while the policy read is still unresolved", async () => {
    // An unresolved read is not an empty table: Save would PUT nine
    // `defaultPolicy` rows and wipe every policy the read never delivered.
    jest
      .mocked(api.listCathReprocessingPolicies)
      .mockReturnValue(new Promise<never>(() => {}));
    renderTab();

    expect(
      await screen.findByText("Loading category policies…"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Save category policies")).toBeNull();
    expect(screen.queryByLabelText("Catheter reprocessable")).toBeNull();
    expect(api.updateCathReprocessingPolicies).not.toHaveBeenCalled();
  });

  it("offers no policy save when the policy read failed", async () => {
    jest
      .mocked(api.listCathReprocessingPolicies)
      .mockRejectedValue(new Error("Reprocessing policy is unavailable"));
    renderTab();

    expect(
      await screen.findByText("Reprocessing policy is unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Save category policies")).toBeNull();
    expect(screen.queryByLabelText("Catheter reprocessable")).toBeNull();
    expect(api.updateCathReprocessingPolicies).not.toHaveBeenCalled();
  });

  it("will not save a cleared serology validity window as zero days", async () => {
    renderTab();
    fireEvent.change(await screen.findByLabelText("Serology validity days"), {
      target: { value: "" },
    });

    // Zero days would make every serology result stale the moment it is filed.
    expect(screen.getByText("Save settings")).toBeDisabled();
    expect(
      screen.getByText(/Enter a serology validity window/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Save settings"));
    expect(api.updateCathReprocessingSettings).not.toHaveBeenCalled();
  });

  it("keeps the saved serology window on screen when the refetch has not landed", async () => {
    // The PUT answers with the new settings; the invalidate's refetch is still
    // in flight. The cache must already hold the PUT's response, or clearing
    // `settingsDirty` reseeds the form from the PRE-SAVE read: the box snaps
    // back to 90 and the next Save writes 90 over the 30 just committed.
    jest.mocked(api.updateCathReprocessingSettings).mockResolvedValue({
      settings: {
        ...SETTINGS,
        serology_validity_days: 30,
        configured: true,
      } as api.CathReprocessingSettings,
    });
    jest
      .mocked(api.getCathReprocessingSettings)
      .mockResolvedValueOnce({ settings: SETTINGS })
      .mockReturnValue(new Promise<never>(() => {}));

    renderTab();
    fireEvent.change(await screen.findByLabelText("Serology validity days"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByText("Save settings"));
    await waitFor(() =>
      expect(jest.mocked(toast.success)).toHaveBeenCalledWith(
        "Reprocessing settings saved",
      ),
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Serology validity days")).toHaveValue(30),
    );
    // The response, not just the untouched form: `configured` flipped to true,
    // which only the cached PUT result can say.
    expect(
      screen.getByText(
        "Reviewed by an owner; the defaults below are in force.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Save settings"));
    await waitFor(() =>
      expect(api.updateCathReprocessingSettings).toHaveBeenCalledTimes(2),
    );
    expect(
      jest.mocked(api.updateCathReprocessingSettings).mock.calls[1][0],
    ).toMatchObject({ serology_validity_days: 30 });
  });

  it("keeps the saved policies on screen when the refetch has not landed", async () => {
    // The PUT answers with the new policy set; the invalidate's refetch is
    // still in flight. The cache must already hold the PUT's response, or
    // clearing `policiesDirty` reseeds the grid from the PRE-SAVE read: the
    // checkbox snaps back unchecked and the next Save writes the reverted set
    // — a whole-set replacement — back over the one just committed.
    const staleCatheter = {
      category: "catheter",
      reprocessable: false,
      max_cycles: null,
      allowed_cycle_types: [],
      function_check_required: false,
    };
    const savedCatheter = {
      category: "catheter",
      reprocessable: true,
      max_cycles: 3,
      allowed_cycle_types: ["eto"],
      function_check_required: false,
    };
    jest
      .mocked(api.listCathReprocessingPolicies)
      .mockResolvedValueOnce({
        policies: [staleCatheter],
        count: 1,
      } as never)
      .mockReturnValue(new Promise<never>(() => {}));
    jest.mocked(api.updateCathReprocessingPolicies).mockResolvedValue({
      policies: [savedCatheter],
      count: 1,
    } as never);

    renderTab();
    fireEvent.click(await screen.findByLabelText("Catheter reprocessable"));
    fireEvent.change(screen.getByLabelText("Catheter max cycles"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByLabelText("Catheter allows eto"));
    fireEvent.click(screen.getByText("Save category policies"));

    await waitFor(() =>
      expect(jest.mocked(toast.success)).toHaveBeenCalledWith(
        "Category policies saved",
      ),
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Catheter reprocessable")).toBeChecked(),
    );
    expect(screen.getByLabelText("Catheter max cycles")).toHaveValue(3);

    fireEvent.click(screen.getByText("Save category policies"));
    await waitFor(() =>
      expect(api.updateCathReprocessingPolicies).toHaveBeenCalledTimes(2),
    );
    const secondSend = jest.mocked(api.updateCathReprocessingPolicies).mock
      .calls[1][0];
    expect(
      secondSend.find((policy) => policy.category === "catheter"),
    ).toMatchObject({
      reprocessable: true,
      max_cycles: 3,
      allowed_cycle_types: ["eto"],
    });
  });

  it("will not send a serology window outside 1–365 whole days", async () => {
    // `positiveInt(..., { max: 365 })` server-side; `min`/`max` here are
    // advisory attributes that nothing checks on submit.
    renderTab();
    const box = await screen.findByLabelText("Serology validity days");

    for (const rejected of ["366", "0", "-5", "1.5"]) {
      fireEvent.change(box, { target: { value: rejected } });
      expect(screen.getByText("Save settings")).toBeDisabled();
      expect(
        screen.getByText(
          "Serology validity must be a whole number of days between 1 and 365.",
        ),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByText("Save settings"));
    }
    expect(api.updateCathReprocessingSettings).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: "14" } });
    expect(screen.getByText("Save settings")).toBeEnabled();
    expect(
      screen.queryByText(
        "Serology validity must be a whole number of days between 1 and 365.",
      ),
    ).toBeNull();
    fireEvent.click(screen.getByText("Save settings"));
    await waitFor(() =>
      expect(api.updateCathReprocessingSettings).toHaveBeenCalledWith(
        expect.objectContaining({ serology_validity_days: 14 }),
        expect.any(String),
      ),
    );
  });
});
