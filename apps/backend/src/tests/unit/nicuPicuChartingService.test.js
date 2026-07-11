import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const setTenantTxMock = jest.fn();
const timelineMock = jest.fn();
const auditMock = jest.fn();
const computePercentileMock = jest.fn();
const icuChartViewMock = jest.fn();

const txMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  setTenantTx: setTenantTxMock
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: tenantId => tenantId || '00000000-0000-4000-8000-000000000001'
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordTimelineEvent: timelineMock,
  recordClinicalAuditEvent: auditMock
}));

jest.unstable_mockModule('../../services/clinical/icuChartingService.js', () => ({
  getIcuChartView: icuChartViewMock
}));

jest.unstable_mockModule('../../services/clinical/growthPercentileService.js', () => ({
  computePercentile: computePercentileMock,
  normaliseSex: gender =>
    gender && gender.toLowerCase().startsWith('m')
      ? 'M'
      : gender && gender.toLowerCase().startsWith('f')
        ? 'F'
        : null,
  ageInDaysFrom: () => 21
}));

const {
  computeFeedFluidBalance,
  getGrowthSnapshot,
  linkNewbornToAdmission,
  recordCardiorespiratoryEvent,
  recordFeedFluidEntry,
  recordScoreOutput
} = await import('../../services/clinical/nicuPicuChartingService.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const REVIEWER = '44444444-4444-4444-8444-444444444444';

function admission(overrides = {}) {
  return {
    id: 21,
    tenant_id: TENANT,
    patient_uid: PATIENT,
    admission_id: 61,
    unit_code: 'NICU',
    bed_no: 'N1',
    admitted_at: new Date('2026-07-09T08:00:00.000Z'),
    discharged_at: null,
    status: 'active',
    monitoring_interval_minutes: 15,
    ...overrides
  };
}

const SETTINGS_ENABLED = [{ enabled: true }];

describe('nicuPicuChartingService', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    setTenantTxMock.mockReset();
    timelineMock.mockReset();
    auditMock.mockReset();
    computePercentileMock.mockReset();
    icuChartViewMock.mockReset();
    setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(txMock));
    timelineMock.mockResolvedValue({ id: 1 });
    auditMock.mockResolvedValue({ id: 2 });
  });

  describe('computeFeedFluidBalance', () => {
    it('computes weight-adjusted intake/output balance from typed entries', () => {
      const entries = [
        {
          entry_kind: 'weight',
          weight_grams: 1500,
          recorded_at: '2026-07-09T06:00:00.000Z'
        },
        {
          entry_kind: 'feed',
          feed_type: 'expressed_breast_milk',
          volume_ml: 30,
          recorded_at: '2026-07-09T08:00:00.000Z'
        },
        {
          entry_kind: 'feed',
          feed_type: 'tpn',
          volume_ml: 45,
          recorded_at: '2026-07-09T10:00:00.000Z'
        },
        {
          entry_kind: 'fluid_output',
          output_kind: 'urine',
          output_volume_ml: 20,
          recorded_at: '2026-07-09T11:00:00.000Z'
        },
        {
          entry_kind: 'glucose',
          glucose_mgdl: 82,
          recorded_at: '2026-07-09T11:30:00.000Z'
        }
      ];

      const balance = computeFeedFluidBalance(entries, { windowHours: 24 });

      expect(balance.weight_grams).toBe(1500);
      expect(balance.intake.total_ml).toBe(75);
      expect(balance.intake.enteral_ml).toBe(30);
      expect(balance.intake.parenteral_ml).toBe(45);
      expect(balance.output.total_ml).toBe(20);
      expect(balance.output.by_kind.urine).toBe(20);
      expect(balance.net_ml).toBe(55);
      expect(balance.per_kg.intake_ml_per_kg).toBe(50);
      expect(balance.per_kg.output_ml_per_kg).toBeCloseTo(13.33, 2);
      expect(balance.per_kg.net_ml_per_kg).toBeCloseTo(36.67, 2);
      expect(balance.latest_glucose.glucose_mgdl).toBe(82);
    });

    it('omits per-kg values when no weight entry anchors the window', () => {
      const balance = computeFeedFluidBalance([
        { entry_kind: 'feed', feed_type: 'formula', volume_ml: 10, recorded_at: '2026-07-09T08:00:00.000Z' }
      ]);
      expect(balance.weight_grams).toBeNull();
      expect(balance.per_kg).toBeNull();
      expect(balance.intake.total_ml).toBe(10);
    });
  });

  describe('recordFeedFluidEntry', () => {
    it('writes the detail row plus canonical timeline/audit pair in one transaction', async () => {
      queryRawMock
        .mockResolvedValueOnce(SETTINGS_ENABLED)
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([
          {
            id: 301,
            tenant_id: TENANT,
            icu_admission_id: 21,
            patient_uid: PATIENT,
            entry_kind: 'feed',
            feed_type: 'expressed_breast_milk',
            volume_ml: 30,
            verification_status: 'not_applicable',
            recorded_at: new Date('2026-07-09T08:00:00.000Z')
          }
        ]);

      const row = await recordFeedFluidEntry({
        tenantId: TENANT,
        icuAdmissionId: 21,
        actorUid: ACTOR,
        actorRole: 'nurse',
        entry_kind: 'feed',
        feed_type: 'expressed_breast_milk',
        feed_route: 'og_tube',
        volume_ml: 30
      });

      expect(row.id).toBe(301);
      expect(queryRawMock.mock.calls[2][0]).toMatch(/INSERT INTO nicu_feed_fluid_entries/);
      expect(timelineMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'nicu.feed_fluid_recorded',
          patientUid: PATIENT,
          tenantId: TENANT,
          tags: ['icu', 'nicu', 'nl14']
        }),
        { db: txMock }
      );
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'nicu.feed_fluid.recorded',
          resourceTable: 'nicu_feed_fluid_entries'
        }),
        { db: txMock }
      );
    });

    it('fails closed when the per-tenant NICU/PICU flag is not enabled', async () => {
      queryRawMock.mockResolvedValueOnce([]);

      await expect(
        recordFeedFluidEntry({
          tenantId: TENANT,
          icuAdmissionId: 21,
          actorUid: ACTOR,
          entry_kind: 'feed',
          feed_type: 'formula',
          volume_ml: 20
        })
      ).rejects.toMatchObject({ statusCode: 403, code: 'NICU_PICU_CHART_DISABLED' });
      expect(queryRawMock.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
        /INSERT INTO nicu_feed_fluid_entries/
      );
      expect(timelineMock).not.toHaveBeenCalled();
    });

    it('rejects admissions that are not PICU/NICU units', async () => {
      queryRawMock
        .mockResolvedValueOnce(SETTINGS_ENABLED)
        .mockResolvedValueOnce([admission({ unit_code: 'MICU' })]);

      await expect(
        recordFeedFluidEntry({
          tenantId: TENANT,
          icuAdmissionId: 21,
          actorUid: ACTOR,
          entry_kind: 'feed',
          feed_type: 'formula',
          volume_ml: 20
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'NICU_PICU_UNIT_REQUIRED' });
    });

    it('scopes the admission lookup to the caller tenant (tenant isolation)', async () => {
      queryRawMock.mockResolvedValueOnce(SETTINGS_ENABLED).mockResolvedValueOnce([]);

      await expect(
        recordFeedFluidEntry({
          tenantId: TENANT,
          icuAdmissionId: 999,
          actorUid: ACTOR,
          entry_kind: 'weight',
          weight_grams: 1400
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      const admissionCall = queryRawMock.mock.calls[1];
      expect(admissionCall[0]).toMatch(/FROM icu_admissions/);
      expect(admissionCall[0]).toMatch(/tenant_id = \$2::uuid/);
      expect(admissionCall.slice(1)).toEqual([999, TENANT]);
    });
  });

  describe('recordCardiorespiratoryEvent', () => {
    it('lands device-sourced events as unverified until clinician review', async () => {
      queryRawMock
        .mockResolvedValueOnce(SETTINGS_ENABLED)
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([
          {
            id: 401,
            tenant_id: TENANT,
            icu_admission_id: 21,
            patient_uid: PATIENT,
            event_kind: 'desaturation',
            verification_status: 'unverified',
            started_at: new Date('2026-07-09T09:30:00.000Z')
          }
        ]);

      const row = await recordCardiorespiratoryEvent({
        tenantId: TENANT,
        icuAdmissionId: 21,
        actorUid: ACTOR,
        event_kind: 'desaturation',
        lowest_spo2_pct: 78,
        source: 'device',
        sample_observation_id: 555
      });

      expect(row.verification_status).toBe('unverified');
      const insert = queryRawMock.mock.calls[2];
      expect(insert[0]).toMatch(/INSERT INTO nicu_cardiorespiratory_events/);
      expect(insert.slice(1)).toContain('unverified');
      expect(timelineMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'nicu.cardiorespiratory_event_recorded',
          payload: expect.objectContaining({ verification_status: 'unverified' })
        }),
        { db: txMock }
      );
    });

    it('marks manual events not_applicable for device verification', async () => {
      queryRawMock
        .mockResolvedValueOnce(SETTINGS_ENABLED)
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([
          {
            id: 402,
            event_kind: 'apnea',
            verification_status: 'not_applicable',
            started_at: new Date('2026-07-09T09:40:00.000Z')
          }
        ]);

      await recordCardiorespiratoryEvent({
        tenantId: TENANT,
        icuAdmissionId: 21,
        actorUid: ACTOR,
        event_kind: 'apnea',
        duration_seconds: 18
      });

      expect(queryRawMock.mock.calls[2].slice(1)).toContain('not_applicable');
    });
  });

  describe('recordScoreOutput (owner-governed, fail closed)', () => {
    it('rejects score values when no owner-approved definition exists', async () => {
      queryRawMock
        .mockResolvedValueOnce(SETTINGS_ENABLED)
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([]); // no active definition

      await expect(
        recordScoreOutput({
          tenantId: TENANT,
          icuAdmissionId: 21,
          actorUid: ACTOR,
          score_kind: 'crib_ii',
          score_value: 7,
          reviewer_uid: REVIEWER
        })
      ).rejects.toMatchObject({ statusCode: 409, code: 'NICU_SCORE_UNAVAILABLE' });
      expect(queryRawMock.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
        /INSERT INTO nicu_picu_scoring_outputs/
      );
    });

    it('stamps version/reference from the approved definition and requires a reviewer', async () => {
      queryRawMock
        .mockResolvedValueOnce(SETTINGS_ENABLED)
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([
          {
            id: 9n,
            score_kind: 'crib_ii',
            reference_source: 'CRIB-II owner-approved reference',
            reference_version: 'v2.1-owner'
          }
        ])
        .mockResolvedValueOnce([
          {
            id: 501,
            score_kind: 'crib_ii',
            score_definition_id: 9,
            reference_source: 'CRIB-II owner-approved reference',
            reference_version: 'v2.1-owner',
            reviewer_uid: REVIEWER,
            review_status: 'reviewed',
            score_available: true,
            order_mutation_performed: false,
            recorded_at: new Date('2026-07-09T10:00:00.000Z')
          }
        ]);

      const row = await recordScoreOutput({
        tenantId: TENANT,
        icuAdmissionId: 21,
        actorUid: ACTOR,
        score_kind: 'crib_ii',
        score_value: 7,
        reviewer_uid: REVIEWER,
        reviewer_role: 'neonatologist'
      });

      expect(row.reference_version).toBe('v2.1-owner');
      expect(row.order_mutation_performed).toBe(false);
      const insert = queryRawMock.mock.calls[3];
      expect(insert[0]).toMatch(/INSERT INTO nicu_picu_scoring_outputs/);
      expect(insert.slice(1)).toContain('CRIB-II owner-approved reference');
      expect(insert.slice(1)).toContain('v2.1-owner');
      expect(insert[0]).toMatch(/FALSE/);
    });

    it('requires reviewer_uid for available score outputs', async () => {
      queryRawMock
        .mockResolvedValueOnce(SETTINGS_ENABLED)
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([
          { id: 9, score_kind: 'pews', reference_source: 'ref', reference_version: 'v1' }
        ]);

      await expect(
        recordScoreOutput({
          tenantId: TENANT,
          icuAdmissionId: 21,
          actorUid: ACTOR,
          score_kind: 'pews',
          score_value: 3
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'NICU_SCORE_REVIEWER_REQUIRED' });
    });

    it('records an explicit score-unavailable row without any fallback math', async () => {
      queryRawMock
        .mockResolvedValueOnce(SETTINGS_ENABLED)
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([
          {
            id: 502,
            score_kind: 'snappe_ii',
            score_value: null,
            review_status: 'score_unavailable',
            score_available: false,
            unavailable_reason: 'No owner-approved SNAPPE-II reference published',
            order_mutation_performed: false,
            recorded_at: new Date('2026-07-09T10:10:00.000Z')
          }
        ]);

      const row = await recordScoreOutput({
        tenantId: TENANT,
        icuAdmissionId: 21,
        actorUid: ACTOR,
        score_kind: 'snappe_ii',
        score_available: false,
        unavailable_reason: 'No owner-approved SNAPPE-II reference published'
      });

      expect(row.score_available).toBe(false);
      expect(row.score_value).toBeNull();
      const sqls = queryRawMock.mock.calls.map(([sql]) => sql).join('\n');
      expect(sqls).not.toMatch(/FROM nicu_picu_score_definitions/);
      expect(queryRawMock.mock.calls[2][0]).toMatch(/INSERT INTO nicu_picu_scoring_outputs/);
    });
  });

  describe('linkNewbornToAdmission (maternity substrate reuse)', () => {
    it('links the NICU admission to its newborn record and emits canonical events', async () => {
      queryRawMock
        .mockResolvedValueOnce(SETTINGS_ENABLED)
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([
          {
            id: 71,
            delivery_id: 51,
            birth_order: 1,
            birth_datetime: new Date('2026-07-01T02:00:00.000Z'),
            newborn_patient_uid: PATIENT,
            outcome: 'live',
            resuscitation_done: true,
            resuscitation_type: 'bag_mask'
          }
        ])
        .mockResolvedValueOnce([]) // no existing active link
        .mockResolvedValueOnce([
          {
            id: 601,
            tenant_id: TENANT,
            icu_admission_id: 21,
            newborn_id: 71,
            patient_uid: PATIENT,
            linked_at: new Date('2026-07-09T12:00:00.000Z')
          }
        ]);

      const row = await linkNewbornToAdmission({
        tenantId: TENANT,
        icuAdmissionId: 21,
        newbornId: 71,
        actorUid: ACTOR,
        actorRole: 'doctor'
      });

      expect(row.newborn_id).toBe(71);
      expect(timelineMock).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'nicu.newborn_linked' }),
        { db: txMock }
      );
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'nicu.newborn.linked' }),
        { db: txMock }
      );
    });

    it('rejects newborn records that belong to a different patient', async () => {
      queryRawMock
        .mockResolvedValueOnce(SETTINGS_ENABLED)
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([
          { id: 71, newborn_patient_uid: '99999999-9999-4999-8999-999999999999' }
        ]);

      await expect(
        linkNewbornToAdmission({
          tenantId: TENANT,
          icuAdmissionId: 21,
          newbornId: 71,
          actorUid: ACTOR
        })
      ).rejects.toMatchObject({ statusCode: 409, code: 'NICU_NEWBORN_PATIENT_MISMATCH' });
      expect(queryRawMock.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
        /INSERT INTO nicu_admission_newborn_links/
      );
    });
  });

  describe('getGrowthSnapshot (NL-5 content pack consumption)', () => {
    it('passes labelled growth reference output through untouched', async () => {
      queryRawMock
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([
          { uid: PATIENT, birthday: new Date('2026-06-18T00:00:00.000Z'), gender: 'female' }
        ])
        .mockResolvedValueOnce([
          { weight_grams: 1650, recorded_at: new Date('2026-07-09T06:00:00.000Z') }
        ]);
      computePercentileMock.mockResolvedValue({
        z_score: -1.2,
        percentile: 11.51,
        classification: 'normal',
        source: 'WHO_0_5_approx',
        reference_dataset: 'WHO_0_5',
        note: 'Approximation - embedded monthly LMS subset. Replace with full WHO LMS for diagnostic-grade accuracy.'
      });

      const snapshot = await getGrowthSnapshot({ tenantId: TENANT, icuAdmissionId: 21 });

      expect(computePercentileMock).toHaveBeenCalledWith({
        sex: 'F',
        ageInDays: 21,
        metric: 'weight_kg',
        value: 1.65
      });
      expect(snapshot.available).toBe(true);
      expect(snapshot.source).toBe('WHO_0_5_approx');
      expect(snapshot.note).toMatch(/Approximation/);
    });

    it('reports growth unavailable instead of guessing when weight is missing', async () => {
      queryRawMock
        .mockResolvedValueOnce([admission()])
        .mockResolvedValueOnce([
          { uid: PATIENT, birthday: new Date('2026-06-18T00:00:00.000Z'), gender: 'female' }
        ])
        .mockResolvedValueOnce([]);

      const snapshot = await getGrowthSnapshot({ tenantId: TENANT, icuAdmissionId: 21 });

      expect(snapshot.available).toBe(false);
      expect(snapshot.reason).toBe('no_weight_entry');
      expect(computePercentileMock).not.toHaveBeenCalled();
    });
  });
});
