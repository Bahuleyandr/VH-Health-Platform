// Regression test for finding 2026-05-22-dynamic-acute-abdomen-radiologist-31d32cc1.
//
// `POST /api/v1/radiology/:id/sign-off` correctly persisted
// `report_signed_off_at` + `report_signed_off_by`, but the subsequent
// `GET /api/v1/radiology/:id` and `GET /api/v1/radiology/worklist`
// responses omitted both fields — the treating doctor couldn't tell
// a signed final report from an unsigned completed draft. The signoff
// lock still blocked overwrites, but the read surface was silent
// about the signature state.
//
// Fix: add `report_signed_off_at` + `report_signed_off_by` to
// `RAD_RETURNING` (the canonical projection used by detail + create
// + cancel + report-submit) AND to the separate `getWorklist` SELECT.

import prisma from '../lib/prisma.js';
import radiologyService from '../services/radiology/radiologyService.js';

const PATIENT_UID = 'cf000000-0000-4000-8000-aaaaaaa00001';
const ORDERER_UID = 'cf000000-0000-4000-8000-aaaaaaa00002';
const RADIOLOGIST_UID = 'cf000000-0000-4000-8000-aaaaaaa00003';

let orderId;

describe('radiology read surfaces sign-off metadata (31d32cc1)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM radiology_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, ORDERER_UID, RADIOLOGIST_UID).catch(() => {});

    for (const [uid, phone, name, role] of [
      [PATIENT_UID, '9000990001', 'Signoff Patient', 'PATIENT'],
      [ORDERER_UID, '9000990002', 'Dr. Ordering', 'DOCTOR'],
      [RADIOLOGIST_UID, '9000990003', 'Dr. Reading', 'DOCTOR'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, $4, true, NOW())`,
        uid, phone, name, role);
    }

    const o = await prisma.$queryRawUnsafe(
      `INSERT INTO radiology_orders
         (patient_uid, modality, body_part, clinical_indication,
          priority, status, ordered_by, report,
          report_completed_at, created_at, updated_at)
       VALUES ($1::uuid, 'ct', 'Abdomen', 'STAT acute abdomen',
               'stat', 'completed', $2::uuid,
               'Normal abdomen, no free fluid.',
               NOW(), NOW(), NOW())
       RETURNING id`, PATIENT_UID, ORDERER_UID);
    orderId = o[0].id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM radiology_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, ORDERER_UID, RADIOLOGIST_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('getOrderDetail returns sign-off metadata fields (null when unsigned)', async () => {
    const detail = await radiologyService.getOrderDetail(orderId);
    expect(detail).toBeTruthy();
    expect('report_signed_off_at' in detail).toBe(true);
    expect('report_signed_off_by' in detail).toBe(true);
    expect(detail.report_signed_off_at).toBeNull();
    expect(detail.report_signed_off_by).toBeNull();
  });

  it('getWorklist rows include sign-off metadata fields', async () => {
    const wl = await radiologyService.getWorklist({ modality: 'ct' });
    expect(Array.isArray(wl.orders)).toBe(true);
    const ourRow = wl.orders.find(r => r.id === orderId);
    expect(ourRow).toBeTruthy();
    expect('report_signed_off_at' in ourRow).toBe(true);
    expect('report_signed_off_by' in ourRow).toBe(true);
  });

  it('after signOffReport, getOrderDetail surfaces the populated metadata (the repro fix)', async () => {
    await radiologyService.signOffReport(orderId, { signed_off_by: RADIOLOGIST_UID });

    const detail = await radiologyService.getOrderDetail(orderId);
    expect(detail.report_signed_off_at).toBeTruthy(); // not null after signoff
    expect(detail.report_signed_off_by).toBe(RADIOLOGIST_UID);

    const wl = await radiologyService.getWorklist({ modality: 'ct' });
    const ourRow = wl.orders.find(r => r.id === orderId);
    expect(ourRow.report_signed_off_at).toBeTruthy();
    expect(ourRow.report_signed_off_by).toBe(RADIOLOGIST_UID);
  });
});
