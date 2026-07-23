import { fetchAdminAPI } from "./core";

export type CarePathwayEvidenceResult = {
  code: string;
  finding_count: number;
  repair_count: number;
  error_count: number;
};

export type CarePathwayEvidence = {
  id: string;
  sweep_id: string;
  pathway_key: string;
  pathway_mode: "off" | "shadow" | "active";
  registry_version: number;
  registry_checksum: string;
  governance_checksum: string;
  governance_count: number;
  covered_governance_count: number;
  expected_check_count: number;
  executed_check_count: number;
  finding_count: number;
  repair_count: number;
  error_count: number;
  registry_complete: boolean;
  passed: boolean;
  check_results: CarePathwayEvidenceResult[];
  started_at: string;
  completed_at: string;
  created_at: string;
};

export type CarePathwayEvidenceResponse = {
  evidence: CarePathwayEvidence[];
  count: number;
  limit: number;
  offset: number;
};

export function getCarePathwayReconciliationEvidence(
  view: "latest" | "history" = "latest",
) {
  const suffix = view === "history" ? "/history" : "";
  return fetchAdminAPI<CarePathwayEvidenceResponse>(
    `/admin/care-pathways/reconciliation${suffix}`,
  );
}
