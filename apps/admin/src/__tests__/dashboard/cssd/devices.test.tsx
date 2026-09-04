// The CSSD Devices tab — the queue a used cath device lands in when the lab
// sends it for reprocessing.
//
// These assert the three things that would silently break the queue: the row
// carries the tag, cycle count and exposure markers CSSD needs to decide;
// only the transitions the backend state machine allows are offered; and each
// transition reaches the API with its payload AND an Idempotency-Key, since
// the routes hard-400 without one.

import { DevicesTab } from "@/app/(with-auth)/dashboard/cssd/components/DevicesTab";
import * as api from "@/lib/api/cathDevices";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotencyKey";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

jest.mock("@/lib/api/cathDevices", () => ({
  ...jest.requireActual("@/lib/api/cathDevices"),
  listCssdDevices: jest.fn(),
  markCssdDeviceReprocessed: jest.fn(),
  receiveCssdDevice: jest.fn(),
  quarantineCssdDevice: jest.fn(),
  releaseCssdDevice: jest.fn(),
  discardCssdDevice: jest.fn(),
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
  default: { success: jest.fn(), error: jest.fn() },
}));

const DEVICE = {
  id: 1,
  tenant_id: "11111111-1111-4111-8111-111111111111",
  facility_id: 1,
  catalog_item_id: 10,
  device_tag: "RP00000001",
  origin_usage_id: 5,
  origin_unit_index: 1,
  cycle_count: 0,
  max_cycles_snapshot: 3,
  status: "awaiting_reprocessing",
  current_usage_id: null,
  exposure_flag: true,
  exposure_markers: ["hbsag"],
  last_reprocessed_at: null,
  last_reprocessed_by: null,
  last_cycle_type: null,
  last_function_check: null,
  quarantine_reason: null,
  quarantined_at: null,
  discard_reason: null,
  discard_note: null,
  discarded_at: null,
  discarded_by: null,
  created_by: "22222222-2222-4222-8222-222222222222",
  created_at: "2026-09-04T06:00:00.000Z",
  updated_at: "2026-09-04T06:00:00.000Z",
  metadata: {},
  item_name: "Diagnostic catheter",
  category: "catheter",
  manufacturer: "Synthetic",
  model: "DX-5F",
} as unknown as api.CathDevice;

const QUARANTINED = {
  ...DEVICE,
  id: 2,
  device_tag: "RP00000002",
  status: "quarantined",
} as unknown as api.CathDevice;

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DevicesTab />
    </QueryClientProvider>,
  );
}

describe("CSSD Devices tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(api.listCssdDevices).mockResolvedValue([DEVICE]);
  });

  it("lists devices with tag, cycle and exposure markers", async () => {
    renderTab();
    expect(await screen.findByText("RP00000001")).toBeInTheDocument();
    expect(screen.getByText("0 of 3")).toBeInTheDocument();
    // exposure_markers is what tells CSSD this device came off a reactive
    // patient; losing it would turn a discard decision into a guess. It is
    // rendered under its clinical name, not the wire enum.
    expect(screen.getByText("HBsAg")).toBeInTheDocument();
    expect(api.listCssdDevices).toHaveBeenCalledWith({
      status: "awaiting_reprocessing",
      limit: 200,
    });
  });

  it("offers only the transitions the state machine allows for the row's status", async () => {
    renderTab();
    const row = (await screen.findByText("RP00000001")).closest("tr");
    expect(
      within(row!).getByLabelText("Mark reprocessed RP00000001"),
    ).toBeInTheDocument();
    expect(
      within(row!).getByLabelText("Receive RP00000001"),
    ).toBeInTheDocument();
    // Release is a quarantined-only exit; offering it here could only ever 409.
    expect(within(row!).queryByLabelText("Release RP00000001")).toBeNull();
  });

  it("offers release and discard, and nothing else, on a quarantined device", async () => {
    jest.mocked(api.listCssdDevices).mockResolvedValue([QUARANTINED]);
    renderTab();
    const row = (await screen.findByText("RP00000002")).closest("tr");
    expect(
      within(row!).getByLabelText("Release RP00000002"),
    ).toBeInTheDocument();
    expect(
      within(row!).getByLabelText("Discard RP00000002"),
    ).toBeInTheDocument();
    expect(within(row!).queryAllByRole("button")).toHaveLength(2);
  });

  it("marks a device reprocessed with the chosen cycle type and an idempotency key", async () => {
    jest.mocked(api.markCssdDeviceReprocessed).mockResolvedValue({
      ...DEVICE,
      status: "available",
      cycle_count: 1,
    } as unknown as api.CathDevice);
    renderTab();
    fireEvent.click(
      await screen.findByLabelText("Mark reprocessed RP00000001"),
    );
    fireEvent.change(screen.getByLabelText("Cycle type"), {
      target: { value: "plasma" },
    });
    fireEvent.click(screen.getByLabelText("Confirm device action"));

    await waitFor(() =>
      expect(api.markCssdDeviceReprocessed).toHaveBeenCalledWith(
        1,
        { cycle_type: "plasma" },
        expect.stringMatching(IDEMPOTENCY_KEY_PATTERN),
      ),
    );
    // The scope prefix is what the backend's (tenant, user, key, path)
    // uniqueness is namespaced under; a bare UUID would still validate.
    expect(jest.mocked(api.markCssdDeviceReprocessed).mock.calls[0][2]).toMatch(
      /^cssd-device-transition:/,
    );
  });

  it("retries a failed attempt under the SAME idempotency key", async () => {
    jest
      .mocked(api.markCssdDeviceReprocessed)
      .mockRejectedValueOnce(new Error("Device is in the wrong state"))
      .mockResolvedValue(DEVICE);
    renderTab();
    fireEvent.click(
      await screen.findByLabelText("Mark reprocessed RP00000001"),
    );
    fireEvent.change(screen.getByLabelText("Cycle type"), {
      target: { value: "eto" },
    });
    fireEvent.click(screen.getByLabelText("Confirm device action"));
    await screen.findByText("Device is in the wrong state");

    fireEvent.click(screen.getByLabelText("Confirm device action"));
    await waitFor(() =>
      expect(api.markCssdDeviceReprocessed).toHaveBeenCalledTimes(2),
    );

    const calls = jest.mocked(api.markCssdDeviceReprocessed).mock.calls;
    // A failed attempt is not a concluded one. idempotencyMiddleware cached the
    // 4xx outcome under this key (and deletes the claim outright on a 5xx), so
    // the retry has to arrive with the same key: it then replays the recorded
    // refusal, or runs exactly once if nothing was recorded. Re-minting here is
    // how a request that timed out on the wire but committed on the server gets
    // to run the transition a second time.
    expect(calls[0][2]).toBe(calls[1][2]);
  });

  it("mints a NEW key for a fresh attempt once one has succeeded", async () => {
    jest.mocked(api.markCssdDeviceReprocessed).mockResolvedValue(DEVICE);
    renderTab();
    fireEvent.click(
      await screen.findByLabelText("Mark reprocessed RP00000001"),
    );
    fireEvent.change(screen.getByLabelText("Cycle type"), {
      target: { value: "eto" },
    });
    fireEvent.click(screen.getByLabelText("Confirm device action"));
    // The dialog closes from onSuccess, which is where reset() lives.
    await waitFor(() =>
      expect(screen.queryByLabelText("Confirm device action")).toBeNull(),
    );

    fireEvent.click(screen.getByLabelText("Mark reprocessed RP00000001"));
    fireEvent.change(screen.getByLabelText("Cycle type"), {
      target: { value: "eto" },
    });
    fireEvent.click(screen.getByLabelText("Confirm device action"));
    await waitFor(() =>
      expect(api.markCssdDeviceReprocessed).toHaveBeenCalledTimes(2),
    );

    const calls = jest.mocked(api.markCssdDeviceReprocessed).mock.calls;
    // Same payload, deliberately taken twice: a second cycle recorded on the
    // same device must actually run rather than replay the first response.
    expect(calls[0][1]).toEqual(calls[1][1]);
    expect(calls[0][2]).not.toBe(calls[1][2]);
  });

  it("will not record a reprocessing cycle before a cycle type is chosen", async () => {
    renderTab();
    fireEvent.click(
      await screen.findByLabelText("Mark reprocessed RP00000001"),
    );
    // No pre-selected "eto": a cycle type nobody chose would land in the
    // device's reprocessing history as though they had chosen it.
    expect(screen.getByLabelText("Confirm device action")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Cycle type"), {
      target: { value: "steam" },
    });
    expect(screen.getByLabelText("Confirm device action")).toBeEnabled();
  });

  it("will not send a quarantine without a reason", async () => {
    jest.mocked(api.listCssdDevices).mockResolvedValue([QUARANTINED, DEVICE]);
    renderTab();
    const row = (await screen.findByText("RP00000001")).closest("tr");
    fireEvent.click(within(row!).getByLabelText("Quarantine RP00000001"));
    expect(screen.getByLabelText("Confirm device action")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Quarantine reason"), {
      target: { value: "seal damaged" },
    });
    fireEvent.click(screen.getByLabelText("Confirm device action"));
    await waitFor(() =>
      expect(api.quarantineCssdDevice).toHaveBeenCalledWith(
        1,
        { reason: "seal damaged" },
        expect.stringMatching(IDEMPOTENCY_KEY_PATTERN),
      ),
    );
  });
});
