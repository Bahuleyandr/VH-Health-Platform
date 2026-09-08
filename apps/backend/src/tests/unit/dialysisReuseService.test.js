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
  reasons: result === 'reactive' ? [`DIALYSIS_${marker.toUpperCase()}_POSITIVE`] : [],
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
    expect(serviceFiles).toHaveLength(70);
    expect(serviceFiles).toContain('cathMigrationApprovalService.js');
    const exportedFunctions = serviceFiles.flatMap((name) => {
      const source = fs.readFileSync(path.join(root, name), 'utf8');
      return [...source.matchAll(
        /export async function\s+(\w+)[\s\S]*?(?=\nexport (?:async )?function|\nexport const|$)/g,
      )].map((match) => ({ name: match[1], source: match[0] }));
    });
    expect(exportedFunctions).toHaveLength(472);
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

  test('isolationDecisionFingerprintChangesForLegacyRestrictionChanges', () => {
    const reasons = ['DIALYSIS_HBSAG_POSITIVE', 'DIALYSIS_HCV_POSITIVE', 'DIALYSIS_HIV_POSITIVE'];
    expect(reasons).toHaveLength(3);
    const base = {
      contract_version: 2, status: 'restricted', evidence: 'legacy_declaration',
      evidence_dated_on: null, markers: [], reasons: [],
    };
    const fingerprints = reasons.map((reason) => isolationDecisionFingerprint({
      ...base, reasons: [reason],
    }));
    expect(new Set(fingerprints).size).toBe(3);
    expect(isolationDecisionFingerprint({ ...base, reasons }))
      .toBe(isolationDecisionFingerprint({ ...base, reasons: [...reasons].reverse() }));
    expect(JSON.stringify(fingerprints)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/i);
  });
});

describe('cohort compatibility verdict-only boundary', () => {
  test('cohortCompatibilityRejectsIncompleteMarkerProfilesWithoutDerivingLegacyProfiles', async () => {
    const markers = ['hbsag', 'hcv', 'hiv'];
    const incompleteShapes = ['legacy_only', 'mixed_legacy_and_marker', 'wrong_reason'];
    expect(markers).toHaveLength(3);
    expect(incompleteShapes).toHaveLength(3);
    const cases = markers.flatMap((marker, index) => incompleteShapes.map((shape) => ({
      marker, otherMarker: markers[(index + 1) % markers.length], shape,
    })));
    expect(cases).toHaveLength(9);
    const request = {
      tenantId: TENANT, patientUid: PATIENT_A, cohortPatientUids: [PATIENT_B],
      machine: { id: 7, active: true }, db,
    };
    const results = [];
    for (const entry of cases) {
      const complete = profileDecision(entry.marker);
      resolveDialysisIsolation.mockResolvedValue(new Map([
        [PATIENT_A, complete], [PATIENT_B, complete],
      ]));
      await expect(cohortCompatibilityTx(request)).resolves.toEqual({ verdict: 'compatible' });
      const incomplete = {
        ...complete,
        evidence: entry.shape === 'legacy_only' ? 'legacy_declaration' : 'marker',
        reasons: entry.shape === 'mixed_legacy_and_marker'
          ? [...complete.reasons, `DIALYSIS_${entry.otherMarker.toUpperCase()}_POSITIVE`]
          : [`DIALYSIS_${(entry.shape === 'wrong_reason' ? entry.otherMarker : entry.marker).toUpperCase()}_POSITIVE`],
        markers: entry.shape === 'legacy_only'
          ? complete.markers.map((marker) => ({ ...marker, result: 'non_reactive' }))
          : complete.markers,
      };
      resolveDialysisIsolation.mockResolvedValue(new Map([
        [PATIENT_A, incomplete], [PATIENT_B, incomplete],
      ]));
      results.push(await cohortCompatibilityTx(request));
    }
    expect(results).toEqual(cases.map(() => ({ verdict: 'not_established' })));
    expect(JSON.stringify(results)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);
  });

  test('cohortCompatibilityDoesNotEstablishPendingOrIndeterminate', async () => {
    const markers = ['hbsag', 'hcv', 'hiv'];
    const unresolvedResults = ['pending', 'indeterminate'];
    expect(markers).toHaveLength(3);
    expect(unresolvedResults).toHaveLength(2);
    const clearDecision = {
      contract_version: 2,
      status: 'clear',
      asOf: '2026-09-07T10:00:00.000Z',
      reasons: [],
      evidence: 'marker',
      evidence_dated_on: '2026-09-07',
      markers: markers.map((marker, index) => ({
        marker,
        result: 'non_reactive',
        tested_on: '2026-09-07',
        marker_row_id: index + 1,
        source: 'lab_result',
      })),
    };
    const request = {
      tenantId: TENANT,
      patientUid: PATIENT_A,
      cohortPatientUids: [PATIENT_B],
      machine: { id: 7, active: true },
      db,
    };
    resolveDialysisIsolation.mockResolvedValue(new Map([
      [PATIENT_A, clearDecision], [PATIENT_B, clearDecision],
    ]));
    await expect(cohortCompatibilityTx(request)).resolves.toEqual({ verdict: 'compatible' });

    const orders = ['single', 'unresolved_first', 'unresolved_last'];
    expect(orders).toHaveLength(3);
    const cases = markers.flatMap((marker) => unresolvedResults.flatMap((result) => (
      orders.map((order) => ({ marker, result, order }))
    )));
    expect(cases).toHaveLength(18);
    const results = [];
    for (const unresolved of cases) {
      const unknownDecision = {
        ...clearDecision,
        status: 'unknown',
        markers: clearDecision.markers.map((entry) => (
          entry.marker === unresolved.marker ? { ...entry, result: unresolved.result } : entry
        )),
      };
      const negative = clearDecision.markers.find((entry) => entry.marker === unresolved.marker);
      if (unresolved.order === 'unresolved_first') unknownDecision.markers.push(negative);
      if (unresolved.order === 'unresolved_last') unknownDecision.markers.unshift(negative);
      resolveDialysisIsolation.mockResolvedValue(new Map([
        [PATIENT_A, unknownDecision], [PATIENT_B, clearDecision],
      ]));
      results.push(await cohortCompatibilityTx(request));
    }
    expect(results).toEqual(cases.map(() => ({ verdict: 'not_established' })));
  });

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

  test('cohortCompatibilityPreservesHistoricalReactiveEvidence', async () => {
    const markers = ['hbsag', 'hcv', 'hiv'];
    expect(markers).toHaveLength(3);
    const clearDecision = {
      contract_version: 2,
      status: 'clear',
      asOf: '2026-09-07T10:00:00.000Z',
      reasons: [],
      evidence: 'marker',
      evidence_dated_on: '2026-09-07',
      markers: markers.map((marker, index) => ({
        marker, result: 'non_reactive', tested_on: '2026-09-07',
        marker_row_id: index + 1, source: 'lab_result',
      })),
    };
    const orders = ['ascending', 'descending'];
    expect(orders).toHaveLength(2);
    const cases = markers.flatMap((marker) => orders.map((order) => ({ marker, order })));
    expect(cases).toHaveLength(6);
    const results = [];
    for (const entry of cases) {
      const historicalMarker = {
        marker: entry.marker, result: 'reactive', tested_on: '2026-09-01',
        marker_row_id: 10, source: 'lab_result',
      };
      const restricted = {
        ...clearDecision,
        status: 'restricted',
        reasons: [`DIALYSIS_${entry.marker.toUpperCase()}_POSITIVE`],
        markers: entry.order === 'ascending'
          ? [historicalMarker, ...clearDecision.markers]
          : [...clearDecision.markers, historicalMarker],
      };
      const request = {
        tenantId: TENANT, patientUid: PATIENT_A, cohortPatientUids: [PATIENT_B],
        machine: { id: 7, active: true }, db,
      };
      resolveDialysisIsolation.mockResolvedValue(new Map([
        [PATIENT_A, restricted], [PATIENT_B, restricted],
      ]));
      await expect(cohortCompatibilityTx(request)).resolves.toEqual({ verdict: 'compatible' });
      resolveDialysisIsolation.mockResolvedValue(new Map([
        [PATIENT_A, restricted], [PATIENT_B, clearDecision],
      ]));
      results.push(await cohortCompatibilityTx(request));
    }
    expect(results).toEqual(cases.map(() => ({ verdict: 'incompatible' })));
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
