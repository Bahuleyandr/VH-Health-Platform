import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';

const PATIENT_UID = 'd7777777-7777-4777-8777-777777777a01';
const OUTGOING_NURSE_UID = 'd7777777-7777-4777-8777-777777777b01';
const INCOMING_NURSE_UID = 'd7777777-7777-4777-8777-777777777b02';

describe('Clinical handover history — deep integration', () => {
  const nurse = authClient('NURSING_STAFF');

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM nurse_handovers WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `INSERT INTO nurse_handovers
         (patient_uid, ward, bed_number, outgoing_nurse, incoming_nurse,
          shift, patient_summary, active_issues, pending_tasks,
          medications_due, special_instructions, acknowledged, created_at, updated_at)
       VALUES ($1::uuid, 'Surgical Ward', 'SP-002', $2::uuid, $3::uuid,
          'evening', 'Post-op monitoring handover', '["pain score"]'::jsonb,
          '["check drain output"]'::jsonb, '[]'::jsonb,
          'Escalate fever or tachycardia', false, NOW(), NOW())`,
      PATIENT_UID, OUTGOING_NURSE_UID, INCOMING_NURSE_UID,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM nurse_handovers WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('returns patient handover history for a valid patient UID', async () => {
    const res = await nurse.get(`/api/v1/clinical/handover/patient/${PATIENT_UID}?limit=10`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        patient_uid: PATIENT_UID,
        ward: 'Surgical Ward',
        bed_number: 'SP-002',
        outgoing_nurse: OUTGOING_NURSE_UID,
        incoming_nurse: INCOMING_NURSE_UID,
      }),
    ]));
  });

  it('returns a controlled 400 for malformed patient UID input', async () => {
    const res = await nurse.get('/api/v1/clinical/handover/patient/not-a-uuid?limit=10');

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors[0].msg).toBe('patientUid must be a valid UUID');
  });
});
