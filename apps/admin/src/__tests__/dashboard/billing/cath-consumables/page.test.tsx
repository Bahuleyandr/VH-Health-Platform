import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";

import CathConsumablesPage from "@/app/(with-auth)/dashboard/billing/cath-consumables/page";
import {
  getCathConsumablesBillingSettings,
  listActiveInventoryItems,
  listCathConsumablesCatalog,
  listCathConsumablesUnbilledUsage,
  updateCathConsumablesBillingSettings,
  upsertCathConsumable,
} from "@/lib/api/cathConsumables";

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

jest.mock("@/lib/api/cathConsumables", () => ({
  getCathConsumablesBillingSettings: jest.fn(),
  listActiveInventoryItems: jest.fn(),
  listCathConsumablesCatalog: jest.fn(),
  listCathConsumablesUnbilledUsage: jest.fn(),
  updateCathConsumablesBillingSettings: jest.fn(),
  upsertCathConsumable: jest.fn(),
}));

const mockedCatalog = listCathConsumablesCatalog as jest.MockedFunction<
  typeof listCathConsumablesCatalog
>;
const mockedInventory = listActiveInventoryItems as jest.MockedFunction<
  typeof listActiveInventoryItems
>;
const mockedUnbilled = listCathConsumablesUnbilledUsage as jest.MockedFunction<
  typeof listCathConsumablesUnbilledUsage
>;
const mockedGetSettings =
  getCathConsumablesBillingSettings as jest.MockedFunction<
    typeof getCathConsumablesBillingSettings
  >;
const mockedUpdateSettings =
  updateCathConsumablesBillingSettings as jest.MockedFunction<
    typeof updateCathConsumablesBillingSettings
  >;
const mockedUpsert = upsertCathConsumable as jest.MockedFunction<
  typeof upsertCathConsumable
>;

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function seedApiMocks() {
  mockedCatalog.mockResolvedValue({
    items: [
      {
        id: 11,
        item_name: "Everolimus coronary stent",
        category: "stent",
        manufacturer: "Synthetic Med",
        model: "ST-24",
        is_implant: true,
        batch_tracked: true,
        default_unit_cost_reference: 24000,
        billing_item_code: null,
        inventory_item_id: 71,
        inventory_item_name: "Coronary stent stock",
        inventory_sku: "CATH-STENT-001",
        status: "active",
      },
    ],
    count: 1,
  } as never);
  mockedInventory.mockResolvedValue({
    items: [
      {
        id: 71,
        sku_code: "CATH-STENT-001",
        display_name: "Coronary stent stock",
        manufacturer: "Synthetic Med",
        status: "active",
      },
    ],
    count: 1,
  });
  mockedGetSettings.mockResolvedValue({
    settings: {
      charge_enabled: false,
      procedure_billing_code: "CATH-PROC-OWNER",
      procedure_unit_price: 12000,
      gst_rate: 5,
      finance_reviewed_at: "2026-07-09T08:00:00.000Z",
    },
  } as never);
  mockedUnbilled.mockResolvedValue({
    items: [
      {
        usage_id: 901,
        case_id: 41,
        procedure_log_id: 88,
        patient_uid: "11111111-1111-4111-8111-111111111111",
        patient_name: "Synthetic Patient",
        item_name: "Everolimus coronary stent",
        category: "stent",
        quantity: 1,
        wasted: false,
        waste_reason: null,
        used_at: "2026-07-10T08:30:00.000Z",
        billing_gap_reason: "UNMAPPED_BILLING_CODE",
      },
    ],
    count: 1,
    total: 101,
    page: 1,
    limit: 50,
  } as never);
  mockedUpsert.mockResolvedValue({ item: { id: 12 } } as never);
  mockedUpdateSettings.mockResolvedValue({
    settings: {
      charge_enabled: true,
      procedure_billing_code: "CATH-PROC-OWNER",
      procedure_unit_price: 12000,
      gst_rate: 5,
      finance_reviewed_at: "2026-07-09T08:00:00.000Z",
    },
  } as never);
}

describe("<CathConsumablesPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedApiMocks();
  });

  it("renders the catalog, inventory link, and inert billing settings", async () => {
    renderWithQuery(<CathConsumablesPage />);

    expect(
      screen.getByRole("heading", { name: "Cath Consumables & Implants" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Everolimus coronary stent"),
    ).toBeInTheDocument();
    expect(screen.getByText("Coronary stent stock")).toBeInTheDocument();
    expect(screen.getByText("Unmapped")).toBeInTheDocument();
    expect(screen.getByText("Inert")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CATH-PROC-OWNER")).toBeInTheDocument();
    expect(mockedCatalog).toHaveBeenCalledWith({
      q: undefined,
      category: undefined,
      status: "active",
      limit: 500,
    });
  });

  it("creates a batch-tracked implant linked to existing inventory", async () => {
    renderWithQuery(<CathConsumablesPage />);
    await screen.findByText("Everolimus coronary stent");

    fireEvent.click(screen.getByRole("button", { name: "Add catalog item" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Item name"), {
      target: { value: "Owner approved stent" },
    });
    fireEvent.change(within(dialog).getByLabelText("Category"), {
      target: { value: "stent" },
    });
    expect(
      within(dialog).getByRole("checkbox", { name: /Implant/ }),
    ).toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: /Implant/ }),
    ).toBeDisabled();
    expect(
      within(dialog)
        .getByRole("checkbox", { name: /Implant/ })
        .closest("label"),
    ).toHaveClass("cursor-not-allowed", "opacity-60");
    expect(
      within(dialog).getByRole("checkbox", { name: /Batch tracked/ }),
    ).toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: /Batch tracked/ }),
    ).toBeDisabled();
    expect(
      await within(dialog).findByRole("option", {
        name: "Coronary stent stock (CATH-STENT-001)",
      }),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Linked inventory item"), {
      target: { value: "71" },
    });
    fireEvent.change(within(dialog).getByLabelText("Billing item code"), {
      target: { value: "CATH-STENT-BILL" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add item" }));

    await waitFor(() => {
      expect(mockedUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          item_name: "Owner approved stent",
          category: "stent",
          inventory_item_id: 71,
          billing_item_code: "CATH-STENT-BILL",
          is_implant: true,
          batch_tracked: true,
          status: "active",
        }),
      );
    });
  });

  it("clears optional catalog metadata and owner billing mapping", async () => {
    mockedCatalog.mockResolvedValue({
      items: [
        {
          id: 11,
          item_name: "Everolimus coronary stent",
          category: "stent",
          manufacturer: "Synthetic Med",
          model: "ST-24",
          is_implant: true,
          batch_tracked: true,
          default_unit_cost_reference: 24000,
          billing_item_code: "CATH-STENT-BILL",
          inventory_item_id: 71,
          inventory_item_name: "Coronary stent stock",
          inventory_sku: "CATH-STENT-001",
          status: "active",
        },
      ],
      count: 1,
    } as never);
    renderWithQuery(<CathConsumablesPage />);
    await screen.findByText("Everolimus coronary stent");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    for (const label of [
      "Manufacturer",
      "Model",
      "Default unit cost reference",
      "Billing item code",
    ]) {
      fireEvent.change(within(dialog).getByLabelText(label), {
        target: { value: "" },
      });
    }
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(mockedUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 11,
          manufacturer: null,
          model: null,
          default_unit_cost_reference: null,
          billing_item_code: null,
        }),
      );
    });
  });

  it("keeps batch tracking locked while an optional category is an implant", async () => {
    renderWithQuery(<CathConsumablesPage />);
    await screen.findByText("Everolimus coronary stent");

    fireEvent.click(screen.getByRole("button", { name: "Add catalog item" }));
    const dialog = screen.getByRole("dialog");
    const implant = within(dialog).getByRole("checkbox", { name: /Implant/ });
    const batchTracked = within(dialog).getByRole("checkbox", {
      name: /Batch tracked/,
    });

    expect(implant).toBeEnabled();
    expect(batchTracked).toBeEnabled();
    fireEvent.click(implant);
    expect(batchTracked).toBeChecked();
    expect(batchTracked).toBeDisabled();
    fireEvent.click(implant);
    expect(batchTracked).toBeEnabled();
  });

  it("sends catalog search and filters to the server with the full limit", async () => {
    renderWithQuery(<CathConsumablesPage />);
    await screen.findByText("Everolimus coronary stent");

    fireEvent.change(
      screen.getByPlaceholderText("Item, model, billing code, inventory"),
      {
        target: { value: "coronary" },
      },
    );
    fireEvent.change(screen.getByLabelText("Category"), {
      target: { value: "stent" },
    });
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "retired" },
    });

    await waitFor(() => {
      expect(mockedCatalog).toHaveBeenCalledWith({
        q: "coronary",
        category: "stent",
        status: "retired",
        limit: 500,
      });
    });
  });

  it("saves the compact billing settings panel", async () => {
    renderWithQuery(<CathConsumablesPage />);
    await screen.findByDisplayValue("CATH-PROC-OWNER");

    fireEvent.click(screen.getByLabelText("Enable cath procedure charging"));
    fireEvent.click(
      screen.getByRole("button", { name: "Save billing settings" }),
    );

    await waitFor(() => {
      expect(mockedUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          charge_enabled: true,
          procedure_billing_code: "CATH-PROC-OWNER",
          procedure_unit_price: 12000,
          gst_rate: 5,
          finance_reviewed_at: expect.any(String),
        }),
      );
    });
  });

  it("validates an inert procedure code and price as an atomic mapping", async () => {
    renderWithQuery(<CathConsumablesPage />);
    await screen.findByDisplayValue("CATH-PROC-OWNER");

    fireEvent.change(screen.getByLabelText("Procedure unit price"), {
      target: { value: "" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save billing settings" }),
    );

    expect(
      await screen.findByText(
        "Procedure billing code and unit price must be mapped together.",
      ),
    ).toBeInTheDocument();
    expect(mockedUpdateSettings).not.toHaveBeenCalled();
  });

  it("clears the owner procedure code and price as one atomic mapping", async () => {
    renderWithQuery(<CathConsumablesPage />);
    await screen.findByDisplayValue("CATH-PROC-OWNER");

    fireEvent.change(screen.getByLabelText("Procedure billing code"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Procedure unit price"), {
      target: { value: "" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save billing settings" }),
    );

    await waitFor(() => {
      expect(mockedUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          charge_enabled: false,
          procedure_billing_code: null,
          procedure_unit_price: null,
        }),
      );
    });
  });

  it("searches inventory server-side and preserves an existing link", async () => {
    mockedInventory.mockResolvedValue({ items: [], count: 0 });
    renderWithQuery(<CathConsumablesPage />);
    await screen.findByText("Everolimus coronary stent");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("option", {
        name: "Coronary stent stock (CATH-STENT-001)",
      }),
    ).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Search inventory items"), {
      target: { value: "guidewire" },
    });

    await waitFor(() => {
      expect(mockedInventory).toHaveBeenCalledWith({
        q: "guidewire",
        limit: 50,
      });
    });
    expect(within(dialog).getByLabelText("Linked inventory item")).toHaveValue(
      "71",
    );
  });

  it("retires catalog items without deleting their clinical history", async () => {
    renderWithQuery(<CathConsumablesPage />);
    await screen.findByText("Everolimus coronary stent");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Retire Everolimus coronary stent",
      }),
    );

    await waitFor(() => {
      expect(mockedUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 11,
          item_name: "Everolimus coronary stent",
          status: "retired",
        }),
      );
    });
  });

  it("shows every fail-visible unbilled usage row", async () => {
    renderWithQuery(<CathConsumablesPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Unbilled Usage" }));

    expect(await screen.findByText("Synthetic Patient")).toBeInTheDocument();
    expect(screen.getByText("Case #41")).toBeInTheDocument();
    expect(screen.getByText("Procedure #88")).toBeInTheDocument();
    expect(screen.getByText("UNMAPPED_BILLING_CODE")).toBeInTheDocument();
    expect(
      screen.getByText(/Showing 1–50 of 101 unresolved usage rows/),
    ).toBeInTheDocument();
    expect(mockedUnbilled).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 50 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(mockedUnbilled).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, limit: 50 }),
      );
    });
  });
});
