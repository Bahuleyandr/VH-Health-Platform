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
  DRUG_CHART_SLA_RULE_CODE,
  recordFirstDrugChartEntry,
  runMissingDrugChartSweep,
} = await import('../../services/clinical/drugChartSlaService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '10000000-0000-4000-8000-000000000001';
const ENCOUNTER_ID = '20000000-0000-4000-8000-000000000001';
const DOCTOR_UID = '30000000-0000-4000-8000-000000000001';
const NURSE_UID = '40000000-0000-4000-8000-000000000001';
const RULE_ID = '50000000-0000-4000-8000-000000000001';
const SLA_ID = '60000000-0000-4000-8000-000000000001';

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

const slaRule = () => ({
  id: RULE_ID,
  rule_code: DRUG_CHART_SLA_RULE_CODE,
  target_minutes: 60,
  owner_role_codes: ['DOCTOR'],
});

beforeEach(() => {
  jest.clearAllMocks();
});

// Shared recipient-resolution branches for the sweep mocks.
function recipientBranches(sql) {
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
  return null;
}

describe('runMissingDrugChartSweep', () => {
  it('alerts recipients AND starts the canonical SLA clock in the same pass (C-M6)', async () => {
    let slaInsertParams = null;
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (sql.includes('WITH active_bedded_admissions')) {
        // Dedupe moved off audit_logs onto the canonical open clock.
        expect(sql).toContain('workflow_sla_instances');
        expect(sql).toContain('completed_at IS NULL');
        expect(sql).not.toContain('FROM audit_logs al');
        expect(params[4]).toBe(DRUG_CHART_SLA_RULE_CODE);
        return [admission()];
      }
      const recipients = recipientBranches(sql);
      if (recipients) return recipients;
      if (sql.includes('FROM workflow_sla_rules')) {
        expect(params[0]).toBe(DRUG_CHART_SLA_RULE_CODE);
        expect(params[1]).toBe(TENANT);
        return [slaRule()];
      }
      if (sql.includes('INSERT INTO workflow_sla_instances')) {
        slaInsertParams = params;
        return [{ id: SLA_ID, status: 'active', completed_at: null }];
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
      sla_instance_id: SLA_ID,
    })]);

    // The instance is keyed to the admission with the admission's explicit
    // tenant (never the GUC default — the sweep runs under super-admin cron).
    expect(slaInsertParams[0]).toBe(TENANT);
    expect(slaInsertParams[2]).toBe(DRUG_CHART_SLA_RULE_CODE);
    expect(slaInsertParams[5]).toBe('admissions');
    expect(slaInsertParams[6]).toBe('77');
  });

  it('re-arms a completed clock when the chart has emptied again (domain-owned reopen)', async () => {
    let rearmSql = null;
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (sql.includes('WITH active_bedded_admissions')) return [admission()];
      const recipients = recipientBranches(sql);
      if (recipients) return recipients;
      // NOTE: checked before the workflow_sla_rules branch — the re-arm UPDATE
      // embeds a `FROM workflow_sla_rules` subquery for the due_at recompute.
      if (sql.includes('UPDATE workflow_sla_instances i')) {
        rearmSql = sql;
        expect(params[0]).toBe(SLA_ID);
        expect(params[1]).toBe(TENANT);
        return [{ id: SLA_ID, status: 'active', completed_at: null }];
      }
      if (sql.includes('FROM workflow_sla_rules')) return [slaRule()];
      if (sql.includes('INSERT INTO workflow_sla_instances')) {
        // ON CONFLICT preserved the closed clock from the previous episode.
        return [{ id: SLA_ID, status: 'completed', completed_at: '2026-05-29T04:00:00.000Z' }];
      }
      if (sql.includes('INSERT INTO notifications')) return [{ id: 501, user_id: 10 }];
      if (sql.includes('INSERT INTO audit_logs')) return [{ id: 601 }];
      throw new Error(`Unhandled SQL: ${sql.slice(0, 100)}`);
    });

    const result = await runMissingDrugChartSweep({ now: new Date(), graceMinutes: 60 });

    expect(result.alerts).toEqual([expect.objectContaining({ sla_instance_id: SLA_ID })]);
    expect(rearmSql).toContain("status = 'active'");
    expect(rearmSql).toContain('completed_at = NULL');
    expect(rearmSql).toContain('prior_completed_at');
  });
});

describe('recordFirstDrugChartEntry', () => {
  it('completes the open SLA clock and audits time-to-first drug chart entry', async () => {
    let completeParams = null;
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (sql.includes('FROM admissions a') && sql.includes('ORDER BY')) {
        return [admission()];
      }
      if (sql.includes('FROM workflow_sla_instances') && sql.includes('completed_at IS NULL')) {
        return [{ id: SLA_ID }]; // open clock — the missing alert fired
      }
      if (sql.includes('UPDATE workflow_sla_instances')) {
        completeParams = params;
        return [{ id: SLA_ID, status: 'breached' }];
      }
      if (sql.includes('SELECT COUNT(*)::int AS order_count')) {
        return [{ order_count: 1 }];
      }
      if (sql.includes('FROM workflow_sla_instances')) {
        return [{ id: SLA_ID }]; // after_missing_alert lookup (any instance)
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
    // completeWorkflowSla keyed to the admission with its explicit tenant.
    expect(completeParams[0]).toBe(TENANT);
    expect(completeParams[1]).toBe(DRUG_CHART_SLA_RULE_CODE);
    expect(completeParams[2]).toBe('admissions');
    expect(completeParams[3]).toBe('77');
  });

  it('does not touch a clock that is not open (terminal state stays owned by the re-arm path)', async () => {
    const updates = [];
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (sql.includes('FROM admissions a') && sql.includes('ORDER BY')) {
        return [admission()];
      }
      if (sql.includes('FROM workflow_sla_instances') && sql.includes('completed_at IS NULL')) {
        return []; // no open clock (never alerted, or already completed)
      }
      if (sql.includes('UPDATE workflow_sla_instances')) {
        updates.push(params);
        return [];
      }
      if (sql.includes('SELECT COUNT(*)::int AS order_count')) {
        return [{ order_count: 1 }];
      }
      if (sql.includes('FROM workflow_sla_instances')) {
        return []; // never alerted
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        expect(params[3]).toContain('"after_missing_alert":false');
        return [{ id: 603 }];
      }
      throw new Error(`Unhandled SQL: ${sql.slice(0, 100)}`);
    });

    const audit = await recordFirstDrugChartEntry({
      id: 89,
      order_type: 'medication',
      patient_uid: PATIENT_UID,
      created_at: '2026-05-29T05:00:00.000Z',
    });

    expect(audit).toEqual({ id: 603 });
    expect(updates).toHaveLength(0); // completeWorkflowSla never issued
  });
});
