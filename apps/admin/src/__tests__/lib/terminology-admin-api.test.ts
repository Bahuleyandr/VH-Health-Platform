// Terminology & Knowledge console API client contract (slate C1 / WP5):
// every wrapper hits the exact proxied backend path with the right method,
// and isNotFoundError() recognizes the 404 shape the tabs use to degrade
// while sibling work packages (drug-kb coverage, lab code mappings) are
// unmerged.

import { fetchAdminAPI } from "@/lib/api/core";
import {
  createLabCodeMapping,
  getDrugKbCoverage,
  getDrugKbStatus,
  getLabCodeMappingCoverage,
  getTerminologyCoverage,
  getTerminologySettings,
  isNotFoundError,
  listLabCodeMappings,
  listTerminologyCodeSystems,
  saveTerminologyBinding,
  suggestTerminologyBindings,
  updateTerminologySettings,
} from "@/lib/api/terminologyAdmin";

jest.mock("@/lib/api/core", () => ({ fetchAdminAPI: jest.fn() }));

const fetchAdminAPIMock = fetchAdminAPI as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  fetchAdminAPIMock.mockResolvedValue({});
});

describe("terminology reads", () => {
  it("hits the served terminology endpoints", async () => {
    await listTerminologyCodeSystems();
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/terminology/code-systems");

    await getTerminologySettings();
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/terminology/settings");

    await getTerminologyCoverage();
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/terminology/coverage");
  });
});

describe("terminology writes", () => {
  it("PUTs settings including the WP2 coding_enforcement shape", async () => {
    await updateTerminologySettings({
      preferred_diagnosis_system: "ICD10",
      enabled_systems: ["ICD10", "ICD11"],
      snomed_pickers_enabled: false,
      coding_enforcement: { death_certificate: "warn" },
    });
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/terminology/settings", {
      method: "PUT",
      body: {
        preferred_diagnosis_system: "ICD10",
        enabled_systems: ["ICD10", "ICD11"],
        snomed_pickers_enabled: false,
        coding_enforcement: { death_certificate: "warn" },
      },
    });
  });

  it("runs binding suggestions and writes decisions", async () => {
    await suggestTerminologyBindings({
      catalog_type: "investigation_test",
      limit: 50,
    });
    expect(fetchAdminAPIMock).toHaveBeenCalledWith(
      "/terminology/bindings/suggest",
      {
        method: "POST",
        body: { catalog_type: "investigation_test", limit: 50 },
      },
    );

    await saveTerminologyBinding({
      catalog_type: "investigation_test",
      catalog_id: 7,
      system: "LOINC",
      code: "2160-0",
      binding_status: "confirmed",
    });
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/terminology/bindings", {
      method: "POST",
      body: {
        catalog_type: "investigation_test",
        catalog_id: 7,
        system: "LOINC",
        code: "2160-0",
        binding_status: "confirmed",
      },
    });
  });
});

describe("drug KB + lab mapping endpoints (sibling-owned paths)", () => {
  it("hits the frozen-contract paths", async () => {
    await getDrugKbStatus();
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/drug-kb/status");

    await getDrugKbCoverage();
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/drug-kb/coverage");

    await listLabCodeMappings();
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/lab/code-mappings");

    await getLabCodeMappingCoverage();
    expect(fetchAdminAPIMock).toHaveBeenCalledWith(
      "/lab/code-mappings/coverage",
    );

    await createLabCodeMapping({
      source_key: "any",
      incoming_code: "GLU",
      loinc_code: "2345-7",
      active: true,
    });
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/lab/code-mappings", {
      method: "POST",
      body: {
        source_key: "any",
        incoming_code: "GLU",
        loinc_code: "2345-7",
        active: true,
      },
    });
  });
});

describe("isNotFoundError (the degrade seam)", () => {
  it("matches only the 404 APIError shape", () => {
    expect(isNotFoundError({ status: 404 })).toBe(true);
    expect(isNotFoundError(Object.assign(new Error("x"), { status: 404 }))).toBe(
      true,
    );
    expect(isNotFoundError({ status: 500 })).toBe(false);
    expect(isNotFoundError(new Error("network"))).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });
});
