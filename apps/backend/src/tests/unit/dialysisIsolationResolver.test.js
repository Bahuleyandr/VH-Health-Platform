import { jest } from '@jest/globals';

import {
  CONTRACT_VERSION,
  resolveDialysisIsolation,
} from '../../services/clinical/dialysisIsolationResolver.js';

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const TENANT = '76700000-0000-4000-8000-000000000002';
const PATIENT_A = '76700000-0000-4000-8000-00000000000a';
const PATIENT_B = '76700000-0000-4000-8000-00000000000b';
const AS_OF = new Date('2026-09-07T08:00:00.000Z');

function row(patientUid, overrides = {}) {
  return {
    patient_uid: patientUid,
    as_of: AS_OF,
    hbsag_positive: false,
    hcv_positive: false,
    hiv_positive: false,
    marker_row_id: null,
    marker: null,
    result: null,
    tested_on: null,
    source: null,
    ...overrides,
  };
}

function dbReturning(rows) {
  return { $queryRawUnsafe: jest.fn().mockResolvedValue(rows) };
}

function resolve(patientUids, rows, options = {}) {
  const db = dbReturning(rows);
  return {
    db,
    result: resolveDialysisIsolation({
      tenantId: TENANT,
      patientUids,
      db,
      contractVersion: CONTRACT_VERSION,
      ...options,
    }),
  };
}

describe('resolveDialysisIsolation Phase 1 contract', () => {
  it('the fixture tenant is non-default before any isolation assertion runs', () => {
    expect(TENANT).not.toBe(DEFAULT_TENANT);
  });

  it('legacy-positive-alone restricts without corroboration', async () => {
    const { result } = resolve([PATIENT_A], [row(PATIENT_A, { hbsag_positive: true })], {
      includeIsolationClass: true,
    });
    await expect(result).resolves.toEqual(new Map([[PATIENT_A, {
      contract_version: 2,
      status: 'restricted',
      asOf: AS_OF.toISOString(),
      reasons: ['DIALYSIS_HBSAG_POSITIVE'],
      evidence: 'legacy_declaration',
      evidence_dated_on: null,
      isolation_class: 'hbsag',
    }]]));
  });

  it('legacy-negative-alone is not evidence and resolves unknown', async () => {
    const { result } = resolve([PATIENT_A], [row(PATIENT_A)]);
    const decision = (await result).get(PATIENT_A);
    expect(decision).toMatchObject({
      status: 'unknown', evidence: 'none', evidence_dated_on: null,
    });
    expect(decision).not.toHaveProperty('markers');
    expect(decision).not.toHaveProperty('isolation_class');
  });

  it('legacy negatives do not modify corroborating evidence', async () => {
    const rows = ['hbsag', 'hcv', 'hiv'].map((marker, index) => row(PATIENT_A, {
      marker_row_id: String(index + 1),
      marker,
      result: 'non_reactive',
      tested_on: `2026-09-0${index + 1}`,
      source: 'clinical_declaration',
    }));
    const { result } = resolve([PATIENT_A], rows, { includeMarkers: true });
    const decision = (await result).get(PATIENT_A);
    expect(decision.status).toBe('clear');
    expect(decision.evidence).toBe('marker');
    expect(decision.evidence_dated_on).toBe('2026-09-03');
    expect(decision.markers).toHaveLength(3);
    expect(decision.markers[0]).toEqual({
      marker: 'hbsag',
      result: 'non_reactive',
      tested_on: '2026-09-01',
      marker_row_id: 1,
      source: 'clinical_declaration',
    });
  });

  it('a reactive row latches, while a voided reactive is excluded by the batch query', async () => {
    const rows = [
      row(PATIENT_A, {
        marker_row_id: '9', marker: 'hiv', result: 'reactive',
        tested_on: '2026-01-01', source: 'lab_result',
      }),
      row(PATIENT_A, {
        marker_row_id: '10', marker: 'hiv', result: 'non_reactive',
        tested_on: '2026-09-01', source: 'lab_result',
      }),
    ];
    const { db, result } = resolve([PATIENT_A], rows);
    expect((await result).get(PATIENT_A)).toMatchObject({
      status: 'restricted', evidence: 'marker', reasons: ['DIALYSIS_HIV_POSITIVE'],
    });
    expect(db.$queryRawUnsafe.mock.calls[0][0]).toMatch(/voided_at IS NULL/);
  });

  it('newer pending or indeterminate evidence prevents an older negative from clearing', async () => {
    const rows = [
      row(PATIENT_A, { marker: 'hbsag', result: 'non_reactive', tested_on: '2026-09-01', source: 'dialysis_serology' }),
      row(PATIENT_A, { marker: 'hcv', result: 'non_reactive', tested_on: '2026-09-01', source: 'dialysis_serology' }),
      row(PATIENT_A, { marker: 'hiv', result: 'non_reactive', tested_on: '2026-08-01', source: 'dialysis_serology' }),
      row(PATIENT_A, { marker: 'hiv', result: 'pending', tested_on: '2026-09-01', source: 'dialysis_serology' }),
    ];
    const { result } = resolve([PATIENT_A], rows);
    expect((await result).get(PATIENT_A).status).toBe('unknown');
  });

  it('uses one query for a populated batch and returns every requested patient', async () => {
    const population = [PATIENT_A, PATIENT_B];
    expect(population).toHaveLength(2);
    const { db, result } = resolve(population, [row(PATIENT_A), row(PATIENT_B)]);
    const decisions = await result;
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(decisions.size).toBe(2);
    expect([...decisions.keys()]).toEqual(population);
  });

  it('rejects an incompatible caller contract version before querying', async () => {
    const db = dbReturning([]);
    await expect(resolveDialysisIsolation({
      tenantId: TENANT,
      patientUids: [PATIENT_A],
      db,
      contractVersion: 1,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'RPD_ISOLATION_CONTRACT_VERSION_UNSUPPORTED',
    });
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
