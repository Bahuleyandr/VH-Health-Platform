// Deep integration tests for the general lab worklist endpoint + manual
// result validation against critical thresholds.
//
// Covers:
//   - GET /api/v1/lab/worklist surfaces ER + OPD + IPD orders, not just IPD.
//   - source filter selects ER vs IPD vs OPD.
//   - STAT/URGENT priorities sort to the top.
//   - POST /api/v1/lab/results rejects non-numeric values for tests with a
//     configured critical threshold (e.g. TROPI), so the critical-alert
//     pipeline is never silently bypassed.
//
// Findings under test:
//   2026-05-10-emergency-walk-in-lab-tech-stat-er-order-not-on-worklist
//   2026-05-08-obstetric-anc-lab-tech-no-worklist-endpoint
//   2026-05-08-lab-walk-in-lab-tech-results-no-validation-no-critical-alert
//   H' D66 — bulk EMR lab orders must materialize onto worklists

import request from 'supertest';
import app from '../app.js';
import { API_KEY, authClient, generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const PATIENT_ER_UID  = 'b3333333-3333-4333-8333-333333333a01';
const PATIENT_IPD_UID = 'b3333333-3333-4333-8333-333333333a02';
const PATIENT_OPD_UID = 'b3333333-3333-4333-8333-333333333a03';

const PATIENT_ER_PHONE  = '9000030001';
const PATIENT_IPD_PHONE = '9000030002';
const PATIENT_OPD_PHONE = '9000030003';
const ORDERING_DOCTOR_UID = 'b3333333-3333-4333-8333-333333333d01';

function doctorClient() {
  const token = generateTestToken('DOCTOR', { uid: ORDERING_DOCTOR_UID, id: 933301 });
  return {
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function delPatient(uid) {
  // Order matters: blow away dependents before users.
  await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM emergency_visits WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigations WHERE patient_id IN (SELECT id FROM users WHERE uid = $1::uuid)`, uid,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, uid).catch(() => {});
}

async function makePatient(uid, phone, name) {
  await delPatient(uid);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, 'PATIENT', true, NOW())
     RETURNING id`,
    uid, phone, name,
  );
  return rows[0].id;
}

async function makeInvestigation({ patientId, testName, testType, priority = 'NORMAL', status = 'REQUESTED', phone }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (phone, patient_id, test_name, test_type, status, priority, requested_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING id`,
    phone, patientId, testName, testType || 'blood', status, priority,
  );
  return rows[0].id;
}

describe('Lab worklist + manual result validation — deep integration', () => {
  const labTech = authClient('LAB_STAFF');
  const doctor = doctorClient();

  let erPatientId;
  let ipdPatientId;
  let opdPatientId;
  let erTroponinInvId;
  let ipdCbcInvId;
  let opdLftInvId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000039999', 'Lab Worklist Doctor', 'DOCTOR', true, NOW())
       ON CONFLICT (uid) DO UPDATE
          SET role = 'DOCTOR',
              name = EXCLUDED.name,
              is_active = true,
              updated_at = NOW()`,
      ORDERING_DOCTOR_UID,
    );

    erPatientId  = await makePatient(PATIENT_ER_UID,  PATIENT_ER_PHONE,  'Lab Worklist ER Patient');
    ipdPatientId = await makePatient(PATIENT_IPD_UID, PATIENT_IPD_PHONE, 'Lab Worklist IPD Patient');
    opdPatientId = await makePatient(PATIENT_OPD_UID, PATIENT_OPD_PHONE, 'Lab Worklist OPD Patient');

    // ER patient — emergency_visits row + STAT troponin order.
    await prisma.$executeRawUnsafe(
      `INSERT INTO emergency_visits
         (tenant_id, visit_number, patient_uid, arrival_mode, chief_complaint, status)
       VALUES ($1::uuid, $2, $3::uuid, 'walk_in', 'Chest pain', 'arriving')`,
      TENANT_ID, `EMER-LABWL-${Date.now()}`, PATIENT_ER_UID,
    );
    erTroponinInvId = await makeInvestigation({
      patientId: erPatientId, testName: 'Troponin I', testType: 'blood',
      priority: 'URGENT', phone: PATIENT_ER_PHONE,
    });

    // IPD patient — admission row + CBC order.
    // admissions has no `patient_id` int column; it joins to users via
    // `patient_uid` only. `admitted_at`, not `admission_date`.
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (patient_uid, status, admitted_at, ward, bed_number, created_at, updated_at)
       VALUES ($1::uuid, 'admitted', NOW(), 'General Ward', 'GW-LABWL', NOW(), NOW())`,
      PATIENT_IPD_UID,
    );
    ipdCbcInvId = await makeInvestigation({
      patientId: ipdPatientId, testName: 'CBC', testType: 'blood',
      priority: 'NORMAL', phone: PATIENT_IPD_PHONE,
    });

    // OPD patient — no admission, no ER visit, just a walk-in LFT.
    opdLftInvId = await makeInvestigation({
      patientId: opdPatientId, testName: 'LFT', testType: 'blood',
      priority: 'NORMAL', phone: PATIENT_OPD_PHONE,
    });

    // Ensure a TROPI critical threshold exists for this tenant.
    await prisma.$executeRawUnsafe(
      `INSERT INTO lab_critical_thresholds
         (tenant_id, test_code, test_name, critical_high, is_active)
       VALUES ($1::uuid, 'TROPI', 'Troponin I', 0.04, true)
       ON CONFLICT DO NOTHING`,
      TENANT_ID,
    );
  });

  afterAll(async () => {
    await delPatient(PATIENT_ER_UID);
    await delPatient(PATIENT_IPD_UID);
    await delPatient(PATIENT_OPD_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, ORDERING_DOCTOR_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('GET /api/v1/lab/worklist', () => {
    it('materializes a STAT clinical lab order onto the lab worklist', async () => {
      const res = await doctor.post('/api/v1/emr/orders').send({
        patient_uid: PATIENT_ER_UID,
        er_visit_id: null,
        order_type: 'lab',
        priority: 'STAT',
        details: {
          test_name: 'Troponin I - CPOE bridge',
          test_code: 'TROPI_LOCAL',
          test_type: 'LAB',
          reason: 'ED chest-pain pathway',
        },
      });

      expect(res.statusCode).toBe(201);
      const orderId = res.body.data?.order?.id;
      expect(orderId).toBeDefined();

      const investigations = await prisma.$queryRawUnsafe(
        `SELECT id, test_name, priority, notes
           FROM investigations
          WHERE patient_uid = $1::uuid
            AND notes LIKE $2
          ORDER BY id DESC
          LIMIT 1`,
        PATIENT_ER_UID,
        `%clinical_order_id:${orderId}%`,
      );
      expect(investigations.length).toBe(1);
      expect(investigations[0].test_name).toBe('Troponin I - CPOE bridge');
      expect(investigations[0].priority).toBe('STAT');

      const worklist = await labTech.get('/api/v1/lab/worklist?source=er&priority=STAT&limit=100');
      expect(worklist.statusCode).toBe(200);
      const row = worklist.body.data.find((item) => item.id === investigations[0].id);
      expect(row).toBeDefined();
      expect(row.source).toBe('er');
      expect(row.patient_uid).toBe(PATIENT_ER_UID);
    });

    it('materializes a STAT bulk EMR lab order onto the lab worklist (D66)', async () => {
      const res = await doctor.post('/api/v1/emr/orders/bulk').send({
        orders: [
          {
            patient_uid: PATIENT_ER_UID,
            order_type: 'lab',
            priority: 'STAT',
            details: {
              test_name: 'CBC - D66 bulk worklist bridge',
              test_type: 'LAB',
              reason: 'Bulk EMR order should reach lab worklist',
            },
          },
        ],
      });

      expect(res.statusCode).toBe(201);
      expect(Array.isArray(res.body.data)).toBe(true);
      const orderId = res.body.data?.[0]?.order?.id;
      expect(orderId).toBeDefined();

      const investigations = await prisma.$queryRawUnsafe(
        `SELECT id, test_name, priority, notes
           FROM investigations
          WHERE patient_uid = $1::uuid
            AND notes LIKE $2
          ORDER BY id DESC
          LIMIT 1`,
        PATIENT_ER_UID,
        `%clinical_order_id:${orderId}%`,
      );
      expect(investigations.length).toBe(1);
      expect(investigations[0].test_name).toBe('CBC - D66 bulk worklist bridge');
      expect(investigations[0].priority).toBe('STAT');

      const worklist = await labTech.get('/api/v1/lab/worklist?source=er&priority=STAT&limit=100');
      expect(worklist.statusCode).toBe(200);
      const row = worklist.body.data.find((item) => item.id === investigations[0].id);
      expect(row).toBeDefined();
      expect(row.source).toBe('er');
      expect(row.patient_uid).toBe(PATIENT_ER_UID);
    });

    it('surfaces ER + IPD + OPD pending orders, with STAT/URGENT first', async () => {
      const res = await labTech.get('/api/v1/lab/worklist?limit=100');
      expect(res.statusCode).toBe(200);
      const ids = res.body.data.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([erTroponinInvId, ipdCbcInvId, opdLftInvId]));

      const troponinRow = res.body.data.find((r) => r.id === erTroponinInvId);
      expect(troponinRow).toBeDefined();
      expect(troponinRow.source).toBe('er');

      const cbcRow = res.body.data.find((r) => r.id === ipdCbcInvId);
      expect(cbcRow.source).toBe('ipd');
      expect(cbcRow.ward).toBe('General Ward');

      const lftRow = res.body.data.find((r) => r.id === opdLftInvId);
      expect(lftRow.source).toBe('opd');

      // URGENT troponin should appear before NORMAL CBC / LFT.
      const tropIdx = res.body.data.findIndex((r) => r.id === erTroponinInvId);
      const cbcIdx = res.body.data.findIndex((r) => r.id === ipdCbcInvId);
      const lftIdx = res.body.data.findIndex((r) => r.id === opdLftInvId);
      expect(tropIdx).toBeLessThan(cbcIdx);
      expect(tropIdx).toBeLessThan(lftIdx);
    });

    it('filters by source=er', async () => {
      const res = await labTech.get('/api/v1/lab/worklist?source=er&limit=100');
      expect(res.statusCode).toBe(200);
      const ids = res.body.data.map((r) => r.id);
      expect(ids).toContain(erTroponinInvId);
      expect(ids).not.toContain(ipdCbcInvId);
      expect(ids).not.toContain(opdLftInvId);
    });

    it('filters by source=ipd (same as /worklist/ipd shape)', async () => {
      const res = await labTech.get('/api/v1/lab/worklist?source=ipd&limit=100');
      expect(res.statusCode).toBe(200);
      const ids = res.body.data.map((r) => r.id);
      expect(ids).toContain(ipdCbcInvId);
      expect(ids).not.toContain(erTroponinInvId);
      expect(ids).not.toContain(opdLftInvId);
    });

    it('rejects an unknown source filter', async () => {
      const res = await labTech.get('/api/v1/lab/worklist?source=bogus');
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/lab/results validation', () => {
    it('returns a controlled 400 for malformed patient UID lookups', async () => {
      const res = await labTech.get('/api/v1/lab/results/patient/not-a-uuid?limit=5');

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('patientUid must be a valid UUID');
    });

    it('rejects non-numeric value_text for a test with a configured critical threshold', async () => {
      const res = await labTech.post('/api/v1/lab/results').send({
        patient_uid: PATIENT_ER_UID,
        test_code: 'TROPI',
        test_name: 'Troponin I',
        value_text: 'elevated',
        unit: 'ng/mL',
      });
      expect(res.statusCode).toBe(400);
      expect(String(res.body.message || res.body.error)).toMatch(/numeric/i);
    });

    it('accepts a numeric value and fires a critical alert when above threshold', async () => {
      const res = await labTech.post('/api/v1/lab/results').send({
        investigation_id: erTroponinInvId,
        patient_uid: PATIENT_ER_UID,
        test_code: 'TROPI',
        test_name: 'Troponin I',
        value_text: '0.85',
        unit: 'ng/mL',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data?.result?.is_critical).toBe(true);
      expect(res.body.data?.alerts?.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects an empty value_text outright', async () => {
      const res = await labTech.post('/api/v1/lab/results').send({
        patient_uid: PATIENT_OPD_UID,
        test_code: 'GENERIC',
        test_name: 'Generic test',
        value_text: '',
      });
      expect(res.statusCode).toBe(400);
    });

    it('still accepts free-text value for tests without a critical threshold (e.g. culture)', async () => {
      const res = await labTech.post('/api/v1/lab/results').send({
        investigation_id: opdLftInvId,
        patient_uid: PATIENT_OPD_UID,
        test_code: 'BLDCULT',
        test_name: 'Blood culture',
        value_text: 'No growth at 48 hours',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data?.result?.value_text).toBe('No growth at 48 hours');
    });
  });
});
