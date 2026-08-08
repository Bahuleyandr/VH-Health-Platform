import {
  auditEventsToCsv,
  buildAuditEventsQuery,
  decodeAuditCursor,
  encodeAuditCursor,
  normalizeAuditFilters,
} from '../../services/compliance/auditAccountabilityService.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '57400000-0000-4000-8000-000000000001';
const PATIENT_UID = '57400000-0000-4000-8000-000000000002';

describe('auditAccountabilityService', () => {
  it('normalizes per-staff, per-patient, role, date, resource, and outcome aliases', () => {
    const filters = normalizeAuditFilters({
      staff_uid: ACTOR_UID,
      staff_id: '42',
      role: 'doctor',
      patient_uid: PATIENT_UID,
      patient_id: '91',
      department_id: 'CARDIOLOGY',
      encounter_id: 'enc-91',
      admission_id: 'adm-91',
      date_from: '2026-07-01T00:00:00Z',
      date_to: '2026-07-02T00:00:00Z',
      resource: 'investigation',
      resource_id: 'INV-9',
      status: 'SUCCESS',
      limit: '50',
    });

    expect(filters).toMatchObject({
      actor_uid: ACTOR_UID,
      actor_user_id: 42,
      actor_role: 'DOCTOR',
      patient_uid: PATIENT_UID,
      patient_id: '91',
      department_id: 'CARDIOLOGY',
      encounter_id: 'enc-91',
      admission_id: 'adm-91',
      resource_type: 'investigation',
      resource_id: 'INV-9',
      outcome: 'success',
      limit: 50,
    });
  });

  it('builds a tenant-anchored keyset query without offset pagination', () => {
    const cursor = encodeAuditCursor({
      occurred_at: '2026-07-02T12:34:56.000Z',
      source: 'clinical',
      id: 'abc-123',
    });
    const filters = normalizeAuditFilters({
      actor_uid: ACTOR_UID,
      patient_uid: PATIENT_UID,
      role: 'DOCTOR',
      cursor,
    });
    const { sql, params } = buildAuditEventsQuery(TENANT_ID, filters);

    expect(sql).toContain('v.tenant_id = $1::uuid');
    expect(sql).toContain('v.actor_uid = $2::uuid');
    expect(sql).toContain('v.patient_uid IN (SELECT $4::uuid AS uid');
    expect(sql).toContain('patient.name AS patient_name');
    expect(sql).toContain('ROW(v.occurred_at, v.source, v.id) < ROW(');
    expect(sql).not.toMatch(/\bOFFSET\b/i);
    expect(params).toContain(ACTOR_UID);
    expect(params).toContain(PATIENT_UID);
    expect(decodeAuditCursor(cursor)).toEqual({
      at: '2026-07-02T12:34:56.000Z',
      source: 'clinical',
      id: 'abc-123',
    });
  });

  it('expands doctor and staff views into role families', () => {
    const doctorQuery = buildAuditEventsQuery(
      TENANT_ID,
      normalizeAuditFilters({ actor_role: 'DOCTOR_GROUP' }),
    );
    const staffQuery = buildAuditEventsQuery(
      TENANT_ID,
      normalizeAuditFilters({ actor_role: 'STAFF_GROUP' }),
    );

    expect(doctorQuery.sql).toContain("'CONSULTANT'");
    expect(doctorQuery.sql).toContain("'DUTY_DOCTOR'");
    expect(staffQuery.sql).toContain("NOT IN ('', 'PATIENT')");
  });

  it('rejects malformed cursors and oversized export windows', () => {
    expect(() => normalizeAuditFilters({ cursor: 'not-a-cursor' })).toThrow('Invalid audit cursor');
    expect(() => normalizeAuditFilters({ limit: '20rows' })).toThrow('Invalid limit');
    expect(() => normalizeAuditFilters({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-01T00:00:00Z',
    }, { exportMode: true })).toThrow('31-day window');
  });

  it('produces spreadsheet-safe CSV and exports no raw state columns', () => {
    const csv = auditEventsToCsv([{
      occurred_at: new Date('2026-07-02T12:34:56Z'),
      source: 'clinical',
      category: 'clinical',
      action: '=CMD()',
      outcome: 'success',
      actor_name: 'Dr Example',
      summary: 'note.created',
      before_state: 'must-not-export',
      after_state: 'must-not-export',
    }]);

    expect(csv).toContain('"\'=CMD()"');
    expect(csv).not.toContain('must-not-export');
    expect(csv).not.toContain('before_state');
    expect(csv).not.toContain('after_state');
  });
});
