// Terminology & Knowledge console page (slate C1 / WP5): the ADMIN client
// gate, the five tabs, and the graceful-degrade seam — tabs backed by
// sibling work packages render a "not available yet" notice on 404 instead
// of an error state.

import TerminologyPage from "@/app/(with-auth)/dashboard/terminology/page";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

let allowed = true;

jest.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ allowed }),
}));

const notFound = () =>
  Object.assign(new Error("API Error: 404"), { status: 404 });

const listTerminologyCodeSystems = jest.fn();
const getTerminologyCoverage = jest.fn();
const getTerminologySettings = jest.fn();
const updateTerminologySettings = jest.fn();
const suggestTerminologyBindings = jest.fn();
const saveTerminologyBinding = jest.fn();
const getDrugKbStatus = jest.fn();
const getDrugKbCoverage = jest.fn();
const listLabCodeMappings = jest.fn();
const createLabCodeMapping = jest.fn();
const getLabCodeMappingCoverage = jest.fn();

jest.mock("@/lib/api/terminologyAdmin", () => {
  const actual = jest.requireActual("@/lib/api/terminologyAdmin");
  return {
    ...actual,
    listTerminologyCodeSystems: (...args: unknown[]) =>
      listTerminologyCodeSystems(...args),
    getTerminologyCoverage: (...args: unknown[]) =>
      getTerminologyCoverage(...args),
    getTerminologySettings: (...args: unknown[]) =>
      getTerminologySettings(...args),
    updateTerminologySettings: (...args: unknown[]) =>
      updateTerminologySettings(...args),
    suggestTerminologyBindings: (...args: unknown[]) =>
      suggestTerminologyBindings(...args),
    saveTerminologyBinding: (...args: unknown[]) =>
      saveTerminologyBinding(...args),
    getDrugKbStatus: (...args: unknown[]) => getDrugKbStatus(...args),
    getDrugKbCoverage: (...args: unknown[]) => getDrugKbCoverage(...args),
    listLabCodeMappings: (...args: unknown[]) => listLabCodeMappings(...args),
    createLabCodeMapping: (...args: unknown[]) => createLabCodeMapping(...args),
    getLabCodeMappingCoverage: (...args: unknown[]) =>
      getLabCodeMappingCoverage(...args),
  };
});

function primeDefaults() {
  listTerminologyCodeSystems.mockResolvedValue({
    systems: [
      {
        system_key: "ICD10",
        uri: "http://hl7.org/fhir/sid/icd-10",
        name: "ICD-10 (WHO)",
        version: "2019",
        source: "WHO",
        license_note: "WHO — free for member-state use",
        concept_count: 12450,
        imported_at: "2026-08-01T00:00:00.000Z",
        is_active: true,
      },
      {
        system_key: "SNOMED_CT",
        uri: "http://snomed.info/sct",
        name: "SNOMED CT",
        version: null,
        source: "NRC India RF2 snapshot",
        license_note: "Free Indian national license (NRC)",
        concept_count: 0,
        imported_at: null,
        is_active: true,
      },
    ],
    count: 2,
  });
  getTerminologyCoverage.mockResolvedValue({
    coverage: {
      catalog_bindings: [
        {
          catalog_type: "investigation_test",
          table: "investigation_test_catalog",
          default_system: "LOINC",
          catalog_rows: 210,
          confirmed: 42,
          suggested: 10,
          rejected: 3,
          confirmed_pct: 20,
        },
      ],
      concept_maps: [],
    },
  });
  getTerminologySettings.mockResolvedValue({
    settings: {
      tenant_id: "33333333-3333-4333-8333-333333333333",
      preferred_diagnosis_system: "ICD11",
      enabled_systems: ["ICD10", "ICD11"],
      snomed_pickers_enabled: false,
      coding_enforcement: { death_certificate: "warn" },
      is_default: false,
    },
  });
  getDrugKbStatus.mockResolvedValue({
    kb_available: true,
    sources: [
      {
        source_key: "vh_starter_set",
        name: "VH starter set",
        vendor: null,
        version: "1",
        license_note: null,
        is_starter: true,
        is_active: true,
        priority: 0,
        source_family: null,
        edition_status: null,
        license_status: null,
        imported_at: null,
      },
    ],
    counts: { monographs: 40 },
    starter_only: true,
  });
  // Sibling-owned endpoints: unmerged locally ⇒ 404.
  getDrugKbCoverage.mockRejectedValue(notFound());
  listLabCodeMappings.mockRejectedValue(notFound());
  getLabCodeMappingCoverage.mockRejectedValue(notFound());
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TerminologyPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  allowed = true;
  primeDefaults();
});

describe("access gate", () => {
  it("shows the ADMIN-only notice to a lower role", () => {
    allowed = false;
    renderPage();
    expect(screen.getByText(/ADMIN-only console/i)).toBeInTheDocument();
    expect(screen.queryByText(/Registered code systems/)).toBeNull();
  });
});

describe("code systems tab (default)", () => {
  it("renders the system registry with counts, provenance, and coverage", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("ICD-10 (WHO)")).toBeInTheDocument(),
    );
    expect(screen.getByText("12,450")).toBeInTheDocument();
    expect(
      screen.getByText(/Free Indian national license/),
    ).toBeInTheDocument();
    // Coverage table
    expect(screen.getByText("investigation_test")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
  });
});

describe("tenant settings tab", () => {
  it("loads settings incl. per-surface enforcement and saves the full shape", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Tenant settings" }));
    await waitFor(() =>
      expect(
        screen.getByText(/Per-surface coding enforcement/),
      ).toBeInTheDocument(),
    );
    // The three WP2 surfaces are offered.
    expect(screen.getByText(/Death certification/)).toBeInTheDocument();
    expect(screen.getByText(/Insurance preauth/)).toBeInTheDocument();
    expect(screen.getByText(/Discharge summary/)).toBeInTheDocument();

    // Wait for the form state to hydrate from the loaded settings (the
    // enabled-systems checkboxes flip on when the effect has run).
    await waitFor(() => {
      const checkboxes = screen.getAllByRole("checkbox");
      expect(checkboxes[0]).toBeChecked(); // ICD10
    });

    updateTerminologySettings.mockResolvedValue({ settings: {} });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(updateTerminologySettings).toHaveBeenCalled());
    expect(updateTerminologySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        preferred_diagnosis_system: "ICD11",
        snomed_pickers_enabled: false,
        coding_enforcement: expect.objectContaining({
          death_certificate: "warn",
        }),
      }),
    );
  });
});

describe("drug KB tab", () => {
  it("shows sources, the starter-only warning, and degrades coverage on 404", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Drug KB" }));
    await waitFor(() =>
      expect(screen.getByText("vh_starter_set")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Only the built-in starter set is active/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText(/Formulary coverage endpoint not available yet/),
      ).toBeInTheDocument(),
    );
  });
});

describe("lab mappings tab (sibling endpoints unmerged)", () => {
  it("degrades to not-available notices instead of an error state", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Lab mappings" }));
    await waitFor(() =>
      expect(
        screen.getByText(/Lab code-mapping endpoints not available yet/),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Mapping coverage endpoint not available yet/),
    ).toBeInTheDocument();
    // No raw error text leaks.
    expect(screen.queryByText(/API Error: 404/)).toBeNull();
  });

  it("renders rows and the create form when the endpoints exist", async () => {
    listLabCodeMappings.mockResolvedValue({
      mappings: [
        {
          id: 1,
          source_key: "any",
          incoming_code: "GLU",
          incoming_code_system: null,
          catalog_id: null,
          loinc_code: "2345-7",
          display: "Glucose",
          active: true,
        },
      ],
      count: 1,
    });
    getLabCodeMappingCoverage.mockResolvedValue({
      mapped_codes: 1,
      distinct_incoming_codes: 4,
      mapped_pct: 25,
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Lab mappings" }));
    await waitFor(() => expect(screen.getByText("GLU")).toBeInTheDocument());
    expect(screen.getByText("2345-7")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add mapping" }),
    ).toBeInTheDocument();
  });
});
