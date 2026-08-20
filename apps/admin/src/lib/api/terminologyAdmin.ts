// Terminology & Knowledge console client (slate C1 / WP5).
//
// Read/curation surface for /dashboard/terminology. Every call goes through
// the same proxied fetchAdminAPI stack as the rest of the portal
// (auto-prepends /api/v1; backend RBAC governs writes — binding/settings
// writes are curator-role-gated server-side).
//
// Endpoints owned by sibling work packages — GET /drug-kb/coverage (WP4) and
// the GET/POST /lab/code-mappings family (WP3) — may 404 until those
// packages merge. Callers use isNotFoundError() to degrade the affected tab
// to a "not available yet" notice instead of an error state.
//
// NOTE: this module is deliberately named terminologyAdmin.ts — the sibling
// WP2 package owns src/lib/api/terminology.ts (the CodeSearchField client).

import { fetchAdminAPI } from "./core";

/** True for the APIError a proxied 404 raises (feature not merged/served). */
export function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: unknown }).status === 404
  );
}

// ── Code systems + import provenance ────────────────────────────────────────

export interface TerminologyCodeSystem {
  system_key: string;
  uri: string | null;
  name: string | null;
  version: string | null;
  source: string | null;
  license_note: string | null;
  concept_count: number | null;
  imported_at: string | null;
  is_active: boolean;
}

export interface TerminologyCodeSystemList {
  systems: TerminologyCodeSystem[];
  count: number;
}

export function listTerminologyCodeSystems() {
  return fetchAdminAPI<TerminologyCodeSystemList>("/terminology/code-systems");
}

// ── Tenant settings (incl. WP2 per-surface coding enforcement) ──────────────

export type CodingEnforcementLevel = "off" | "warn" | "block";

export type CodingEnforcementSurface =
  "death_certificate" | "insurance_claim" | "discharge_summary";

export const CODING_ENFORCEMENT_SURFACES: CodingEnforcementSurface[] = [
  "death_certificate",
  "insurance_claim",
  "discharge_summary",
];

export const CODING_ENFORCEMENT_LEVELS: CodingEnforcementLevel[] = [
  "off",
  "warn",
  "block",
];

export const TERMINOLOGY_SYSTEMS = [
  "ICD10",
  "ICD11",
  "SNOMED_CT",
  "LOINC",
  "ATC",
] as const;

export interface TerminologySettings {
  tenant_id: string | null;
  preferred_diagnosis_system: string;
  enabled_systems: string[];
  snomed_pickers_enabled: boolean;
  /** WP2 per-surface enforcement JSONB — absent until that package merges. */
  coding_enforcement?: Partial<
    Record<CodingEnforcementSurface, CodingEnforcementLevel>
  >;
  is_default?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export function getTerminologySettings() {
  return fetchAdminAPI<{ settings: TerminologySettings }>(
    "/terminology/settings",
  );
}

export interface TerminologySettingsWrite {
  preferred_diagnosis_system?: string;
  enabled_systems?: string[];
  snomed_pickers_enabled?: boolean;
  /** WP2 shape; the pre-merge backend ignores this key harmlessly. */
  coding_enforcement?: Partial<
    Record<CodingEnforcementSurface, CodingEnforcementLevel>
  >;
}

export function updateTerminologySettings(payload: TerminologySettingsWrite) {
  return fetchAdminAPI<{ settings: TerminologySettings }>(
    "/terminology/settings",
    { method: "PUT", body: payload },
  );
}

// ── Binding curation (suggest → confirm/reject) + coverage ──────────────────

export type TerminologyCatalogType =
  "investigation_test" | "pharmacy_item" | "medication";

export const TERMINOLOGY_CATALOG_TYPES: TerminologyCatalogType[] = [
  "investigation_test",
  "pharmacy_item",
  "medication",
];

export interface TerminologyBindingSuggestion {
  catalog_type: string;
  catalog_id: number;
  catalog_name: string | null;
  system_key: string;
  code: string;
  display: string | null;
  confidence: number;
}

export function suggestTerminologyBindings(payload: {
  catalog_type: TerminologyCatalogType;
  system?: string | null;
  limit?: number;
  persist?: boolean;
}) {
  return fetchAdminAPI<{
    suggestions: TerminologyBindingSuggestion[];
    count: number;
  }>("/terminology/bindings/suggest", { method: "POST", body: payload });
}

export interface TerminologyBindingWrite {
  catalog_type: TerminologyCatalogType;
  catalog_id: number;
  system: string;
  code: string;
  display?: string | null;
  binding_status?: "confirmed" | "suggested" | "rejected";
  confidence?: number | null;
}

export function saveTerminologyBinding(payload: TerminologyBindingWrite) {
  return fetchAdminAPI<{ binding: unknown }>("/terminology/bindings", {
    method: "POST",
    body: payload,
  });
}

export interface TerminologyCatalogBindingCoverage {
  catalog_type: string;
  table: string;
  default_system: string;
  catalog_rows: number;
  confirmed: number;
  suggested: number;
  rejected: number;
  confirmed_pct: number;
}

export interface TerminologyConceptMapCoverage {
  source_system: string;
  target_system: string;
  total: number;
  relationships: {
    equivalent: number;
    broader: number;
    narrower: number;
    related: number;
  };
}

export interface TerminologyCoverage {
  catalog_bindings: TerminologyCatalogBindingCoverage[];
  concept_maps: TerminologyConceptMapCoverage[];
}

export function getTerminologyCoverage() {
  return fetchAdminAPI<{ coverage: TerminologyCoverage }>(
    "/terminology/coverage",
  );
}

// ── Drug KB sources / status / coverage ─────────────────────────────────────

export interface DrugKbSource {
  source_key: string;
  name: string | null;
  vendor: string | null;
  version: string | null;
  license_note: string | null;
  is_starter: boolean;
  is_active: boolean;
  priority: number | null;
  source_family: string | null;
  edition_status: string | null;
  license_status: string | null;
  imported_at: string | null;
  /** WP4 governance columns — absent until that package merges. */
  license_holder?: string | null;
  license_expires_at?: string | null;
  vendor_edition?: string | null;
}

export interface DrugKbStatus {
  kb_available: boolean;
  sources: DrugKbSource[];
  counts: Record<string, number> | null;
  starter_only: boolean | null;
}

export function getDrugKbStatus() {
  return fetchAdminAPI<DrugKbStatus>("/drug-kb/status");
}

/**
 * WP4 formulary-coverage report (frozen contract: match stats per resolution
 * tier). Kept structurally loose so the tab renders whatever the merged
 * endpoint reports; 404s pre-merge.
 */
export interface DrugKbCoverage {
  catalog_rows?: number;
  matched?: number;
  matched_pct?: number;
  tiers?: Record<string, number>;
  [key: string]: unknown;
}

export function getDrugKbCoverage() {
  return fetchAdminAPI<DrugKbCoverage>("/drug-kb/coverage");
}

// ── Lab analyzer-code → LOINC mappings (WP3) ────────────────────────────────

export interface LabCodeMapping {
  id: number;
  source_key: string;
  incoming_code: string;
  incoming_code_system: string | null;
  catalog_id: number | null;
  loinc_code: string | null;
  display: string | null;
  active: boolean;
  verified_by?: string | null;
  verified_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface LabCodeMappingList {
  mappings?: LabCodeMapping[];
  count?: number;
  [key: string]: unknown;
}

export function listLabCodeMappings() {
  return fetchAdminAPI<LabCodeMappingList>("/lab/code-mappings");
}

export interface LabCodeMappingWrite {
  source_key?: string;
  incoming_code: string;
  incoming_code_system?: string | null;
  catalog_id?: number | null;
  loinc_code?: string | null;
  display?: string | null;
  active?: boolean;
}

export function createLabCodeMapping(payload: LabCodeMappingWrite) {
  return fetchAdminAPI<{ mapping?: LabCodeMapping }>("/lab/code-mappings", {
    method: "POST",
    body: payload,
  });
}

export interface LabCodeMappingCoverage {
  mapped_codes?: number;
  distinct_incoming_codes?: number;
  mapped_pct?: number;
  catalog_loinc_bound_pct?: number;
  [key: string]: unknown;
}

export function getLabCodeMappingCoverage() {
  return fetchAdminAPI<LabCodeMappingCoverage>("/lab/code-mappings/coverage");
}
