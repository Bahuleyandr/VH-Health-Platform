import { jest } from '@jest/globals';
import { cohortCompatibilityTx } from '../../services/clinical/dialysisReuseService.js';

const TENANT = '00000000-0000-4000-8000-000000000101';
const PATIENT_A = '00000000-0000-4000-8000-00000000010a';
const PATIENT_B = '00000000-0000-4000-8000-00000000010b';
const MARKERS = ['hbsag', 'hcv', 'hiv'];

function evidenceRows(patientUid, reactiveMarker, legacyMarker) {
  return MARKERS.map((marker, index) => ({
    patient_uid: patientUid,
    as_of: '2026-09-07T10:00:00.000Z',
    hbsag_positive: legacyMarker === 'hbsag',
    hcv_positive: legacyMarker === 'hcv',
    hiv_positive: legacyMarker === 'hiv',
    marker_row_id: index + 1,
    marker,
    result: marker === reactiveMarker ? 'reactive' : 'non_reactive',
    tested_on: '2026-09-07',
    source: 'lab_result',
  }));
}

describe('cohort compatibility through the real Phase 1 v2 adapter', () => {
  test('cohortCompatibilityFailsClosedForLegacyRestrictionsAbsentFromMarkerEvidence', async () => {
    const shapes = ['legacy_only', 'mixed'];
    expect(MARKERS).toHaveLength(3);
    expect(shapes).toHaveLength(2);
    const cases = MARKERS.flatMap((marker, index) => shapes.map((shape) => ({
      marker, otherMarker: MARKERS[(index + 1) % MARKERS.length], shape,
    })));
    expect(cases).toHaveLength(6);
    const db = { $queryRawUnsafe: jest.fn() };
    const request = {
      tenantId: TENANT, patientUid: PATIENT_A, cohortPatientUids: [PATIENT_B],
      machine: { id: 7, status: 'active' }, db,
    };
    const results = [];
    for (const entry of cases) {
      db.$queryRawUnsafe.mockResolvedValue([
        ...evidenceRows(PATIENT_A, entry.marker, entry.marker),
        ...evidenceRows(PATIENT_B, entry.marker, null),
      ]);
      await expect(cohortCompatibilityTx(request)).resolves.toEqual({ verdict: 'compatible' });

      const reactiveMarker = entry.shape === 'mixed' ? entry.otherMarker : null;
      db.$queryRawUnsafe.mockResolvedValue([
        ...evidenceRows(PATIENT_A, reactiveMarker, entry.marker),
        ...evidenceRows(PATIENT_B, reactiveMarker, null),
      ]);
      results.push(await cohortCompatibilityTx(request));
    }
    expect(results).toEqual(cases.map(() => ({ verdict: 'not_established' })));
    expect(JSON.stringify(results)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(12);
  });
});
