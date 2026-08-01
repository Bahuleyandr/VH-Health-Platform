import {
  CLINICAL_CONTINUITY_PAPER_ACTIONS,
  parseClinicalContinuityPaperCommand,
} from '../../validators/clinicalContinuityPaperSchemas.js';

const IDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  encounter: '10000000-0000-4000-8000-000000000002',
  incident: '10000000-0000-4000-8000-000000000003',
  patient: '10000000-0000-4000-8000-000000000004',
  verifierOne: '10000000-0000-4000-8000-000000000005',
  verifierTwo: '10000000-0000-4000-8000-000000000006',
});

const COMMON = Object.freeze({
  expected_version: 1,
  occurred_at: new Date(Date.now() - 60_000).toISOString(),
  original_actor_uid: IDS.actor,
  original_actor_role: 'NURSING_STAFF',
  patient_uid: IDS.patient,
  encounter_id: IDS.encounter,
  evidence_hash: 'a'.repeat(64),
});

function parse(actionId, body) {
  return parseClinicalContinuityPaperCommand({
    actionId,
    body,
    incidentId: IDS.incident,
    paperItemId: ' ward-01/0007 ',
  });
}

function expectCode(operation, code) {
  let failure;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code });
}

describe('C5.2 closed paper command map', () => {
  test('publishes exactly the three approved retrospective actions with stable schemas', () => {
    expect(Object.keys(CLINICAL_CONTINUITY_PAPER_ACTIONS).sort()).toEqual([
      'blood.transfusion_verification.backfill',
      'lab.specimen_collection.backfill',
      'mar.administration.backfill',
    ]);
    for (const definition of Object.values(CLINICAL_CONTINUITY_PAPER_ACTIONS)) {
      expect(definition).toMatchObject({ version: 1 });
      expect(definition.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('normalizes the Ward medication fact and permits an explicitly null encounter', () => {
    const parsed = parse('mar.administration.backfill', {
      ...COMMON,
      encounter_id: null,
      medication_administration_id: 42,
      notes: 'Entered from signed MAR sheet',
    });
    expect(parsed.identity).toEqual({
      incidentId: IDS.incident,
      paperItemId: 'WARD-01/0007',
    });
    expect(parsed.normalized).toMatchObject({
      encounter_id: null,
      medication_administration_id: 42,
      notes: 'Entered from signed MAR sheet',
    });
  });

  test('normalizes the Laboratory specimen-collection fact', () => {
    const parsed = parse('lab.specimen_collection.backfill', {
      ...COMMON,
      investigation_id: 43,
      specimen_barcode: 'LAB-43',
      collection_notes: null,
    });
    expect(parsed.normalized).toMatchObject({
      investigation_id: 43,
      specimen_barcode: 'LAB-43',
      collection_notes: null,
    });
  });

  test('requires two distinct Blood Bank verifiers and exact boolean evidence', () => {
    const body = {
      ...COMMON,
      blood_request_id: 44,
      blood_unit_id: 45,
      first_verifier_uid: IDS.verifierOne,
      second_verifier_uid: IDS.verifierTwo,
      scanned_unit_number: 'UNIT-45',
      unit_match: true,
      patient_match: true,
      group_compatible: true,
      expiry_ok: true,
      override_reason: null,
    };
    expect(parse('blood.transfusion_verification.backfill', body).normalized).toMatchObject({
      first_verifier_uid: IDS.verifierOne,
      second_verifier_uid: IDS.verifierTwo,
      unit_match: true,
    });
    expectCode(
      () => parse('blood.transfusion_verification.backfill', {
        ...body,
        second_verifier_uid: IDS.verifierOne,
      }),
      'CONTINUITY_TRANSFUSION_VERIFIER_SEPARATION_REQUIRED',
    );
    expect(() => parse('blood.transfusion_verification.backfill', {
      ...body,
      unit_match: 'true',
    })).toThrow('unit_match must be boolean');
  });

  test('rejects generic replay, transfer payloads, extra authority, and future occurrences', () => {
    expectCode(
      () => parse('patient.transfer', { ...COMMON }),
      'CONTINUITY_PAPER_ACTION_DENIED',
    );
    expect(() => parse('mar.administration.backfill', {
      ...COMMON,
      medication_administration_id: 42,
      tenant_id: 'client-controlled',
    })).toThrow('unsupported fields');
    expect(() => parse('mar.administration.backfill', {
      ...COMMON,
      medication_administration_id: 42,
      occurred_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    })).toThrow('cannot be in the future');
  });
});
