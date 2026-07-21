import {
  sanitizePathwayReconciliationEvidence,
} from '../../services/pathways/pathwayReconciliationReadService.js';

describe('care pathway reconciliation response sanitization', () => {
  test('returns only bounded codes, counts, checksums, mode, and timestamps', () => {
    const row = {
      id: 1n,
      sweep_id: '30000000-0000-4000-8000-000000000001',
      pathway_key: 'diagnostics_order_to_action',
      pathway_mode: 'shadow',
      registry_version: 1,
      registry_checksum: 'a'.repeat(64),
      governance_checksum: 'b'.repeat(64),
      governance_count: 1,
      covered_governance_count: 1,
      expected_check_count: 1,
      executed_check_count: 1,
      finding_count: 0,
      repair_count: 0,
      error_count: 0,
      registry_complete: true,
      passed: true,
      check_results: [{
        code: 'SAFE_CODE',
        finding_count: -1,
        repair_count: Number.MAX_SAFE_INTEGER + 1,
        error_count: 'not-a-count',
        patient_uid: 'must-not-leak',
      }],
      started_at: new Date(),
      completed_at: new Date(),
      created_at: new Date(),
      patient_uid: 'must-not-leak',
      task_id: 99,
      last_error: 'must-not-leak',
    };
    const safe = sanitizePathwayReconciliationEvidence(row);
    expect(safe.patient_uid).toBeUndefined();
    expect(safe.task_id).toBeUndefined();
    expect(safe.last_error).toBeUndefined();
    expect(safe.check_results).toEqual([{
      code: 'SAFE_CODE',
      finding_count: 0,
      repair_count: 0,
      error_count: 0,
    }]);
  });
});
