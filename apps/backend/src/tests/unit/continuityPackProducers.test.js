import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  captureContinuitySourceWatermark,
  ContinuityPackCoverageError,
  normalizeContinuityDbValue,
  produceFacilityContinuityPacks,
} from '../../services/downtime/continuityPackProducers.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const FACILITY_ID = 10;
const GENERATED_AT = new Date('2026-07-29T05:30:00.000Z');

function requiredCoverage(overrides = {}) {
  return {
    wards: [],
    paediatricWards: [],
    edBoards: [],
    opdClinicDays: [],
    ...overrides,
  };
}

function policyFor(coverage, overrides = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    policyVersion: '7',
    revocationEpoch: '2',
    policyDocument: {
      policyType: 'clinical_continuity_pack',
      policySchemaVersion: 1,
      packSchemaVersion: 1,
      audience: { tenantId: TENANT_ID, facilityId: String(FACILITY_ID) },
      generation: {
        intervalMinutes: 15,
        hardExpiryHours: 24,
        historicalMode: false,
      },
      fieldPolicy: {
        allergyUnknownText: 'Allergy status UNKNOWN — not recorded',
        codeStatusUnknownText: 'Code status NOT RECORDED — confirm per hospital policy',
        safetyFields: [
          'identity.name',
          'identity.mrnOrUid',
          'identity.dateOfBirth',
          'allergies',
          'codeStatus',
          'medicationsDue',
          'activeMedicationOrders',
          'recentlyAdministeredMedications',
          'unresolvedCriticalResults',
        ],
        contextFields: [
          'bedLocation',
          'attendingDoctor',
          'diagnosisOrChiefComplaint',
          'latestVitals',
          'news2',
          'recentReleasedResults',
          'careTeam',
        ],
        recentlyAdministeredLookbackHours: 12,
        safetyFieldRecordedAtRequired: true,
        bloodGroupIncluded: false,
        isolationSource: 'structured_only',
        paediatricWeightRequired: true,
        opdDestroyAfterClinicDay: true,
      },
      medicationsDueWindow: { lookbackHours: 1, lookaheadHours: 12 },
      recentReleasedResults: {
        lookbackHours: 72,
        maxPerPatient: 20,
        portalReleaseDelayHours: 24,
        itemCodeAllowlist: ['718-7', 'HR'],
      },
      requiredCoverage: coverage,
      includedAreas: {
        wards: coverage.wards.length > 0,
        paediatrics: coverage.paediatricWards.length > 0,
        ed: coverage.edBoards.length > 0,
        opd: coverage.opdClinicDays.length > 0,
      },
      ...overrides,
    },
  };
}

function defaultResponse(marker) {
  if (marker === 'watermark') {
    return [{
      captured_at: GENERATED_AT,
      txid_snapshot: '100:100:',
      transaction_id: 100n,
      transaction_isolation: 'repeatable read',
    }];
  }
  if (marker === 'facility') {
    return [{
      id: FACILITY_ID,
      tenant_id: TENANT_ID,
      facility_code: 'FAC-10',
      display_name: 'Test Hospital',
      timezone: 'Asia/Kolkata',
      status: 'active',
    }];
  }
  return [];
}

function fakeTx(responders = {}) {
  const calls = [];
  return {
    calls,
    async $queryRawUnsafe(sql, ...params) {
      const marker = /\/\* continuity:([a-z0-9-]+) \*\//i.exec(sql)?.[1] || 'unmarked';
      calls.push({ marker, sql, params });
      const responder = Object.hasOwn(responders, marker)
        ? responders[marker]
        : defaultResponse(marker);
      if (responder instanceof Error) throw responder;
      return typeof responder === 'function'
        ? responder({ marker, sql, params, calls })
        : responder;
    },
  };
}

function identityRow() {
  return {
    patient_id: 40,
    patient_uid: PATIENT_UID,
    name: 'Test Patient',
    birthday: new Date('2012-01-02T00:00:00.000Z'),
    phone: '+919999999999',
    is_unidentified: false,
    identity_source: 'local',
    updated_at: new Date('2026-07-29T05:00:00.000Z'),
    mrn: 'MRN-40',
    mrn_recorded_at: new Date('2026-07-01T00:00:00.000Z'),
  };
}

function patientSourceResponders(overrides = {}) {
  return {
    'patient-identities': [identityRow()],
    'patient-identity-render': [identityRow()],
    allergies: [],
    'code-status': [],
    isolation: [],
    vitals: [],
    weights: [],
    news2: [],
    mar: [],
    'active-medication-orders': [],
    'unresolved-critical-results': [],
    'recent-released-results': [],
    'care-team': [],
    'attending-names': [],
    ...overrides,
  };
}

describe('continuity-pack source watermark', () => {
  it('captures database time and a pinned RepeatableRead snapshot', async () => {
    const tx = fakeTx();
    await expect(captureContinuitySourceWatermark(tx)).resolves.toEqual({
      captured_at: '2026-07-29T05:30:00.000Z',
      txid_snapshot: '100:100:',
      transaction_id: '100',
      transaction_isolation: 'repeatable read',
    });
  });

  it('fails closed under Read Committed', async () => {
    const tx = fakeTx({
      watermark: [{
        captured_at: GENERATED_AT,
        txid_snapshot: '100:100:',
        transaction_id: '100',
        transaction_isolation: 'read committed',
      }],
    });
    await expect(captureContinuitySourceWatermark(tx)).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_COVERAGE_FAILED',
    });
  });
});

describe('continuity-pack required coverage', () => {
  it('rejects the default tenant before making a clinical read', async () => {
    const tx = fakeTx();
    await expect(produceFacilityContinuityPacks({
      tx,
      tenantId: '00000000-0000-4000-8000-000000000001',
      facilityId: FACILITY_ID,
      policy: policyFor(requiredCoverage()),
    })).rejects.toBeInstanceOf(ContinuityPackCoverageError);
    expect(tx.calls).toHaveLength(0);
  });

  it('emits a required empty ward instead of treating empty census as missing coverage', async () => {
    const coverage = requiredCoverage({
      wards: [{ wardId: 8, locationIdentifier: 'ward-8', label: 'Ward 8' }],
    });
    const tx = fakeTx({
      'ward-definition': [{
        id: 8,
        name: 'Ward 8',
        floor: 1,
        facility_id: FACILITY_ID,
        updated_at: GENERATED_AT,
        department_name: 'Medicine',
      }],
      'ward-census': [],
    });
    const result = await produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(coverage),
    });

    expect(result.expected_coverage).toEqual(['ward:ward-8']);
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({
      tenant_id: TENANT_ID,
      location: {
        type: 'ward',
        identifier: 'ward-8',
        ward_id: '8',
      },
      patients: [],
      generated_at: '2026-07-29T05:30:00.000Z',
      fresh_until: '2026-07-29T05:45:00.000Z',
      expires_at: '2026-07-30T05:30:00.000Z',
      historical_mode: false,
    });
  });

  it('fails when a policy-required ward is not mapped to the facility', async () => {
    const coverage = requiredCoverage({
      wards: [{ wardId: 999, locationIdentifier: 'ward-999' }],
    });
    const tx = fakeTx({ 'ward-definition': [] });
    await expect(produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(coverage),
    })).rejects.toThrow('policy-required ward is missing');
  });

  it('fails the whole producer when any required clinical source errors', async () => {
    const coverage = requiredCoverage({
      wards: [{ wardId: 8, locationIdentifier: 'ward-8' }],
    });
    const tx = fakeTx({
      'ward-definition': [{
        id: 8,
        name: 'Ward 8',
        facility_id: FACILITY_ID,
        updated_at: GENERATED_AT,
      }],
      'ward-census': [{
        bed_id: 90,
        bed_number: '8-A',
        patient_id: 40,
        patient_uid: PATIENT_UID,
        patient_name: 'Test Patient',
        admission_id: 50,
        resolved_admission_id: 50,
        admission_status: 'admitted',
        bed_updated_at: GENERATED_AT,
        admission_updated_at: GENERATED_AT,
      }],
      ...patientSourceResponders({
        allergies: new Error('allergy store unavailable'),
      }),
    });
    await expect(produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(coverage),
    })).rejects.toThrow('allergy store unavailable');
  });

  it('rejects unsupported non-empty coverage instead of silently omitting it', async () => {
    const coverage = requiredCoverage();
    const policy = policyFor(coverage);
    policy.policyDocument.requiredCoverage.theatre = [{ locationIdentifier: 'or-1' }];
    const tx = fakeTx();
    await expect(produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy,
    })).rejects.toThrow('Unsupported required coverage area: theatre');
    expect(tx.calls).toHaveLength(0);
  });
});

describe('ward and paediatric patient fields', () => {
  function occupiedWardCoverage(paediatric = false) {
    return requiredCoverage(paediatric
      ? { paediatricWards: [{ wardId: 8, locationIdentifier: 'picu-8' }] }
      : { wards: [{ wardId: 8, locationIdentifier: 'ward-8' }] });
  }

  function occupiedWardResponders(extra = {}) {
    return {
      'ward-definition': [{
        id: 8,
        name: 'Ward 8',
        facility_id: FACILITY_ID,
        updated_at: GENERATED_AT,
      }],
      'ward-census': [{
        bed_id: 90,
        bed_number: '8-A',
        patient_id: 40,
        patient_uid: PATIENT_UID,
        patient_name: 'Test Patient',
        admission_id: 50,
        resolved_admission_id: 50,
        admission_status: 'admitted',
        chief_complaint: 'Fever',
        attending_doctor: null,
        bed_updated_at: GENERATED_AT,
        admission_updated_at: GENERATED_AT,
      }],
      ...patientSourceResponders(),
      ...extra,
    };
  }

  it('keeps missing allergy and default-only code status explicitly unknown', async () => {
    const tx = fakeTx(occupiedWardResponders());
    const result = await produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(occupiedWardCoverage()),
    });
    const patient = result.packs[0].patients[0];

    expect(patient.allergies).toMatchObject({
      state: 'unknown',
      value: null,
      recorded_at: null,
    });
    expect(patient.code_status).toMatchObject({
      state: 'unknown',
      value: null,
      recorded_at: null,
    });
    expect(patient.identity.value.dob.value).toBe('2012-01-02T00:00:00.000Z');
    expect(patient.identity.value.mrn.value).toBe('MRN-40');
    expect(patient.medications_due).toMatchObject({
      state: 'known',
      value: [],
      recorded_at: '2026-07-29T05:30:00.000Z',
      timestamp_basis: 'snapshot_watermark',
    });
  });

  it.each([
    [
      'allergy',
      {
        allergies: [{
          patient_uid: PATIENT_UID,
          allergen: 'Penicillin',
          severity: 'severe',
          reaction: 'rash',
          source: 'patient_allergies',
          recorded_at: null,
        }],
      },
      'allergy_sources',
    ],
    [
      'due MAR',
      {
        mar: [{
          patient_uid: PATIENT_UID,
          medication_name: 'Due medicine',
          scheduled_time: new Date('2026-07-29T06:00:00.000Z'),
          status: 'scheduled',
          updated_at: null,
        }],
      },
      'medication_administrations',
    ],
  ])('fails closed when a non-empty %s field has no source timestamp', async (
    _label,
    sourceRows,
    expectedSource,
  ) => {
    const tx = fakeTx(occupiedWardResponders(sourceRows));
    let thrown;
    try {
      await produceFacilityContinuityPacks({
        tx,
        tenantId: TENANT_ID,
        facilityId: FACILITY_ID,
        policy: policyFor(occupiedWardCoverage()),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContinuityPackCoverageError);
    expect(thrown).toMatchObject({
      code: 'CONTINUITY_PACK_COVERAGE_FAILED',
      details: {
        affected_item_count: 1,
        reason: 'missing_source_recorded_at',
        source: expectedSource,
      },
    });
    expect(JSON.stringify(thrown.details)).not.toContain(PATIENT_UID);
  });

  it('adds paediatric weight and its source recorded date without inferring profile from a ward name', async () => {
    const weightAt = new Date('2026-07-29T04:40:00.000Z');
    const tx = fakeTx(occupiedWardResponders({
      vitals: [{
        patient_uid: PATIENT_UID,
        systolic_bp: 90,
        diastolic_bp: 60,
        heart_rate: 110,
        respiratory_rate: 24,
        spo2: 98,
        temperature: 37.2,
        recorded_at: weightAt,
      }],
      weights: [{
        patient_uid: PATIENT_UID,
        weight_kg: '18.40',
        recorded_at: weightAt,
      }],
    }));
    const result = await produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(occupiedWardCoverage(true)),
    });
    const pack = result.packs[0];

    expect(pack.location).toMatchObject({
      type: 'paeds',
      area_profile: 'paeds',
      identifier: 'picu-8',
    });
    expect(pack.patients[0].latest_weight).toEqual({
      state: 'known',
      value: { weight_kg: '18.40', unit: 'kg' },
      recorded_at: '2026-07-29T04:40:00.000Z',
      source: 'vitals_chart',
      timestamp_basis: 'source_recorded_at',
    });
  });

  it('binds the exact signed MAR and result-policy values to source queries', async () => {
    const tx = fakeTx(occupiedWardResponders());
    await produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(occupiedWardCoverage()),
    });

    const mar = tx.calls.find((call) => call.marker === 'mar');
    expect(mar.params.slice(-3)).toEqual([1, 12, 12]);
    const critical = tx.calls.find((call) => call.marker === 'unresolved-critical-results');
    expect(critical.params).toHaveLength(4);
    expect(critical.sql).not.toContain('ANY($5::text[])');
    expect(critical.sql).not.toContain('task.description');
    expect(critical.sql).not.toContain('alert.message');
    const released = tx.calls.find((call) => call.marker === 'recent-released-results');
    expect(released.params.slice(-4)).toEqual([72, 24, ['718-7', 'HR'], 20]);
  });

  it('includes unresolved critical lab alerts outside the released-results allowlist', async () => {
    const tx = fakeTx(occupiedWardResponders({
      'unresolved-critical-results': [{
        patient_uid: PATIENT_UID,
        source_kind: 'lab_critical_alert',
        source_id: '91',
        item_name: 'Critical potassium',
        item_code: '6298-4',
        value_snapshot: {
          test_name: 'Potassium',
          result_value: '7.2',
          unit: 'mmol/L',
          severity: 'critical',
        },
        recorded_at: new Date('2026-07-29T04:05:00.000Z'),
      }],
    }));
    const result = await produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(occupiedWardCoverage()),
    });

    expect(result.packs[0].patients[0].unresolved_critical_results.value).toEqual([
      expect.objectContaining({
        source_kind: 'lab_critical_alert',
        item_code: '6298-4',
        item_name: 'Critical potassium',
      }),
    ]);
  });

  it('removes nested blood-group clinical items while preserving other critical results', async () => {
    const tx = fakeTx(occupiedWardResponders({
      'unresolved-critical-results': [
        {
          patient_uid: PATIENT_UID,
          source_kind: 'lab_critical_alert',
          source_id: 'safe-critical',
          item_name: 'Critical potassium',
          item_code: '6298-4',
          value_snapshot: {
            nested: {
              interpretation: 'Critical value 7.2 mmol/L',
              note: 'A positive clinical response remains visible',
            },
          },
          recorded_at: new Date('2026-07-29T04:05:00.000Z'),
        },
        {
          patient_uid: PATIENT_UID,
          source_kind: 'lab_critical_alert',
          source_id: 'blood-critical',
          item_name: 'Critical laboratory result',
          item_code: 'local-transfusion',
          value_snapshot: { nested: { note: 'Pre-op blood type is O negative' } },
          recorded_at: new Date('2026-07-29T04:06:00.000Z'),
        },
      ],
      'recent-released-results': [
        {
          patient_uid: PATIENT_UID,
          generation_id: '44444444-4444-4444-8444-444444444444',
          source_kind: 'lab_panel',
          item_code: '718-7',
          item_name: 'Haemoglobin',
          value_snapshot: { value: 12.1 },
          recorded_at: new Date('2026-07-29T04:07:00.000Z'),
        },
        {
          patient_uid: PATIENT_UID,
          generation_id: '55555555-5555-4555-8555-555555555555',
          source_kind: 'lab_panel',
          item_code: 'local-transfusion',
          item_name: 'Pre-transfusion test',
          value_snapshot: { observations: [{ rh_factor: 'positive' }] },
          recorded_at: new Date('2026-07-29T04:08:00.000Z'),
        },
      ],
    }));
    const result = await produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(occupiedWardCoverage()),
    });
    const patient = result.packs[0].patients[0];

    expect(patient.unresolved_critical_results.value).toEqual([
      expect.objectContaining({
        source_id: 'safe-critical',
        item_code: '6298-4',
        nested: expect.objectContaining({
          note: 'A positive clinical response remains visible',
        }),
      }),
    ]);
    expect(patient.recent_released_results.value).toEqual([
      expect.objectContaining({ item_code: '718-7', item_name: 'Haemoglobin' }),
    ]);
    expect(JSON.stringify(patient)).not.toMatch(/blood type|rh_factor|O negative/i);
  });

  it('fails closed when a clinical result snapshot cannot be screened', async () => {
    const tx = fakeTx(occupiedWardResponders({
      'unresolved-critical-results': [{
        patient_uid: PATIENT_UID,
        source_kind: 'lab_critical_alert',
        source_id: 'binary-critical',
        item_name: 'Critical laboratory result',
        item_code: 'local-result',
        value_snapshot: Buffer.from('not-evaluable'),
        recorded_at: new Date('2026-07-29T04:05:00.000Z'),
      }],
    }));

    await expect(produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(occupiedWardCoverage()),
    })).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_COVERAGE_FAILED',
      details: {
        affected_item_count: 1,
        reason: 'binary_blood_group_screening_value',
      },
    });
  });

  it.each([
    [
      'clinical identity lookup',
      { 'patient-identities': [] },
      'patient_identity_not_found',
    ],
    [
      'ambiguous active admission',
      {
        'active-admission-ambiguity': [{
          patient_uid: PATIENT_UID,
          active_admission_count: 2,
        }],
      },
      'multiple_active_admissions',
    ],
    [
      'identity rendering',
      { 'patient-identity-render': [] },
      'patient_identity_render_not_found',
    ],
  ])('does not expose a patient UUID in %s coverage errors', async (
    _label,
    responderOverrides,
    reason,
  ) => {
    const tx = fakeTx(occupiedWardResponders(responderOverrides));
    let thrown;
    try {
      await produceFacilityContinuityPacks({
        tx,
        tenantId: TENANT_ID,
        facilityId: FACILITY_ID,
        policy: policyFor(occupiedWardCoverage()),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContinuityPackCoverageError);
    expect(thrown.details).toMatchObject({
      affected_patient_count: 1,
      reason,
    });
    expect(JSON.stringify({
      message: thrown.message,
      details: thrown.details,
    })).not.toContain(PATIENT_UID);
  });

  it('timestamps non-empty list fields from their latest actual source row', async () => {
    const tx = fakeTx(occupiedWardResponders({
      mar: [
        {
          patient_uid: PATIENT_UID,
          medication_name: 'Due medicine',
          scheduled_time: new Date('2026-07-29T06:00:00.000Z'),
          status: 'scheduled',
          updated_at: new Date('2026-07-29T04:01:00.000Z'),
        },
        {
          patient_uid: PATIENT_UID,
          medication_name: 'Given medicine',
          administered_at: new Date('2026-07-29T04:02:00.000Z'),
          status: 'administered',
          updated_at: new Date('2026-07-29T04:03:00.000Z'),
        },
      ],
      'active-medication-orders': [{
        patient_uid: PATIENT_UID,
        order_number: 'MED-1',
        medication_name: 'Active medicine',
        status: 'active',
        recorded_at: new Date('2026-07-29T04:04:00.000Z'),
      }],
      'unresolved-critical-results': [{
        patient_uid: PATIENT_UID,
        source_kind: 'clinical_alert',
        source_id: '5',
        item_name: 'Critical heart rate',
        value_snapshot: { result_value: 190 },
        recorded_at: new Date('2026-07-29T04:05:00.000Z'),
      }],
      'recent-released-results': [{
        patient_uid: PATIENT_UID,
        generation_id: '44444444-4444-4444-8444-444444444444',
        source_kind: 'lab_panel',
        item_code: '718-7',
        item_name: 'Haemoglobin',
        value_snapshot: { value: 12.1 },
        recorded_at: new Date('2026-07-29T04:06:00.000Z'),
      }],
      'care-team': [{
        patient_uid: PATIENT_UID,
        staff_uid: '55555555-5555-4555-8555-555555555555',
        member_name: 'Dr Team',
        role: 'DOCTOR',
        relationship: 'attending',
        recorded_at: new Date('2026-07-29T04:07:00.000Z'),
      }],
    }));
    const result = await produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(occupiedWardCoverage()),
    });
    const patient = result.packs[0].patients[0];

    expect(patient.medications_due.recorded_at).toBe('2026-07-29T04:01:00.000Z');
    expect(patient.recently_administered_medications.recorded_at)
      .toBe('2026-07-29T04:02:00.000Z');
    expect(patient.active_medication_orders.recorded_at).toBe('2026-07-29T04:04:00.000Z');
    expect(patient.unresolved_critical_results.recorded_at).toBe('2026-07-29T04:05:00.000Z');
    expect(patient.recent_released_results.recorded_at).toBe('2026-07-29T04:06:00.000Z');
    expect(patient.care_team.recorded_at).toBe('2026-07-29T04:07:00.000Z');
    for (const field of [
      patient.medications_due,
      patient.recently_administered_medications,
      patient.active_medication_orders,
      patient.unresolved_critical_results,
      patient.recent_released_results,
      patient.care_team,
    ]) {
      expect(field.timestamp_basis).toBe('source_recorded_at');
      expect(field.recorded_at).not.toBe('2026-07-29T05:30:00.000Z');
    }
  });
});

describe('ED and OPD area floors', () => {
  it('renders ED arrival, triage and TID from the source watermark for an unidentified visit', async () => {
    const coverage = requiredCoverage({
      edBoards: [{ locationIdentifier: 'ed-main', label: 'ED main board' }],
    });
    const tx = fakeTx({
      'ed-unmapped-preflight': [],
      'ed-board': [{
        id: 101,
        visit_number: 'ED-101',
        patient_uid: null,
        arrival_at: new Date('2026-07-29T04:00:00.000Z'),
        chief_complaint: 'Breathing difficulty',
        attending_doctor_uid: null,
        triage_priority: 'esi_2',
        status: 'in_triage',
        metadata: {},
        updated_at: new Date('2026-07-29T04:15:00.000Z'),
        triage_level: 'ESI-2',
        assessment_kind: 'esi',
        assessed_at: new Date('2026-07-29T04:10:00.000Z'),
      }],
    });
    const result = await produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(coverage),
    });
    const patient = result.packs[0].patients[0];

    expect(result.packs[0].location.type).toBe('ed_board');
    expect(patient.identity.value.name.value).toContain('TEMPORARY / UNIDENTIFIED');
    expect(patient.arrival_at.value).toBe('2026-07-29T04:00:00.000Z');
    expect(patient.triage.value).toMatchObject({ display: 'ESI-2' });
    expect(patient.time_in_department.value.minutes).toBe(90);
    expect(patient.time_in_department.recorded_at).toBe('2026-07-29T05:30:00.000Z');
    expect(patient.isolation.state).toBe('unknown');
    expect(patient.medications_due.state).toBe('unknown');
    expect(patient.active_medication_orders.state).toBe('unknown');
    expect(patient.recently_administered_medications.state).toBe('unknown');
    expect(patient.unresolved_critical_results.state).toBe('unknown');
  });

  it('fails ED coverage when an open visit has no facility mapping', async () => {
    const coverage = requiredCoverage({
      edBoards: [{ locationIdentifier: 'ed-main' }],
    });
    const tx = fakeTx({
      'ed-unmapped-preflight': [{ id: 500, visit_number: 'ED-500' }],
    });
    await expect(produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(coverage),
    })).rejects.toThrow('Open ED visits without facility mapping block coverage');
  });

  it('includes every OPD status, phone, and destroy-after-clinic-day handling', async () => {
    const coverage = requiredCoverage({
      opdClinicDays: [{
        locationIdentifier: 'opd-day-main',
        label: 'Main OPD',
        queueIds: [71],
      }],
    });
    const tx = fakeTx({
      'opd-unmapped-preflight': [],
      'opd-queues': [{
        id: 71,
        queue_label: 'Medicine',
        department_name: 'Medicine',
        doctor_uid: null,
        updated_at: GENERATED_AT,
      }],
      'opd-appointments': [{
        id: 501,
        patient_id: null,
        patient_uid: null,
        patient_name: 'Walk-in Patient',
        phone: '+919876543210',
        doctor_id: null,
        doctor_uid: null,
        doctor_name: 'Dr Outpatient',
        reason: 'Review',
        appointment_date: new Date('2026-07-29T00:00:00.000Z'),
        appointment_time: '10:30',
        appointment_at: new Date('2026-07-29T05:00:00.000Z'),
        status: 'COMPLETED',
        queue_id: 71,
        updated_at: GENERATED_AT,
      }],
    });
    const result = await produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(coverage),
    });
    const pack = result.packs[0];

    expect(pack.location.type).toBe('opd_day');
    expect(pack.handling.printed_sheet).toBe('DESTROY AFTER CLINIC DAY');
    expect(pack.patients[0].appointment_status.value).toBe('COMPLETED');
    expect(pack.patients[0].phone.value).toBe('+919876543210');
    expect(pack.patients[0].allergies.state).toBe('unknown');
    expect(pack.patients[0].active_medication_orders.state).toBe('unknown');
    const appointmentSql = tx.calls.find((call) => call.marker === 'opd-appointments').sql;
    expect(appointmentSql).not.toMatch(/status\s+IN/i);
  });

  it('fails OPD coverage when today has an appointment without a mapped queue', async () => {
    const coverage = requiredCoverage({
      opdClinicDays: [{ locationIdentifier: 'opd-day-main', queueIds: [] }],
    });
    const tx = fakeTx({
      'opd-unmapped-preflight': [{ id: 888 }],
    });
    await expect(produceFacilityContinuityPacks({
      tx,
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      policy: policyFor(coverage),
    })).rejects.toThrow('OPD appointments without facility mapping block coverage');
  });
});

describe('serialization and deliberate exclusion', () => {
  it('normalizes bigint, Decimal-like and Date values for canonical JSON', () => {
    const decimal = Object.create({ toString: () => '18.40' });
    expect(normalizeContinuityDbValue({
      id: 9007199254740993n,
      weight: decimal,
      at: new Date('2026-07-29T05:30:00.000Z'),
    })).toEqual({
      id: '9007199254740993',
      weight: '18.40',
      at: '2026-07-29T05:30:00.000Z',
    });
  });

  it('never selects the users blood_group column', () => {
    const servicePath = fileURLToPath(new URL(
      '../../services/downtime/continuityPackProducers.js',
      import.meta.url,
    ));
    const source = fs.readFileSync(servicePath, 'utf8');
    expect(source).not.toMatch(/\bblood_group\b/);
  });
});
