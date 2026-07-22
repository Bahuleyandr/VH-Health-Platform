// Deep integration tests for the radiology module.
// Exercises ordering, acquisition, structured reporting, medico-legal sign-off,
// peer review, TAT metrics, canonical timeline/audit emission, cancellation,
// worklist sorting, and patient history pagination.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'bb000000-0000-4000-8000-00000000b001';
const DOCTOR_UID = 'bb000000-0000-4000-8000-00000000b002';
const RADIOLOGIST_UID = 'bb000000-0000-4000-8000-00000000b003';
const REVIEWER_UID = 'bb000000-0000-4000-8000-00000000b004';
const RAD_TECH_UID = 'bb000000-0000-4000-8000-00000000b005';
const API_KEY = process.env.API_KEY || 'test-api-key';

function mkClient(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanupRadiologyRows() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_alerts
      WHERE patient_id IN (SELECT id FROM users WHERE uid = $1::uuid)`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM radiology_peer_reviews
      WHERE radiology_order_id IN (SELECT id FROM radiology_orders WHERE patient_uid = $1::uuid)`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM radiology_orders WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
}

async function resetPeerReviewSampling() {
  await prisma.$executeRawUnsafe(
    `UPDATE radiology_peer_review_settings
        SET sampling_rate = 0.0200, updated_at = NOW()
      WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
}

describe('Radiology order + report deep integration', () => {
  let doctor;
  let radiologist;
  let reviewer;
  let tech;
  let patientIntId;
  let doctorIntId;
  let radIntId;
  let reviewerIntId;
  let techIntId;

  beforeAll(async () => {
    await cleanupRadiologyRows();
    await prisma.$executeRawUnsafe(
      `DELETE FROM abdm_practitioner_mappings WHERE staff_uid = $1::uuid`,
      RAD_TECH_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM staff WHERE user_id = $1::uuid`,
      RAD_TECH_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
      PATIENT_UID, DOCTOR_UID, RADIOLOGIST_UID, REVIEWER_UID, RAD_TECH_UID,
    );

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000110001', 'Radiology Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID,
    );
    patientIntId = p[0].id;

    const d = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000110002', 'Dr. Referring', 'DOCTOR', true, NOW())
       RETURNING id`,
      DOCTOR_UID,
    );
    doctorIntId = d[0].id;

    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000110003', 'Dr. Radiologist', 'RADIOLOGIST', true, NOW())
       RETURNING id`,
      RADIOLOGIST_UID,
    );
    radIntId = r[0].id;

    const reviewerRow = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000110004', 'Dr. Peer Reviewer', 'RADIOLOGIST', true, NOW())
       RETURNING id`,
      REVIEWER_UID,
    );
    reviewerIntId = reviewerRow[0].id;

    const techRow = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000110005', 'Rad Tech User', 'RADIOLOGY_STAFF', true, NOW())
       RETURNING id`,
      RAD_TECH_UID,
    );
    techIntId = techRow[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (user_id, employee_id, name, designation, department, skills,
          certifications, is_active, archived, created_at, updated_at)
       VALUES ($1::uuid, 'RAD-N6-1-TECH', 'Rad Tech N6', 'Radiology Technologist',
               'Radiology', ARRAY[]::text[], ARRAY[]::text[], true, false, NOW(), NOW())`,
      RAD_TECH_UID,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO abdm_practitioner_mappings
         (tenant_id, staff_uid, hpr_id, full_name, specialty, council_name,
          registration_number, registration_year, qualification, status, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'HPR-N6-1-RAD-TECH', 'Rad Tech N6 HPR',
               'Radiology', 'Tamil Nadu Paramedical Council', 'RAD-LIC-N6-1',
               2026, 'BSc Radiography', 'verified', '{}'::jsonb, NOW(), NOW())`,
      TENANT_ID, RAD_TECH_UID,
    );

    doctor = mkClient('DOCTOR', DOCTOR_UID, doctorIntId);
    radiologist = mkClient('RADIOLOGIST', RADIOLOGIST_UID, radIntId);
    reviewer = mkClient('RADIOLOGIST', REVIEWER_UID, reviewerIntId);
    tech = mkClient('RADIOLOGY_STAFF', RAD_TECH_UID, techIntId);
  });

  afterAll(async () => {
    await resetPeerReviewSampling();
    await cleanupRadiologyRows();
    await prisma.$executeRawUnsafe(
      `DELETE FROM abdm_practitioner_mappings WHERE staff_uid = $1::uuid`,
      RAD_TECH_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM staff WHERE user_id = $1::uuid`,
      RAD_TECH_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
      PATIENT_UID, DOCTOR_UID, RADIOLOGIST_UID, REVIEWER_UID, RAD_TECH_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('validation', () => {
    it('rejects order without required fields', async () => {
      const res = await doctor.post('/api/v1/radiology/orders').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid modality', async () => {
      const res = await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID,
        modality: 'xray-ish',
        body_part: 'chest',
        clinical_indication: 'Cough, fever',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid priority', async () => {
      const res = await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID,
        modality: 'xray',
        body_part: 'chest',
        clinical_indication: 'Cough, fever',
        priority: 'whenever',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects report submission without required fields', async () => {
      const order = await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID,
        modality: 'xray',
        body_part: 'chest',
        clinical_indication: 'Validate empty report rejection',
      });
      expect(order.statusCode).toBe(201);

      const res = await radiologist
        .put(`/api/v1/radiology/${order.body.data.id}/report`)
        .send({});
      expect(res.statusCode).toBe(400);
    });
  });

  describe('full flow', () => {
    let orderId;
    let templateId;
    let signedReportText;

    it('creates an order with status=ordered and a canonical detail row', async () => {
      const res = await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID,
        modality: 'xray',
        body_part: 'chest',
        clinical_indication: 'Persistent cough, r/o pneumonia',
        priority: 'urgent',
        notes: 'Inpatient, ward 3',
      });
      expect(res.statusCode).toBe(201);
      const o = res.body.data;
      expect(o.id).toBeDefined();
      expect(o.status).toBe('ordered');
      expect(o.modality).toBe('xray');
      expect(o.body_part).toBe('chest');
      expect(o.priority).toBe('urgent');
      expect(o.ordered_by).toBe(DOCTOR_UID);
      orderId = o.id;

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, ordered_by FROM radiology_orders WHERE id = $1`,
        orderId,
      );
      expect(row[0].status).toBe('ordered');
      expect(row[0].ordered_by).toBe(DOCTOR_UID);
    });

    it('fetches order detail by id', async () => {
      const res = await doctor.get(`/api/v1/radiology/${orderId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.id).toBe(orderId);
      expect(res.body.data.clinical_indication).toMatch(/Persistent cough/);
    });

    it('lists structured report templates without BigInt serialization failures', async () => {
      const res = await radiologist.get('/api/v1/radiology/templates?modality=xray&body_part=chest');
      expect(res.statusCode).toBe(200);
      const template = res.body.data.find((item) => item.template_code === 'XRAY_CHEST_STANDARD_V1');
      expect(template).toBeTruthy();
      expect(typeof template.id).toBe('number');
      expect(template.sections.map((section) => section.key)).toEqual(['findings', 'impression']);
      templateId = template.id;
    });

    it('marks the study acquired with canonical technologist identity and evidence', async () => {
      const res = await tech.post(`/api/v1/radiology/${orderId}/acquire`).send({
        tech_license_number: 'CLIENT-SPOOF',
        pacs_study_instance_uid: '1.2.826.0.1.3680043.10.54321.61',
        pacs_url: 'pacs://orthanc/studies/n6-1',
        instance_count: 24,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('acquired');
      expect(res.body.data.tech_uid).toBe(RAD_TECH_UID);
      expect(res.body.data.tech_name).toBe('Rad Tech N6');
      expect(res.body.data.tech_license_number).toBe('RAD-LIC-N6-1');
      expect(res.body.data.pacs_study_instance_uid).toBe('1.2.826.0.1.3680043.10.54321.61');
    });

    it('submits a template-driven structured report while preserving legacy report text', async () => {
      const expectedReport = [
        'Findings:\nPatchy opacity in right lower lobe; no pleural effusion',
        'Impression:\nRight lower lobe pneumonia',
        'See findings + impression above. Recommend follow-up in 2 weeks.',
      ].join('\n\n');

      const res = await radiologist.put(`/api/v1/radiology/${orderId}/report`).send({
        template_id: templateId,
        structured_report: {
          sections: {
            findings: 'Patchy opacity in right lower lobe; no pleural effusion',
            impression: 'Right lower lobe pneumonia',
          },
          coded_fields: {
            view: 'pa',
            comparison_available: false,
          },
        },
        report: 'See findings + impression above. Recommend follow-up in 2 weeks.',
      });
      expect(res.statusCode).toBe(200);
      const o = res.body.data;
      expect(o.status).toBe('completed');
      expect(o.radiologist).toBe(RADIOLOGIST_UID);
      expect(o.report_completed_at).toBeTruthy();
      expect(o.template_id).toBe(templateId);
      expect(o.report).toBe(expectedReport);
      expect(o.structured_report.sections.map((section) => section.key)).toEqual(['findings', 'impression']);
      expect(o.structured_report.coded_fields).toMatchObject({ view: 'pa', comparison_available: false });
      signedReportText = o.report;

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, radiologist, report_completed_at, template_id, structured_report
           FROM radiology_orders
          WHERE id = $1`,
        orderId,
      );
      expect(row[0].status).toBe('completed');
      expect(row[0].radiologist).toBe(RADIOLOGIST_UID);
      expect(row[0].report_completed_at).not.toBeNull();
      expect(Number(row[0].template_id)).toBe(templateId);
      expect(row[0].structured_report.sections.map((section) => section.key)).toEqual(['findings', 'impression']);
    });

    it('rejects report submission by a non-radiologist doctor', async () => {
      const res = await doctor.put(`/api/v1/radiology/${orderId}/report`).send({
        report: 'Referring-doctor wet read must not be accepted as the report',
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.message).toMatch(/radiologist role/i);
    });

    it('rejects report sign-off by a non-radiologist doctor', async () => {
      const res = await doctor.post(`/api/v1/radiology/${orderId}/sign-off`).send({});
      expect(res.statusCode).toBe(403);
      expect(res.body.message).toMatch(/radiologist role/i);
    });

    it('radiologist signs off the completed report', async () => {
      const res = await radiologist.post(`/api/v1/radiology/${orderId}/sign-off`).send({
        result_classification: 'abnormal',
        classification_basis: {
          source: 'radiologist_attestation',
          finding: 'right_lower_lobe_pneumonia',
        },
      }).set('Idempotency-Key', `radiology-deep-signoff-${orderId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.report_signed_off_by).toBe(RADIOLOGIST_UID);
      expect(res.body.data.report_signed_off_at).toBeTruthy();
      expect(res.body.data.result_classification).toBe('abnormal');
      expect(res.body.data.diagnostic_generation.source_version).toBe(1);

      await prisma.$executeRawUnsafe(
        `UPDATE radiology_orders
            SET created_at = NOW() - INTERVAL '3 days',
                updated_at = NOW()
          WHERE id = $1::int`,
        orderId,
      );
    });

    it('surfaces breached TAT metrics and creates a clinical alert', async () => {
      const res = await radiologist.get('/api/v1/radiology/tat-metrics?breached=true&limit=20');
      expect(res.statusCode).toBe(200);
      const metric = res.body.data.find((item) => item.radiology_order_id === orderId);
      expect(metric).toBeTruthy();
      expect(metric.priority).toBe('urgent');
      expect(metric.threshold_breached).toBe(true);
      expect(metric.alert_severity).toBe('CRITICAL');
      expect(metric.ordered_to_signed_minutes).toBeGreaterThanOrEqual(24 * 60);

      const alert = await prisma.$queryRawUnsafe(
        `SELECT alert_type, severity, message
           FROM clinical_alerts
          WHERE patient_id = $1::int
            AND alert_type = 'RADIOLOGY_TAT_BREACH'
            AND message LIKE $2
          ORDER BY created_at DESC
          LIMIT 1`,
        patientIntId,
        `Radiology TAT breach for order #${orderId}:%`,
      );
      expect(alert[0]?.severity).toBe('CRITICAL');
      expect(alert[0]?.message).toContain('Radiology TAT breach');
    });

    it('returns a deterministic signed-report sample for peer review', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO radiology_peer_review_settings (tenant_id, sampling_rate, updated_at)
         VALUES ($1::uuid, 1.0000, NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET sampling_rate = 1.0000, updated_at = NOW()`,
        TENANT_ID,
      );
      const first = await radiologist.get('/api/v1/radiology/peer-reviews/sample?seed=n6-1&limit=10');
      const second = await radiologist.get('/api/v1/radiology/peer-reviews/sample?seed=n6-1&limit=10');
      await resetPeerReviewSampling();

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const firstIds = first.body.data.orders.map((item) => item.id);
      const secondIds = second.body.data.orders.map((item) => item.id);
      expect(firstIds).toEqual(secondIds);
      expect(firstIds).toContain(orderId);
    });

    it('rejects peer review by the report author', async () => {
      const res = await radiologist.post(`/api/v1/radiology/${orderId}/peer-reviews`).send({
        discrepancy_score: 1,
        outcome: 'no_change',
        comments: 'Author self-review must not count.',
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.stringify(res.body)).toContain('RADIOLOGY_PEER_REVIEW_SAME_AUTHOR');
    });

    it('records peer review by a different radiologist without mutating report text', async () => {
      const before = await prisma.$queryRawUnsafe(
        `SELECT report FROM radiology_orders WHERE id = $1::int`,
        orderId,
      );
      expect(before[0].report).toBe(signedReportText);

      const res = await reviewer.post(`/api/v1/radiology/${orderId}/peer-reviews`).send({
        discrepancy_score: 2,
        outcome: 'minor_addendum',
        comments: 'Small pleural effusion should be called out.',
        addendum_recommendation: 'Recommend an addendum for the effusion.',
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.radiology_order_id).toBe(orderId);
      expect(res.body.data.reviewer_uid).toBe(REVIEWER_UID);
      expect(res.body.data.report_author_uid).toBe(RADIOLOGIST_UID);

      const after = await prisma.$queryRawUnsafe(
        `SELECT report FROM radiology_orders WHERE id = $1::int`,
        orderId,
      );
      expect(after[0].report).toBe(signedReportText);

      const board = await reviewer.get('/api/v1/radiology/peer-reviews?status=reviewed&limit=20');
      expect(board.statusCode).toBe(200);
      const reviewed = board.body.data.find((item) => item.id === orderId);
      expect(reviewed).toBeTruthy();
      expect(reviewed.review_count).toBeGreaterThanOrEqual(1);
      expect(reviewed.max_discrepancy_score).toBe(2);
    });

    it('rejects an addendum by a non-radiologist doctor', async () => {
      const res = await doctor.post(`/api/v1/radiology/${orderId}/addendum`).send({
        addendum: 'Treating-team note belongs in progress notes, not the report',
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.message).toMatch(/radiologist role/i);
    });

    it('radiologist appends an addendum to the signed report', async () => {
      const res = await radiologist.post(`/api/v1/radiology/${orderId}/addendum`).send({
        addendum: 'Addendum: small right pleural effusion on lateral view, missed on first read.',
        result_classification: 'abnormal',
        classification_basis: {
          source: 'radiologist_attestation',
          finding: 'small_right_pleural_effusion',
        },
        clinical_significance: 'new_finding',
      }).set('Idempotency-Key', `radiology-deep-addendum-${orderId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.report).toBe(signedReportText);
      expect(res.body.data.report_signed_off_by).toBe(RADIOLOGIST_UID);
      expect(res.body.data.addendum.addendum_text).toMatch(/small right pleural effusion/);
      expect(res.body.data.addendum.generation_version).toBe(2);
      expect(res.body.data.diagnostic_generation.predecessor_generation_id).toBeTruthy();
      expect(res.body.data).toMatchObject({
        result_classification: 'abnormal',
        classification_basis: {
          finding: 'small_right_pleural_effusion',
        },
        report_generation_version: 2,
        classification_signed_by: RADIOLOGIST_UID,
        latest_clinical_significance: 'new_finding',
        latest_addendum_id: res.body.data.addendum.id,
      });

      const detail = await radiologist.get(`/api/v1/radiology/${orderId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.body.data.report).toBe(signedReportText);
      expect(detail.body.data.addenda).toHaveLength(1);
      expect(detail.body.data.addenda[0]).toMatchObject({
        generation_version: 2,
        result_classification: 'abnormal',
        clinical_significance: 'new_finding',
      });
      expect(detail.body.data.addenda[0]).not.toHaveProperty('idempotency_key');
      expect(detail.body.data.addenda[0]).not.toHaveProperty('request_sha256');
      expect(detail.body.data).toMatchObject({
        result_classification: 'abnormal',
        classification_basis: {
          source: 'radiologist_attestation',
          finding: 'small_right_pleural_effusion',
        },
        report_generation_version: 2,
        classification_signed_by: RADIOLOGIST_UID,
        latest_clinical_significance: 'new_finding',
        latest_addendum_id: detail.body.data.addenda[0].id,
      });

      const worklist = await radiologist.get('/api/v1/radiology/worklist?modality=xray');
      const worklistOrder = worklist.body.data.find((item) => item.id === orderId);
      expect(worklistOrder).toMatchObject({
        result_classification: 'abnormal',
        report_generation_version: 2,
        latest_clinical_significance: 'new_finding',
        latest_addendum_id: detail.body.data.addenda[0].id,
      });

      const history = await radiologist.get(`/api/v1/radiology/patient/${PATIENT_UID}`);
      const historyOrder = history.body.data.find((item) => item.id === orderId);
      expect(historyOrder).toMatchObject({
        result_classification: 'abnormal',
        report_generation_version: 2,
        latest_addendum_id: detail.body.data.addenda[0].id,
      });
    });

    it('emits canonical timeline and audit rows for order/acquire/report/sign-off/addendum', async () => {
      const expected = [
        'radiology.order_created',
        'radiology.study_acquired',
        'radiology.report_submitted',
        'radiology.report_signed_off',
        'radiology.report_addendum',
      ];
      const timeline = await prisma.$queryRawUnsafe(
        `SELECT event_type, source_id, actor_uid
           FROM clinical_timeline_events
          WHERE source_table = 'radiology_orders'
            AND source_id = $1
          ORDER BY occurred_at ASC`,
        String(orderId),
      );
      const audit = await prisma.$queryRawUnsafe(
        `SELECT action, resource_table, resource_id, actor_uid
           FROM clinical_audit_events
          WHERE resource_table = 'radiology_orders'
            AND resource_id = $1
          ORDER BY occurred_at ASC`,
        String(orderId),
      );

      expect(timeline.map((row) => row.event_type)).toEqual(expect.arrayContaining(expected));
      expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(expected));
      expect(timeline.find((row) => row.event_type === 'radiology.study_acquired')?.actor_uid).toBe(RAD_TECH_UID);
      expect(audit.find((row) => row.action === 'radiology.report_submitted')?.actor_uid).toBe(RADIOLOGIST_UID);
    });

    it('refuses to cancel a completed order', async () => {
      const res = await radiologist.put(`/api/v1/radiology/${orderId}/cancel`);
      expect([400, 500]).toContain(res.statusCode);
    });
  });

  describe('cancel branch', () => {
    let orderId;

    beforeAll(async () => {
      const res = await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID,
        modality: 'ct',
        body_part: 'abdomen',
        clinical_indication: 'Abdominal pain, r/o appendicitis',
      });
      orderId = res.body.data.id;
    });

    it('cancels an ordered study', async () => {
      const res = await doctor.put(`/api/v1/radiology/${orderId}/cancel`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('cancelled');
    });

    it('blocks a second cancel on a cancelled order', async () => {
      const res = await doctor.put(`/api/v1/radiology/${orderId}/cancel`);
      expect([400, 500]).toContain(res.statusCode);
    });

    it('refuses to submit a report on a cancelled order', async () => {
      const res = await radiologist.put(`/api/v1/radiology/${orderId}/report`).send({
        report: 'Too late - order was cancelled',
      });
      expect([400, 500]).toContain(res.statusCode);
    });
  });

  describe('worklist + patient history', () => {
    it('returns the radiology worklist with priority sort (stat before urgent)', async () => {
      await doctor.post('/api/v1/radiology/orders').send({
        patient_uid: PATIENT_UID,
        modality: 'mri',
        body_part: 'brain',
        clinical_indication: 'Sudden-onset headache + neuro deficit',
        priority: 'stat',
      });

      const res = await doctor.get('/api/v1/radiology/worklist');
      expect(res.statusCode).toBe(200);
      const arr = res.body.data;
      expect(Array.isArray(arr)).toBe(true);
      const rank = { stat: 1, urgent: 2, routine: 3 };
      let last = 0;
      for (const o of arr) {
        const r = rank[o.priority] || 99;
        expect(r).toBeGreaterThanOrEqual(last);
        last = r;
      }
    });

    it('filters the worklist by modality', async () => {
      const res = await doctor.get('/api/v1/radiology/worklist?modality=mri');
      expect(res.statusCode).toBe(200);
      for (const o of res.body.data) {
        expect(o.modality).toBe('mri');
      }
    });

    it('returns a patient history with real integer pagination total', async () => {
      const res = await doctor.get(`/api/v1/radiology/patient/${PATIENT_UID}`);
      expect(res.statusCode).toBe(200);
      expect(typeof res.body.meta?.pagination?.total).toBe('number');
      expect(res.body.meta.pagination.total).toBeGreaterThanOrEqual(3);
      for (const o of res.body.data) {
        expect(o.patient_uid).toBe(PATIENT_UID);
      }
    });
  });
});
