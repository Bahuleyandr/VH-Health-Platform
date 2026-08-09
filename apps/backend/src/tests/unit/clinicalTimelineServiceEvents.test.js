import { jest } from '@jest/globals';

const emptyFindMany = () => ({ findMany: jest.fn().mockResolvedValue([]) });
const prismaMock = {
  admissions: emptyFindMany(),
  clinical_notes: emptyFindMany(),
  diagnoses: emptyFindMany(),
  news2_scores: emptyFindMany(),
  vitals_chart: emptyFindMany(),
  medication_administrations: emptyFindMany(),
  e_prescriptions: emptyFindMany(),
  investigations: emptyFindMany(),
  clinical_orders: emptyFindMany(),
  nurse_handovers: emptyFindMany(),
  referrals: emptyFindMany(),
  users: { findUnique: jest.fn(), findFirst: jest.fn() },
  downtime_snapshots: { create: jest.fn() },
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
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

const { getPatientTimeline, createDowntimeSnapshot } = await import(
  '../../services/emr/clinicalTimelineService.js'
);

const PATIENT_UID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  jest.clearAllMocks();
  for (const model of Object.values(prismaMock)) {
    model.findMany?.mockResolvedValue([]);
  }
});

describe('clinical timeline event ledger', () => {
  it('promotes OP note appointment_id and includes referrals as timeline events', async () => {
    prismaMock.clinical_notes.findMany.mockResolvedValueOnce([
      {
        id: 7,
        encounter_id: null,
        appointment_id: 55,
        note_type: 'op_consultation',
        title: 'OP consultation',
        content: {
          chief_complaint: 'Chest pain',
          diagnosis: 'CAD under evaluation',
          plan: 'ECG and cardiology follow-up',
        },
        author_uid: '11111111-1111-4111-8111-111111111111',
        author_role: 'DOCTOR',
        is_addendum: false,
        is_signed: true,
        signed_at: new Date('2026-06-07T09:15:00Z'),
        created_at: new Date('2026-06-07T09:00:00Z'),
      },
    ]);
    prismaMock.referrals.findMany.mockResolvedValueOnce([
      {
        id: 9,
        referral_number: 'REF-202606-0001',
        patient_uid: PATIENT_UID,
        encounter_id: null,
        referring_doctor: '11111111-1111-4111-8111-111111111111',
        referred_to_doctor: '22222222-2222-4222-8222-222222222222',
        referred_to_department: 'Cardiology',
        referral_type: 'internal',
        reason: 'Persistent exertional chest pain',
        urgency: 'urgent',
        clinical_summary: 'CAD under evaluation',
        status: 'pending',
        accepted_by: null,
        accepted_at: null,
        completed_at: null,
        response_notes: null,
        first_seen_at: null,
        first_seen_by: null,
        request_context: { appointment_id: 55, requested_from: 'op_workspace' },
        source: 'op',
        created_at: new Date('2026-06-07T09:20:00Z'),
        updated_at: new Date('2026-06-07T09:20:00Z'),
      },
    ]);

    const timeline = await getPatientTimeline(PATIENT_UID, { sort: 'asc' });

    const note = timeline.find((event) => event.event_type === 'clinical_note');
    expect(note).toMatchObject({
      id: 7,
      appointment_id: 55,
      sub_type: 'op_consultation',
    });

    const referral = timeline.find((event) => event.event_type === 'referral');
    expect(referral).toMatchObject({
      id: 9,
      appointment_id: 55,
      sub_type: 'pending',
    });
    expect(referral.summary).toContain('Referral to Cardiology');
    expect(referral.summary).toContain('Persistent exertional chest pain');
  });
});

describe('downtime snapshot tenant stamping', () => {
  const TENANT = '77777777-7777-4777-8777-777777777777';

  it('passes the patient tenant_id into the downtime_snapshots create', async () => {
    prismaMock.users.findUnique
      // getPatient projection (no tenant_id — shared with response payloads)
      .mockResolvedValueOnce({ uid: PATIENT_UID, name: 'Test Patient' });
    prismaMock.users.findFirst.mockResolvedValueOnce({ tenant_id: TENANT });
    prismaMock.downtime_snapshots.create.mockResolvedValueOnce({
      id: 1,
      patient_uid: PATIENT_UID,
      scope: 'patient_chart',
    });

    await createDowntimeSnapshot(PATIENT_UID, null, { tenantId: TENANT });

    expect(prismaMock.users.findFirst).toHaveBeenCalledWith({
      where: { uid: PATIENT_UID, tenant_id: TENANT },
      select: { tenant_id: true },
    });
    expect(prismaMock.downtime_snapshots.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.downtime_snapshots.create.mock.calls[0][0].data.tenant_id).toBe(TENANT);
  });

  it('leaves tenant_id undefined so the DB default applies when the patient row has none', async () => {
    prismaMock.users.findUnique.mockResolvedValueOnce({ uid: PATIENT_UID, name: 'Test Patient' });
    prismaMock.users.findFirst.mockResolvedValueOnce({ tenant_id: null });
    prismaMock.downtime_snapshots.create.mockResolvedValueOnce({ id: 2 });

    await createDowntimeSnapshot(PATIENT_UID, null);

    expect(prismaMock.downtime_snapshots.create.mock.calls[0][0].data.tenant_id).toBeUndefined();
  });

  it('rejects a patient outside the requested tenant before loading PHI', async () => {
    prismaMock.users.findFirst.mockResolvedValueOnce(null);

    await expect(createDowntimeSnapshot(PATIENT_UID, null, { tenantId: TENANT }))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(prismaMock.users.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.downtime_snapshots.create).not.toHaveBeenCalled();
  });
});
