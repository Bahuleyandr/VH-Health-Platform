import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';

const resolveDialysisIsolationForPatient = jest.fn();
const resolveDialysisIsolation = jest.fn();

jest.unstable_mockModule('../../services/clinical/dialysisIsolationAdapter.js', () => ({
  resolveDialysisIsolationForPatient,
  resolveDialysisIsolation,
}));

const {
  cohortCompatibilityTx,
  isolationDecisionFingerprint,
  isolationDecisionTx,
  reuseEligibilityTx,
} = await import('../../services/clinical/dialysisReuseService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_A = '00000000-0000-4000-8000-00000000000a';
const PATIENT_B = '00000000-0000-4000-8000-00000000000b';
const db = { $queryRawUnsafe: jest.fn() };
const decision = (marker, result = 'reactive') => ({
  contract_version: 2,
  status: result === 'reactive' ? 'restricted' : 'clear',
  asOf: '2026-09-07T10:00:00.000Z',
  reasons: [],
  evidence: 'marker',
  evidence_dated_on: '2026-09-07',
  isolation_class: result === 'reactive' ? marker : null,
  markers: [{ marker, result, tested_on: '2026-09-07', marker_row_id: 1, source: 'lab_result' }],
});
const profileDecision = (reactiveMarker) => ({
  ...decision(reactiveMarker),
  markers: ['hbsag', 'hcv', 'hiv'].map((marker, index) => ({
    marker,
    result: marker === reactiveMarker ? 'reactive' : 'non_reactive',
    tested_on: '2026-09-07',
    marker_row_id: index + 1,
    source: 'lab_result',
  })),
});

beforeEach(() => jest.clearAllMocks());

describe('dialysisReuseService Phase 1 adapter binding', () => {
  test('isolationDecisionTx delegates to the existing adapter and never a second resolver', async () => {
    resolveDialysisIsolationForPatient.mockResolvedValue(decision('hcv'));
    await expect(isolationDecisionTx({ tenantId: TENANT, patientUid: PATIENT_A, db }))
      .resolves.toMatchObject({ status: 'restricted', isolation_class: 'hcv' });
    expect(resolveDialysisIsolationForPatient).toHaveBeenCalledWith({
      tenantId: TENANT,
      patientUid: PATIENT_A,
      db,
      includeMarkers: false,
      includeIsolationClass: false,
    });

    const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../services/clinical/dialysisReuseService.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).toContain("from './dialysisIsolationAdapter.js'");
    expect(source).not.toMatch(/dialysisIsolationResolver|CONTRACT_VERSION/);
  });

  test('pins detail requester populations by function name and keeps both flags default-off elsewhere', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../services/clinical');
    const serviceFiles = fs.readdirSync(root).filter((name) => name.endsWith('.js'));
    expect(serviceFiles).toHaveLength(64);
    expect(serviceFiles).toContain('cathMigrationApprovalService.js');
    const exportedFunctions = serviceFiles.flatMap((name) => {
      const source = fs.readFileSync(path.join(root, name), 'utf8');
      return [...source.matchAll(
        /export async function\s+(\w+)[\s\S]*?(?=\nexport (?:async )?function|\nexport const|$)/g,
      )].map((match) => ({ name: match[1], source: match[0] }));
    });
    expect(exportedFunctions).toHaveLength(433);
    expect(exportedFunctions.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'approveCathMigrationDispositions', 'verifyCathMigrationApprovalTx', 'verifyDocumentSignatureTx',
    ]));
    const markerCallers = exportedFunctions
      .filter((entry) => /includeMarkers:\s*true/.test(entry.source))
      .map((entry) => entry.name);
    const classCallers = exportedFunctions
      .filter((entry) => /includeIsolationClass:\s*true/.test(entry.source))
      .map((entry) => entry.name);
    expect(markerCallers.sort()).toEqual(['cohortCompatibilityTx', 'reuseEligibilityTx']);
    expect(classCallers.sort()).toEqual(['assessIsolationTx', 'reuseEligibilityTx']);
  });

  test('reuseEligibilityTx requests protected detail but returns a marker-free verdict', async () => {
    resolveDialysisIsolationForPatient.mockResolvedValue(decision('hcv'));
    const result = await reuseEligibilityTx({
      tenantId: TENANT,
      patientUid: PATIENT_A,
      db,
      protocol: {
        domain: 'dialysis', category: 'dialyser', status: 'active',
        reuse_matrix: { hbsag: 'no_reuse', hcv: 'no_reuse', hiv: 'no_reuse', isolation_mixed: 'no_reuse' },
        surveillance_intervals_days: { hbsag: 90, hcv: 90, hiv: 365 },
      },
      device: { domain: 'dialysis', category: 'dialyser', cycle_count: 0, max_cycles_snapshot: 3 },
      dedicatedPatientUid: PATIENT_A,
      activeHolds: [],
      asOf: '2026-09-07T12:00:00.000Z',
    });
    expect(resolveDialysisIsolationForPatient).toHaveBeenCalledWith(expect.objectContaining({
      includeMarkers: true,
      includeIsolationClass: true,
    }));
    expect(result).toEqual({ verdict: 'ineligible', reason_codes: ['RPD_REUSE_MATRIX_NO_REUSE'] });
    expect(JSON.stringify(result)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);
  });

  test('binds emergency evidence to a stable opaque fingerprint without exporting its profile', () => {
    const original = profileDecision('hbsag');
    const reordered = { ...original, markers: [...original.markers].reverse() };
    const changed = {
      ...original,
      markers: original.markers.map((marker) => (
        marker.marker === 'hbsag' ? { ...marker, marker_row_id: 99 } : marker
      )),
    };
    expect(isolationDecisionFingerprint(original)).toMatch(/^[0-9a-f]{64}$/);
    expect(isolationDecisionFingerprint(reordered)).toBe(isolationDecisionFingerprint(original));
    expect(isolationDecisionFingerprint(changed)).not.toBe(isolationDecisionFingerprint(original));
    expect(isolationDecisionFingerprint(original)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);
  });
});

describe('cohort compatibility verdict-only boundary', () => {
  test('cohortCompatibilityTx returns exactly a by-value verdict with no derived profile', async () => {
    resolveDialysisIsolation.mockResolvedValue(new Map([
      [PATIENT_A, profileDecision('hbsag')],
      [PATIENT_B, profileDecision('hbsag')],
    ]));
    const result = await cohortCompatibilityTx({
      tenantId: TENANT,
      patientUid: PATIENT_A,
      cohortPatientUids: [PATIENT_B],
      machine: { id: 7, active: true },
      db,
    });
    expect(result).toEqual({ verdict: 'compatible' });
    expect(Object.keys(result)).toEqual(['verdict']);
    expect(JSON.stringify(result)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);
    expect(resolveDialysisIsolation).toHaveBeenCalledWith(expect.objectContaining({
      includeMarkers: true,
      includeIsolationClass: false,
    }));
  });

  test('distinguishes mismatched profiles and refuses inactive selected machines', async () => {
    resolveDialysisIsolation.mockResolvedValue(new Map([
      [PATIENT_A, profileDecision('hbsag')],
      [PATIENT_B, profileDecision('hcv')],
    ]));
    await expect(cohortCompatibilityTx({
      tenantId: TENANT,
      patientUid: PATIENT_A,
      cohortPatientUids: [PATIENT_B],
      machine: { id: 7, active: false },
      db,
    })).rejects.toMatchObject({ code: 'DIALYSIS_MACHINE_INACTIVE' });

    await expect(cohortCompatibilityTx({
      tenantId: TENANT,
      patientUid: PATIENT_A,
      cohortPatientUids: [PATIENT_B],
      machine: { id: 7, active: true },
      db,
    })).resolves.toEqual({ verdict: 'incompatible' });
  });
});
