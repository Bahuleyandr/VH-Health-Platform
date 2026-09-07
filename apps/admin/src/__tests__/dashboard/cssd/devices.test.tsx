// The CSSD Devices tab — the queue a used cath device lands in when the lab
// sends it for reprocessing.
//
// These assert the three things that would silently break the queue: the row
// carries the tag, cycle count and exposure markers CSSD needs to decide;
// only the transitions the backend state machine allows are offered; and each
// transition reaches the API with its payload AND an Idempotency-Key, since
// the routes hard-400 without one.
//
// ...and, since the cycle-type picker was filtered, a fourth: the picker
// offers only what the CATEGORY POLICY allows. That policy is a second gate
// behind the state machine — `markDeviceReprocessed` answers 409
// CATH_REPROCESSING_NOT_ALLOWED for a category the tenant has not made
// reprocessable and 409 CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED for a type outside
// `allowed_cycle_types` — so an unfiltered picker offered choices that could
// only ever be refused.

import { DevicesTab } from "@/app/(with-auth)/dashboard/cssd/components/DevicesTab";
import * as api from "@/lib/api/cathDevices";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotencyKey";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

jest.mock("@/lib/api/cathDevices", () => ({
  ...jest.requireActual("@/lib/api/cathDevices"),
  listCssdDevices: jest.fn(),
  listCathReprocessingPolicies: jest.fn(),
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
  // The two the QUEUE joins in — no other device surface returns them.
  facility_name: "Nandanam",
  status_changed_at: "2026-09-04T06:00:00.000Z",
} as unknown as api.CathDevice;

const QUARANTINED = {
  ...DEVICE,
  id: 2,
  device_tag: "RP00000002",
  status: "quarantined",
} as unknown as api.CathDevice;

const hoursAgo = (hours: number, minutes = 0) =>
  new Date(Date.now() - hours * 3_600_000 - minutes * 60_000).toISOString();

/**
 * GET /cath-reprocessing/policies always answers with one row per category
 * (`listCategoryPolicies` defaults the ones the tenant never saved), so the
 * fixture is the whole set — a sparse list would test a shape the backend
 * cannot produce.
 */
function policiesFixture(
  overrides: Partial<
    Record<api.CathCategory, Partial<api.CathReprocessingPolicy>>
  > = {},
): api.CathReprocessingPoliciesResult {
  const policies = api.CATH_CATEGORIES.map(
    (category) =>
      ({
        tenant_id: "11111111-1111-4111-8111-111111111111",
        category,
        reprocessable: false,
        max_cycles: null,
        allowed_cycle_types: [],
        function_check_required: false,
        updated_by: null,
        created_at: null,
        updated_at: null,
        ...overrides[category],
      }) as api.CathReprocessingPolicy,
  );
  return { policies, count: policies.length };
}

/** The DEVICE fixture is a catheter, so this is the policy that governs it. */
const CATHETER_POLICY = policiesFixture({
  catheter: {
    reprocessable: true,
    max_cycles: 3,
    // Deliberately NOT in vocabulary order, and deliberately a strict subset:
    // dry_heat, chemical and other are the three the picker must drop.
    allowed_cycle_types: ["plasma", "steam", "eto"],
  },
});

function cycleTypeOptions() {
  return within(screen.getByLabelText("Cycle type"))
    .getAllByRole("option")
    .map((option) => (option as HTMLOptionElement).value)
    .filter((value) => value !== "");
}

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
    jest
      .mocked(api.listCathReprocessingPolicies)
      .mockResolvedValue(CATHETER_POLICY);
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
    // Two transitions plus the label print, which is not a transition at all —
    // it moves nothing, so it is offered on every row that is still in
    // circulation.
    expect(
      within(row!)
        .queryAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Print label RP00000002",
      "Release RP00000002",
      "Discard RP00000002",
    ]);
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

  it("offers ONLY the cycle types the category policy allows, in vocabulary order", async () => {
    renderTab();
    fireEvent.click(
      await screen.findByLabelText("Mark reprocessed RP00000001"),
    );
    // The policy stored plasma, steam, eto; the six-type vocabulary is
    // steam, eto, plasma, dry_heat, chemical, other. The picker reads in
    // vocabulary order and the three the policy omits are simply not there —
    // sending one would be a 409 CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED.
    expect(cycleTypeOptions()).toEqual(["steam", "eto", "plasma"]);
    expect(api.listCathReprocessingPolicies).toHaveBeenCalled();
  });

  it("disables Reprocess, naming the category, when no policy allows it", async () => {
    // reprocessable:false is the default row `listCategoryPolicies` returns for
    // a category the tenant never saved. Every cycle type would 409
    // CATH_REPROCESSING_NOT_ALLOWED, so there is nothing to offer.
    jest
      .mocked(api.listCathReprocessingPolicies)
      .mockResolvedValue(policiesFixture());
    renderTab();
    const row = (await screen.findByText("RP00000001")).closest("tr");
    await waitFor(() =>
      expect(
        within(row!).getByLabelText("Mark reprocessed RP00000001"),
      ).toBeDisabled(),
    );
    expect(
      within(row!).getByText("No reprocessing policy allows catheter"),
    ).toBeInTheDocument();
    // ...and the operator is told where the policy is set, rather than left
    // with a dead control.
    expect(
      within(row!).getByRole("link", { name: /reprocessing policy/i }),
    ).toHaveAttribute("href", "/dashboard/quality/cath");
    // The narrowing is the POLICY's, not the state machine's: the other
    // transitions this status allows are untouched.
    expect(within(row!).getByLabelText("Receive RP00000001")).toBeEnabled();
    expect(within(row!).getByLabelText("Discard RP00000001")).toBeEnabled();
  });

  it("...and a policy that is reprocessable with an empty type list is the same refusal", async () => {
    // The table's own CHECK allows this row shape; `markDeviceReprocessed`
    // then refuses every type it is sent.
    jest.mocked(api.listCathReprocessingPolicies).mockResolvedValue(
      policiesFixture({
        catheter: {
          reprocessable: true,
          max_cycles: 3,
          allowed_cycle_types: [],
        },
      }),
    );
    renderTab();
    const row = (await screen.findByText("RP00000001")).closest("tr");
    await waitFor(() =>
      expect(
        within(row!).getByLabelText("Mark reprocessed RP00000001"),
      ).toBeDisabled(),
    );
    expect(
      within(row!).getByText("No reprocessing policy allows catheter"),
    ).toBeInTheDocument();
  });

  it("disables Reprocess while the policy is still loading, and when it fails", async () => {
    // A picker built from a policy nobody has read yet would offer whatever
    // the empty default implies. Undecidable is not the same as forbidden, so
    // the reason says so.
    let resolvePolicies: (
      value: api.CathReprocessingPoliciesResult,
    ) => void = () => {};
    jest.mocked(api.listCathReprocessingPolicies).mockReturnValue(
      new Promise<api.CathReprocessingPoliciesResult>((resolve) => {
        resolvePolicies = resolve;
      }),
    );
    const { unmount } = renderTab();
    const row = (await screen.findByText("RP00000001")).closest("tr");
    expect(
      within(row!).getByLabelText("Mark reprocessed RP00000001"),
    ).toBeDisabled();
    expect(
      within(row!).getByText("Loading the reprocessing policy…"),
    ).toBeInTheDocument();
    resolvePolicies(CATHETER_POLICY);
    await waitFor(() =>
      expect(
        within(row!).getByLabelText("Mark reprocessed RP00000001"),
      ).toBeEnabled(),
    );
    unmount();

    jest
      .mocked(api.listCathReprocessingPolicies)
      .mockRejectedValue(new Error("policy read failed"));
    renderTab();
    const failedRow = (await screen.findByText("RP00000001")).closest("tr");
    await waitFor(() =>
      expect(
        within(failedRow!).getByLabelText("Mark reprocessed RP00000001"),
      ).toBeDisabled(),
    );
    expect(
      within(failedRow!).getByText(
        "The reprocessing policy could not be loaded",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the backend 409 as the backstop when the policy changes under the dialog", async () => {
    // The filter is a convenience, not the authority: the policy can be
    // rewritten between the queue read and the transition, and the refusal the
    // operator then gets is the backend's.
    jest
      .mocked(api.markCssdDeviceReprocessed)
      .mockRejectedValue(
        new Error("steam is not an allowed cycle type for catheter"),
      );
    renderTab();
    fireEvent.click(
      await screen.findByLabelText("Mark reprocessed RP00000001"),
    );
    fireEvent.change(screen.getByLabelText("Cycle type"), {
      target: { value: "steam" },
    });
    fireEvent.click(screen.getByLabelText("Confirm device action"));

    expect(
      await screen.findByText(
        "steam is not an allowed cycle type for catheter",
      ),
    ).toBeInTheDocument();
  });

  it("opens the label PDF through the portal proxy, and not for a discarded device", async () => {
    // A binary response: `core.ts` parses JSON, so the label is opened in a
    // tab (the browser's own PDF viewer carries the print dialog CSSD wants)
    // rather than fetched. Same pattern as the cold-chain register export.
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    jest
      .mocked(api.listCssdDevices)
      .mockResolvedValue([
        DEVICE,
        { ...DEVICE, id: 3, device_tag: "RP00000003", status: "discarded" },
      ] as unknown as api.CathDevice[]);
    renderTab();

    fireEvent.click(await screen.findByLabelText("Print label RP00000001"));
    expect(open).toHaveBeenCalledWith(
      "/api/proxy/api/v1/cssd/devices/1/label",
      "_blank",
      "noopener,noreferrer",
    );

    // A discarded device is out of circulation; a tag for it is a sticker for
    // something nobody may put back in a case.
    expect(screen.queryByLabelText("Print label RP00000003")).toBeNull();
    open.mockRestore();
  });

  it("re-reads the queue on a timer, and the age moves with it", async () => {
    // A CSSD console is left open on a bench all shift. With `now` taken in
    // the render body and no refetch, nothing re-renders on its own: a device
    // that has waited four hours goes on reading "3h 25m" until someone
    // clicks Refresh — the one number the screen exists to show, frozen.
    //
    // The age and the data have to move TOGETHER, so `now` is the query's
    // dataUpdatedAt rather than a free-running clock: a clock that ticked on
    // its own would age rows the server has since moved.
    jest.useFakeTimers({ now: new Date("2026-09-04T12:00:00.000Z") });
    try {
      jest
        .mocked(api.listCssdDevices)
        .mockResolvedValue([
          { ...DEVICE, status_changed_at: "2026-09-04T08:35:00.000Z" },
        ] as unknown as api.CathDevice[]);
      renderTab();

      expect(await screen.findByText("3h 25m")).toBeInTheDocument();
      expect(api.listCssdDevices).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });

      await waitFor(() => expect(api.listCssdDevices).toHaveBeenCalledTimes(2));
      expect(await screen.findByText("3h 26m")).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows the facility and a humanised time in queue", async () => {
    // A queue is about waiting: "3h 25m" is the number CSSD works from, and
    // the facility is what tells one site's tray from another's.
    jest
      .mocked(api.listCssdDevices)
      .mockResolvedValue([
        { ...DEVICE, status_changed_at: hoursAgo(3, 25) },
      ] as unknown as api.CathDevice[]);
    renderTab();

    const row = (await screen.findByText("RP00000001")).closest("tr");
    expect(within(row!).getByText("Nandanam")).toBeInTheDocument();
    expect(within(row!).getByText("3h 25m")).toBeInTheDocument();
  });

  it("sorts by time in queue, longest wait first, and flips on a second click", async () => {
    jest.mocked(api.listCssdDevices).mockResolvedValue([
      {
        ...DEVICE,
        id: 1,
        device_tag: "RP00000001",
        facility_name: "Nandanam",
        status_changed_at: hoursAgo(2),
      },
      {
        ...DEVICE,
        id: 2,
        device_tag: "RP00000002",
        facility_name: "Adyar",
        status_changed_at: hoursAgo(50),
      },
    ] as unknown as api.CathDevice[]);
    renderTab();
    await screen.findByText("RP00000001");

    const tags = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0].textContent);

    // The server orders by status bucket then updated_at; the console does not
    // reorder until asked.
    expect(tags()).toEqual(["RP00000001", "RP00000002"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Sort by time in queue" }),
    );
    expect(tags()).toEqual(["RP00000002", "RP00000001"]);
    expect(screen.getByText("2d 2h")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Sort by time in queue" }),
    );
    expect(tags()).toEqual(["RP00000001", "RP00000002"]);

    fireEvent.click(screen.getByRole("button", { name: "Sort by facility" }));
    expect(tags()).toEqual(["RP00000002", "RP00000001"]);
  });

  it("announces the sort direction on the column header", async () => {
    // A sortable column that never says which way it is sorted is a column a
    // screen-reader user cannot read the queue order off. aria-sort is the
    // only thing that carries the ↑/↓ glyph's meaning to them.
    renderTab();
    await screen.findByText("RP00000001");
    const header = () =>
      screen
        .getByRole("button", { name: "Sort by time in queue" })
        .closest("th");

    expect(header()).toHaveAttribute("aria-sort", "none");
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by time in queue" }),
    );
    expect(header()).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by time in queue" }),
    );
    expect(header()).toHaveAttribute("aria-sort", "descending");
    // ...and the OTHER column is not claiming to be sorted at the same time.
    expect(
      screen.getByRole("button", { name: "Sort by facility" }).closest("th"),
    ).toHaveAttribute("aria-sort", "none");
  });

  it("keeps keyboard focus on the sort button across a click", async () => {
    // A component declared inside the render body is a NEW component type on
    // every render, so React unmounts and remounts it rather than updating it
    // — and the focused button goes with it. A keyboard user who sorts the
    // queue is then dumped back at the top of the document.
    renderTab();
    await screen.findByText("RP00000001");
    const button = screen.getByRole("button", {
      name: "Sort by time in queue",
    });
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sort by time in queue" }),
    );
  });

  it("types the transition responses as the register row, not the queue item", () => {
    // Compile-time only. `facility_name` and `status_changed_at` are columns
    // the QUEUE joins in; POST /devices/{id}/receive returns the register row
    // and has neither. Typing the transition helpers as the queue item made
    // the console's own types promise fields no transition ever answers — the
    // kind of lie that only surfaces when someone reads one off a mutation
    // result.
    type Transition = Awaited<ReturnType<typeof api.receiveCssdDevice>>;
    const pin: "facility_name" | "status_changed_at" extends keyof Transition
      ? never
      : true = true;
    expect(pin).toBe(true);
    // ...while the LIST row does carry them.
    const queued: keyof api.CathDevice = "status_changed_at";
    expect(queued).toBe("status_changed_at");
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
