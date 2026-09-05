// The pre-cath lab readiness policy editor.
//
// Three rules matter more than the layout:
//
//   * `required_items` can never be saved empty. The backend answers 400
//     CATH_LAB_READINESS_ITEMS_EMPTY, and the right answer to "no labs for
//     this case" is the case's own not-required flag, not a tenant policy
//     that requires nothing.
//   * The PUT replaces the policy wholesale — `upsertReadinessSettings` writes
//     an omitted field back at its default — so every save carries all four
//     fields, not just the one the operator touched.
//   * A failed save keeps its idempotency key, so the retry replays the
//     recorded outcome rather than writing a second time.

import LabReadinessSettingsTab from "@/app/(with-auth)/dashboard/quality/cath/components/LabReadinessSettingsTab";
import * as api from "@/lib/api/cathDevices";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotencyKey";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "react-hot-toast";

jest.mock("@/lib/api/cathDevices", () => ({
  ...jest.requireActual("@/lib/api/cathDevices"),
  getCathLabReadinessSettings: jest.fn(),
  updateCathLabReadinessSettings: jest.fn(),
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
  default: { success: jest.fn(), error: jest.fn() },
}));

const ALL_ITEMS = [
  "hb",
  "platelets",
  "creatinine",
  "potassium",
  "hiv",
  "hbsag",
  "hcv",
];

const ITEM_LABELS = [
  "Haemoglobin",
  "Platelets",
  "Creatinine",
  "Potassium",
  "HIV",
  "HBsAg",
  "HCV",
];

// The unconfigured shape: `configured: false` with the compiled-in defaults,
// and no updated_by / created_at / updated_at at all (the spec says absent,
// not null, in that shape).
const DEFAULTS = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  required_items: ALL_ITEMS,
  lab_validity_days: 30,
  auto_pass: true,
  external_results_count: true,
  configured: false,
} as unknown as api.CathLabReadinessSettings;

function settings(patch: Partial<api.CathLabReadinessSettings> = {}) {
  return { ...DEFAULTS, ...patch } as api.CathLabReadinessSettings;
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LabReadinessSettingsTab />
    </QueryClientProvider>,
  );
}

describe("Lab readiness settings tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(api.getCathLabReadinessSettings)
      .mockResolvedValue({ settings: DEFAULTS });
    jest
      .mocked(api.updateCathLabReadinessSettings)
      .mockResolvedValue({ settings: settings({ configured: true }) });
  });

  it("loads the policy into all seven item boxes and the window", async () => {
    renderTab();
    for (const label of ITEM_LABELS) {
      expect(await screen.findByLabelText(`Require ${label}`)).toBeChecked();
    }
    expect(await screen.findByLabelText("Lab validity days")).toHaveValue(30);
    expect(screen.getByLabelText("Auto-pass labs check")).toBeChecked();
    expect(screen.getByLabelText("External results count")).toBeChecked();
    // The two behaviours an operator cannot infer from the control name.
    expect(
      screen.getByText(/critical value never blocks/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/serology validity window on the Reprocessing policy/i),
    ).toBeInTheDocument();
  });

  it("loads defaults and saves an edited validity window", async () => {
    renderTab();
    fireEvent.change(await screen.findByLabelText("Lab validity days"), {
      target: { value: "14" },
    });
    fireEvent.click(screen.getByText("Save lab readiness settings"));

    await waitFor(() =>
      expect(api.updateCathLabReadinessSettings).toHaveBeenCalledWith(
        expect.objectContaining({ lab_validity_days: 14 }),
        expect.stringMatching(IDEMPOTENCY_KEY_PATTERN),
      ),
    );
    // A whole-policy replacement: the three fields the operator did not touch
    // travel too, or the backend would write them back at their defaults.
    const [body, key] = jest.mocked(api.updateCathLabReadinessSettings).mock
      .calls[0];
    expect(body).toEqual({
      required_items: ALL_ITEMS,
      lab_validity_days: 14,
      auto_pass: true,
      external_results_count: true,
    });
    expect(key).toMatch(/^cath-reprocessing-policy:/);
    await waitFor(() =>
      expect(jest.mocked(toast.success)).toHaveBeenCalledWith(
        "Lab readiness settings saved",
      ),
    );
  });

  it("sends the items and switches the operator actually set", async () => {
    renderTab();
    fireEvent.click(await screen.findByLabelText("Require HIV"));
    fireEvent.click(screen.getByLabelText("Require HBsAg"));
    fireEvent.click(screen.getByLabelText("Auto-pass labs check"));
    fireEvent.click(screen.getByLabelText("External results count"));
    fireEvent.click(screen.getByText("Save lab readiness settings"));

    await waitFor(() =>
      expect(api.updateCathLabReadinessSettings).toHaveBeenCalled(),
    );
    expect(
      jest.mocked(api.updateCathLabReadinessSettings).mock.calls[0][0],
    ).toEqual({
      // Canonical checklist order, not click order.
      required_items: ["hb", "platelets", "creatinine", "potassium", "hcv"],
      lab_validity_days: 30,
      auto_pass: false,
      external_results_count: false,
    });
  });

  it("refuses to save a policy that requires nothing", async () => {
    renderTab();
    for (const label of ITEM_LABELS) {
      fireEvent.click(await screen.findByLabelText(`Require ${label}`));
    }

    // The backend answers 400 CATH_LAB_READINESS_ITEMS_EMPTY; a disabled Save
    // says so before the operator loses the rest of their edits to it.
    expect(screen.getByText("Save lab readiness settings")).toBeDisabled();
    expect(
      screen.getByText(/At least one item must be required/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Save lab readiness settings"));
    expect(api.updateCathLabReadinessSettings).not.toHaveBeenCalled();
  });

  it("will not save a cleared validity window as zero days", async () => {
    renderTab();
    fireEvent.change(await screen.findByLabelText("Lab validity days"), {
      target: { value: "" },
    });

    expect(screen.getByText("Save lab readiness settings")).toBeDisabled();
    expect(
      screen.getByText(/Enter a lab validity window/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Save lab readiness settings"));
    expect(api.updateCathLabReadinessSettings).not.toHaveBeenCalled();
  });

  it("surfaces a backend refusal instead of claiming the save worked", async () => {
    jest
      .mocked(api.updateCathLabReadinessSettings)
      .mockRejectedValue(
        new Error(
          "required_items must name at least one item; mark the labs check not required on the case instead",
        ),
      );
    renderTab();
    fireEvent.click(await screen.findByText("Save lab readiness settings"));

    expect(
      await screen.findByText(/must name at least one item/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(jest.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringMatching(/must name at least one item/i),
      ),
    );
    expect(jest.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("retries a failed save under the SAME idempotency key", async () => {
    jest
      .mocked(api.updateCathLabReadinessSettings)
      .mockRejectedValueOnce(new Error("Lab readiness policy is unavailable"))
      .mockResolvedValue({ settings: settings({ configured: true }) });
    renderTab();
    fireEvent.click(await screen.findByText("Save lab readiness settings"));
    await screen.findByText("Lab readiness policy is unavailable");

    fireEvent.click(screen.getByText("Save lab readiness settings"));
    await waitFor(() =>
      expect(api.updateCathLabReadinessSettings).toHaveBeenCalledTimes(2),
    );

    const calls = jest.mocked(api.updateCathLabReadinessSettings).mock.calls;
    // idempotencyMiddleware cached the 4xx under this key (and deletes the
    // claim outright on a 5xx), so the retry replays the recorded outcome or
    // runs exactly once. Re-minting on error is what lets a PUT that timed out
    // on the wire but committed on the server be written a second time.
    expect(calls[0][0]).toEqual(calls[1][0]);
    expect(calls[0][1]).toBe(calls[1][1]);
  });

  it("mints a NEW key for a second save once the first has succeeded", async () => {
    renderTab();
    fireEvent.click(await screen.findByText("Save lab readiness settings"));
    await waitFor(() =>
      expect(jest.mocked(toast.success)).toHaveBeenCalledWith(
        "Lab readiness settings saved",
      ),
    );

    fireEvent.click(screen.getByText("Save lab readiness settings"));
    await waitFor(() =>
      expect(api.updateCathLabReadinessSettings).toHaveBeenCalledTimes(2),
    );

    const calls = jest.mocked(api.updateCathLabReadinessSettings).mock.calls;
    // Identical payload, deliberately sent twice: the second save must reach
    // the backend rather than replay the first one's recorded response.
    expect(calls[0][0]).toEqual(calls[1][0]);
    expect(calls[0][1]).not.toBe(calls[1][1]);
  });

  it("offers no save while the policy read is still unresolved", async () => {
    // An unresolved read is not an empty form: Save would PUT this
    // component's own defaults over whatever the tenant has.
    jest
      .mocked(api.getCathLabReadinessSettings)
      .mockReturnValue(new Promise<never>(() => {}));
    renderTab();

    expect(
      await screen.findByText("Loading lab readiness settings…"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Save lab readiness settings")).toBeNull();
    expect(screen.queryByLabelText("Require Haemoglobin")).toBeNull();
    expect(api.updateCathLabReadinessSettings).not.toHaveBeenCalled();
  });

  it("offers no save when the policy read failed", async () => {
    jest
      .mocked(api.getCathLabReadinessSettings)
      .mockRejectedValue(new Error("Lab readiness policy is unavailable"));
    renderTab();

    expect(
      await screen.findByText("Lab readiness policy is unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Save lab readiness settings")).toBeNull();
    expect(screen.queryByLabelText("Require Haemoglobin")).toBeNull();
    expect(api.updateCathLabReadinessSettings).not.toHaveBeenCalled();
  });

  it("says whether the tenant has ever set the policy", async () => {
    renderTab();
    expect(
      await screen.findByText(/platform defaults are in force/i),
    ).toBeInTheDocument();

    jest
      .mocked(api.getCathLabReadinessSettings)
      .mockResolvedValue({ settings: settings({ configured: true }) });
    renderTab();
    expect(
      await screen.findByText(/Set by this tenant/i),
    ).toBeInTheDocument();
  });
});
