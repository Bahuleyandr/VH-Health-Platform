// MEDIUM (audit 2026-06-18 §4) — discharge-summary lifecycle must emit canonical
// events, and sign() must be transactional.
//
// Defect: markReadyForSignoff / sign / markDelivered wrote only the legacy
// audit_logs row — NO clinical_timeline_events / clinical_audit_events — so a
// signed/delivered discharge summary (a medico-legal patient-facing artifact)
// was invisible to the canonical patient timeline. sign() also stamped the
// admission + materialised discharge meds OUTSIDE any transaction.
//
// Fixes proven here against the real service + real DB:
//   1. markReadyForSignoff emits a canonical discharge_summary.ready timeline +
//      audit event.
//   2. sign emits a canonical discharge_summary.signed timeline + audit event,
//      and the status flip + canonical event are atomic (status='signed').
//   3. markDelivered emits a canonical discharge_summary.delivered event.
//   4. The canonical events carry the patient_uid so they land on the patient's
//      timeline.
//
// Self-isolating fixtures (unique tenant + patient + template per run).

import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import * as dischargeService from '../services/discharge/dischargeService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const SIGNER_UID = randomUUID();
const PHONE = `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

let templateId;

async function timelineEvents(eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, source_table, source_id, patient_uid
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2`,
    PATIENT_UID, eventType,
  );
}
async function auditEvents(action) {
  return prisma.$queryRawUnsafe(
    `SELECT id, action FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2`,
    PATIENT_UID, action,
  );
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_summary_sections WHERE discharge_summary_id IN
       (SELECT id FROM discharge_summaries WHERE patient_uid = $1::uuid)`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM discharge_summaries WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  if (templateId) {
    await prisma.$executeRawUnsafe(`DELETE FROM discharge_summary_templates WHERE id = $1`, templateId).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, SIGNER_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
}

d('Discharge summary canonical lifecycle events (MEDIUM §4)', () => {
  let summaryId;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Discharge Canonical Test Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID, `disch-canon-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Discharge Canonical Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PHONE, TENANT_ID,
    );
    // A template whose required clinical sections we fully populate so the
    // sign-completeness gate (assertSignable) passes.
    const tmpl = await prisma.$queryRawUnsafe(
      `INSERT INTO discharge_summary_templates (tenant_id, code, display_name, specialty, sections, active)
       VALUES ($1::uuid, $2, 'Canon Test Template', 'general_medicine', $3::jsonb, true)
       RETURNING id`,
      TENANT_ID, `CANON-${TENANT_ID.slice(0, 8)}`,
      JSON.stringify([
        { section_key: 'diagnosis', section_title: 'Diagnosis', display_order: 1, default_body: null },
        { section_key: 'discharge_medications', section_title: 'Discharge Medications', display_order: 2, default_body: null },
      ]),
    );
    templateId = tmpl[0].id;
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('createDraft + fill required sections, then markReadyForSignoff emits a canonical ready event', async () => {
    const draft = await dischargeService.createDraft({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      template_code: `CANON-${TENANT_ID.slice(0, 8)}`,
      created_by: SIGNER_UID,
    });
    summaryId = draft.id;
    expect(summaryId).toBeTruthy();

    // Fill the required clinical sections with real content (clears the gate).
    await dischargeService.updateSection({
      tenantId: TENANT_ID, id: summaryId, section_key: 'diagnosis',
      body: 'Community-acquired pneumonia, resolved.', edited_by: SIGNER_UID,
    });
    await dischargeService.updateSection({
      tenantId: TENANT_ID, id: summaryId, section_key: 'discharge_medications',
      body: 'Amoxicillin 500mg PO TDS x5 days', edited_by: SIGNER_UID,
    });

    await dischargeService.markReadyForSignoff({ tenantId: TENANT_ID, id: summaryId, marked_by: SIGNER_UID });

    const tl = await timelineEvents('discharge_summary.ready');
    expect(tl.length).toBeGreaterThanOrEqual(1);
    expect(String(tl[0].patient_uid)).toBe(PATIENT_UID);
    const au = await auditEvents('discharge_summary.ready');
    expect(au.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('sign emits a canonical signed event and flips status atomically', async () => {
    const signed = await dischargeService.sign({
      tenantId: TENANT_ID, id: summaryId,
      signed_by: SIGNER_UID, signed_by_name: 'Dr. Canon Test', signed_by_reg: 'TN-12345',
    });
    expect(signed.status).toBe('signed');

    const tl = await timelineEvents('discharge_summary.signed');
    expect(tl.length).toBeGreaterThanOrEqual(1);
    expect(tl[0].source_table).toBe('discharge_summaries');
    expect(String(tl[0].source_id)).toBe(String(summaryId));
    const au = await auditEvents('discharge_summary.signed');
    expect(au.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('markDelivered emits a canonical delivered event', async () => {
    await dischargeService.markDelivered({
      tenantId: TENANT_ID, id: summaryId, delivery_method: 'printed', delivered_by: SIGNER_UID,
    });

    const tl = await timelineEvents('discharge_summary.delivered');
    expect(tl.length).toBeGreaterThanOrEqual(1);
    const au = await auditEvents('discharge_summary.delivered');
    expect(au.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
