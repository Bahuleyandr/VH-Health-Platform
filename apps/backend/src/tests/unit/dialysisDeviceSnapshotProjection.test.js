import { DIALYSIS_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { _internal } from '../../services/clinical/dialysisDeviceLifecycleService.js';

describe('dialysis lifecycle stored snapshot projection', () => {
  test('everyDialysisRoleReceivesMarkerFreeOperationalSnapshotsByValue', () => {
    expect(DIALYSIS_ROUTE_ROLES).toHaveLength(20);
    const screen = {
      contract_version: 2, status: 'restricted', evidence: 'marker',
      evidence_dated_on: '2026-09-07', asOf: '2026-09-07T10:00:00.000Z',
      reasons: ['hcv reactive clinical narrative'], isolation_class: 'hcv',
      markers: [{ marker: 'hcv', result: 'reactive', tested_on: '2026-09-07' }],
    };
    for (const role of DIALYSIS_ROUTE_ROLES) {
      const projected = _internal.usageView({
        id: 8n, device_id: 7n, patient_uid: 'patient',
        reuse_screen: screen, post_use_screen: screen,
        metadata: { narrative: 'hiv clinical narrative' },
      }, role);
      expect(projected.reuse_screen.status).toBe('restricted');
      expect(projected.post_use_screen.reasons).toEqual([]);
      expect(JSON.stringify(projected)).not.toMatch(/hbsag|\bhbv\b|\bhcv\b|\bhiv\b|hepatitis|isolation_mixed/i);
    }
  });

  test('poisonInAnOperationalDecisionValueFailsClosedWithoutEchoingEvidence', () => {
    const carriers = ['status', 'evidence', 'evidence_dated_on', 'asOf'];
    expect(carriers).toHaveLength(4);
    for (const carrier of carriers) {
      const screen = {
        contract_version: 2, status: 'restricted', evidence: 'marker',
        evidence_dated_on: '2026-09-07', asOf: '2026-09-07T10:00:00.000Z',
        reasons: [], [carrier]: 'hcv clinical narrative',
      };
      let failure;
      try { _internal.usageView({ reuse_screen: screen }, 'DOCTOR'); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'RPD_ISOLATION_DECISION_INVALID' });
      expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toMatch(/hcv/i);
    }
  });
});
