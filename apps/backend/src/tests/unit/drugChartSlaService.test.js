import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const {
  DRUG_CHART_FIRST_ENTERED_AUDIT_ACTION,
  DRUG_CHART_MISSING_ALERT_TYPE,
  DRUG_CHART_MISSING_AUDIT_ACTION,
  recordFirstDrugChartEntry,
  runMissingDrugChartSweep,
} = await import('../../services/clinical/drugChartSlaService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '10000000-0000-4000-8000-000000000001';
const ENCOUNTER_ID = '20000000-0000-4000-8000-000000000001';
const DOCTOR_UID = '30000000-0000-4000-8000-000000000001';
const NURSE_UID = '40000000-0000-4000-8000-000000000001';

function admission(overrides = {}) {
  return {
    admission_id: 77,
    tenant_id: TENANT,
    patient_uid: PATIENT_UID,
    encounter_id: ENCOUNTER_ID,
    admitting_doctor: DOCTOR_UID,
    attending_doctor: null,
    admitted_at: '2026-05-29T03:30:00.000Z',
    ward_arrived_at: '2026-05-29T03:30:00.000Z',
    bed_id: 12,
    bed_number: 'ICU-002',
    ward_id: 5,
    ward_name: 'ICU',
    patient_name: 'Demo Patient',
    minutes_since_ward_arrival: 75,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runMissingDrugChartSweep', () => {
  it('alerts the admitting doctor and current ward nurse once a chart is missing after 1 hour', async () => {
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (sql.includes('WITH active_bedded_admissions')) {
        return [admission()];
      }
      if (sql.includes('uid = ANY($1::uuid[])')) {
        return [{
          id: 10,
          uid: DOCTOR_UID,
          name: 'Duty Doctor',
          phone: '9000000010',
          role: 'DOCTOR',
          recipient_kind: 'admitting_doctor',
          source: 'admission_doctor',
        }];
      }
      if (sql.includes("b.department = 'nursing'")) {
        return [{
          id: 20,
          uid: NURSE_UID,
          name: 'ICU Nurse',
          phone: '9000000020',
          role: 'ICU_NURSE',
          recipient_kind: 'ward_nurse',
          source: 'published_nursing_roster',
        }];
      }
      if (sql.includes('INSERT INTO notifications')) {
        expect(params[3]).toBe(DRUG_CHART_MISSING_ALERT_TYPE);
        expect(params[4]).toContain('"admission_id":77');
        return [{ id: 501, user_id: 10 }, { id: 502, user_id: 20 }];
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        expect(params[1]).toBe(DRUG_CHART_MISSING_AUDIT_ACTION);
        expect(params[2]).toContain('"metric_key":"drug_chart_missing_after_ward_arrival"');
        return [{ id: 601 }];
      }
      throw new Error(`Unhandled SQL: ${sql.slice(0, 100)}`);
    });

    const result = await runMissingDrugChartSweep({
      now: new Date('2026-05-29T04:45:00.000Z'),
      graceMinutes: 60,
    });

    expect(result.checked).toBe(1);
    expect(result.alerts).toEqual([expect.objectContaining({
      admission_id: 77,
      recipient_count: 2,
      notification_count: 2,
      audit_id: 601,
    })]);
  });
});

describe('recordFirstDrugChartEntry', () => {
  it('audits time-to-first drug chart entry for performance metrics', async () => {
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (sql.includes('FROM admissions a') && sql.includes('ORDER BY')) {
        return [admission()];
      }
      if (sql.includes('SELECT COUNT(*)::int AS order_count')) {
        return [{ order_count: 1 }];
      }
      if (sql.includes('FROM audit_logs') && sql.includes('LIMIT 1')) {
        return [{ id: 601 }];
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        expect(params[2]).toBe(DRUG_CHART_FIRST_ENTERED_AUDIT_ACTION);
        expect(params[3]).toContain('"metric_key":"drug_chart_time_to_first_entry"');
        expect(params[3]).toContain('"delay_minutes":90');
        expect(params[3]).toContain('"after_missing_alert":true');
        return [{ id: 602 }];
      }
      throw new Error(`Unhandled SQL: ${sql.slice(0, 100)}`);
    });

    const audit = await recordFirstDrugChartEntry({
      id: 88,
      order_number: 'ORD-20260529-0001',
      order_type: 'medication',
      patient_uid: PATIENT_UID,
      encounter_id: ENCOUNTER_ID,
      ordered_by: DOCTOR_UID,
      created_at: '2026-05-29T05:00:00.000Z',
    });

    expect(audit).toEqual({ id: 602 });
  });
});
