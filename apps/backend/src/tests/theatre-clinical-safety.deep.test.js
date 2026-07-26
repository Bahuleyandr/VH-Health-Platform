// Deep integration tests for the theatre clinical-safety fixes
// (audit 2026-06-18 §C-2 + §3 Theatre). Proves, against the real QA DB:
//
//   1. A surgical status change writes a clinical_timeline_events +
//      clinical_audit_events row in the SAME tx as the detail update.
//   2. Two concurrent updateStatus calls cannot both succeed
//      (FOR UPDATE + from-state predicate → one wins, the other 409s).
//   3. The OR-booking gist exclusion constraint (migration 319) rejects an
//      overlapping insert EVEN WITH force=true.
//   4. A case cannot close without the WHO sign-out (or authorized override).
//   5. Anaesthesia totals match SUM() under concurrent chart entries
//      (atomic insert + deterministic rollup — no accumulator drift).
//
// Service-level (not HTTP) so concurrency + transaction boundaries are under
// direct control. Self-isolating: a dedicated tenant + patient/surgeon set,
// torn down in afterAll; every ot_schedule created here is cleaned up.

import prisma from '../lib/prisma.js';
import theatreService from '../services/theatre/theatreService.js';
import * as orBoard from '../services/theatre/orBoardService.js';
import * as anesthesia from '../services/theatre/anesthesiaChartService.js';
import * as surgicalDocs from '../services/theatre/surgicalDocumentationService.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'ca110000-0000-4000-8000-0000000000c1';
const SURGEON_UID = 'ca110000-0000-4000-8000-0000000000c2';
const ANESTHETIST_UID = 'ca110000-0000-4000-8000-0000000000c3';
const NURSE_UID = 'ca110000-0000-4000-8000-0000000000c4';
const AUTHORIZER_UID = 'ca110000-0000-4000-8000-0000000000c5';

function futureDateISO(offsetDays = 200) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
const SCHED_DATE = futureDateISO(200);

const createdScheduleIds = [];

async function cleanupSchedules() {
  if (createdScheduleIds.length === 0) return;
  const ids = [...new Set(createdScheduleIds)];
  for (const tbl of [
    'anesthesia_chart_entries', 'anesthesia_records', 'intraop_notes',
    'postop_notes', 'preop_checklists', 'surgical_safety_checklists',
    'surgical_implants', 'postop_complication_alerts',
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${tbl} WHERE ot_schedule_id = ANY($1::int[])`, ids).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM ot_schedules WHERE id = ANY($1::int[])`, ids).catch(() => {});
  // Canonical rows are keyed by source_id (the schedule id, as text).
  const idStrs = ids.map(String);
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid AND source_table IN
        ('ot_schedules','intraop_notes','postop_notes','anesthesia_records',
         'surgical_safety_checklists','surgical_implants','postop_complication_alerts')
        AND patient_uid = $2::uuid`,
    TENANT_ID, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_ID, PATIENT_UID).catch(() => {});
}

async function schedule({ ot_room, scheduled_time, estimated_duration = 60, consent_obtained = true, force }) {
  const res = await orBoard.scheduleWithConflictCheck({
    patient_uid: PATIENT_UID,
    surgeon: SURGEON_UID,
    anesthetist: ANESTHETIST_UID,
    procedure_name: 'Test procedure',
    ot_room,
    scheduled_date: SCHED_DATE,
    scheduled_time,
    estimated_duration,
    consent_obtained,
    tenantId: TENANT_ID,
    force,
  });
  createdScheduleIds.push(res.schedule.id);
  return res.schedule;
}

// Timeline events for a case. Status/scheduling events key source_id to the
// ot_schedule itself; surgical-doc events key source_id to the detail row id
// but always carry the schedule id as resource_id — so resource_id is the
// stable per-case lookup across both.
async function timelineRowsFor(scheduleId, sourceTable, eventType = null) {
  const params = [TENANT_ID, String(scheduleId), sourceTable];
  let extra = '';
  if (eventType) { params.push(eventType); extra = ' AND event_type = $4'; }
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, event_status, actor_uid, payload
       FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid AND resource_id = $2 AND source_table = $3${extra}`,
    ...params);
}

async function auditRowsFor(scheduleId, eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id, action, action_status, resource_id
       FROM clinical_audit_events
      WHERE tenant_id = $1::uuid AND resource_id = $2 AND action = $3`,
    TENANT_ID, String(scheduleId), eventType);
}

async function markTimeOutComplete(scheduleId) {
  await surgicalDocs.upsertSafetyChecklistPhase({
    tenantId: TENANT_ID,
    otScheduleId: scheduleId,
    patientUid: PATIENT_UID,
    phase: 'sign_in',
    performedBy: ANESTHETIST_UID,
    items: [
      { item: 'identity', confirmed: true },
      { item: 'procedure_and_site', confirmed: true },
      { item: 'consent', confirmed: true },
      { item: 'allergies_and_anesthesia_risk', confirmed: true },
      { item: 'readiness', confirmed: true },
    ],
    allItemsConfirmed: true,
  });
  await surgicalDocs.upsertSafetyChecklistPhase({
    tenantId: TENANT_ID,
    otScheduleId: scheduleId,
    patientUid: PATIENT_UID,
    phase: 'time_out',
    performedBy: SURGEON_UID,
    allItemsConfirmed: true,
  });
}

async function seedClosurePrereqs(scheduleId, { signOut = true } = {}) {
  // Finalized + signed anaesthesia record.
  await surgicalDocs.upsertAnesthesiaRecord({
    tenantId: TENANT_ID, otScheduleId: scheduleId, patientUid: PATIENT_UID,
    anesthetist: ANESTHETIST_UID, technique: 'general', status: 'finalized', finalizedBy: ANESTHETIST_UID,
  });
  // Finalized + signed intraop note with correct counts, signed by booked surgeon.
  const note = await surgicalDocs.createIntraopNote({
    tenantId: TENANT_ID, otScheduleId: scheduleId, patientUid: PATIENT_UID,
    surgeon: SURGEON_UID, procedurePerformed: 'Test procedure',
    spongeCountCorrect: true, sharpCountCorrect: true, instrumentCountCorrect: true,
  });
  await surgicalDocs.finalizeIntraopNote({ tenantId: TENANT_ID, id: note.id, finalizedBy: SURGEON_UID });
  if (signOut) {
    await surgicalDocs.upsertSafetyChecklistPhase({
      tenantId: TENANT_ID, otScheduleId: scheduleId, patientUid: PATIENT_UID,
      phase: 'sign_out', performedBy: SURGEON_UID, allItemsConfirmed: true,
    });
  }
}

beforeAll(async () => {
  await cleanupSchedules();
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid)`,
    PATIENT_UID, SURGEON_UID, ANESTHETIST_UID, NURSE_UID, AUTHORIZER_UID).catch(() => {});
  const seed = [
    [PATIENT_UID, '9100200001', 'CS Patient', 'PATIENT'],
    [SURGEON_UID, '9100200002', 'CS Surgeon', 'DOCTOR'],
    [ANESTHETIST_UID, '9100200003', 'CS Anesthetist', 'DOCTOR'],
    [NURSE_UID, '9100200004', 'CS Nurse', 'NURSING_STAFF'],
    [AUTHORIZER_UID, '9100200005', 'CS Authorizer', 'DOCTOR'],
  ];
  for (const [uid, phone, name, role] of seed) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid,$2,$3,$4,true,$5::uuid,NOW())`,
      uid, phone, name, role, TENANT_ID);
  }
});

afterAll(async () => {
  await cleanupSchedules();
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid)`,
    PATIENT_UID, SURGEON_UID, ANESTHETIST_UID, NURSE_UID, AUTHORIZER_UID).catch(() => {});
  await prisma.$disconnect().catch(() => {});
});

describe('Fix #1 — surgical writes hit the canonical timeline + audit', () => {
  it('scheduleSurgery emits one timeline + one audit row in the same tx', async () => {
    const s = await schedule({ ot_room: 'CS-OT-1', scheduled_time: '08:00' });
    const timeline = await timelineRowsFor(s.id, 'ot_schedules', 'surgery.scheduled');
    const audit = await auditRowsFor(s.id, 'surgery.scheduled');
    expect(timeline.length).toBe(1);
    expect(audit.length).toBe(1);
    expect(timeline[0].event_status).toBe('scheduled');
  });

  it('a status change writes a clinical_timeline_events + clinical_audit_events row in the same tx', async () => {
    const s = await schedule({ ot_room: 'CS-OT-2', scheduled_time: '08:00' });
    await theatreService.updateStatus(s.id, 'pre_op', SURGEON_UID, { tenantId: TENANT_ID });

    const timeline = await timelineRowsFor(s.id, 'ot_schedules', 'surgery.pre_op');
    const audit = await auditRowsFor(s.id, 'surgery.pre_op');
    expect(timeline.length).toBe(1);
    expect(audit.length).toBe(1);
    expect(timeline[0].event_status).toBe('pre_op');
    expect(timeline[0].actor_uid).toBe(SURGEON_UID);
    expect(timeline[0].payload.from_status).toBe('scheduled');
    expect(timeline[0].payload.to_status).toBe('pre_op');
  });

  it('WHO checklist phase, implant, and complication each emit a canonical timeline row', async () => {
    const s = await schedule({ ot_room: 'CS-OT-3', scheduled_time: '08:00' });
    await markTimeOutComplete(s.id);
    await surgicalDocs.recordImplant({
      tenantId: TENANT_ID, otScheduleId: s.id, patientUid: PATIENT_UID,
      implantType: 'IOL', manufacturer: 'Acme', lotNumber: 'LOT-42', implantedBy: SURGEON_UID,
    });
    await surgicalDocs.recordComplicationAlert({
      tenantId: TENANT_ID, otScheduleId: s.id, patientUid: PATIENT_UID,
      complicationType: 'hemorrhage', severity: 'high', detectedBy: SURGEON_UID,
    });

    expect((await timelineRowsFor(s.id, 'surgical_safety_checklists', 'surgery.who_checklist.time_out')).length).toBe(1);
    const implant = await timelineRowsFor(s.id, 'surgical_implants', 'surgery.implant.recorded');
    expect(implant.length).toBe(1);
    expect(implant[0].payload.lot_number).toBe('LOT-42'); // device-recall traceability
    expect((await timelineRowsFor(s.id, 'postop_complication_alerts', 'surgery.complication.recorded')).length).toBe(1);
  });
});

describe('Fix #2 — status transition is lock-safe + from-state-guarded', () => {
  it('two concurrent updateStatus calls cannot both succeed', async () => {
    const s = await schedule({ ot_room: 'CS-OT-4', scheduled_time: '08:00' });
    // Both racers attempt the same scheduled → pre_op transition. The FOR
    // UPDATE lock serializes them; the from-state predicate (AND status =
    // 'scheduled') makes the loser's UPDATE match 0 rows → 409.
    const results = await Promise.allSettled([
      theatreService.updateStatus(s.id, 'pre_op', SURGEON_UID, { tenantId: TENANT_ID }),
      theatreService.updateStatus(s.id, 'pre_op', SURGEON_UID, { tenantId: TENANT_ID }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // The loser is an invalid-transition (pre_op→pre_op not allowed) or a
    // from-state conflict — both are clean operational errors, never a row
    // that double-applied. Verify the row advanced exactly once.
    const err = rejected[0].reason;
    expect(err.isOperational).toBe(true);
    expect([400, 409]).toContain(err.statusCode);

    const row = await prisma.$queryRawUnsafe(
      `SELECT status FROM ot_schedules WHERE id = $1`, s.id);
    expect(row[0].status).toBe('pre_op');
    // Exactly one canonical pre_op event — not two.
    expect((await timelineRowsFor(s.id, 'ot_schedules', 'surgery.pre_op')).length).toBe(1);
  });

  it('rejects an illegal transition (scheduled → in_progress) with 400 and no DB change', async () => {
    const s = await schedule({ ot_room: 'CS-OT-5', scheduled_time: '08:00' });
    await expect(
      theatreService.updateStatus(s.id, 'in_progress', SURGEON_UID, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATE_TRANSITION' });
    const row = await prisma.$queryRawUnsafe(`SELECT status FROM ot_schedules WHERE id = $1`, s.id);
    expect(row[0].status).toBe('scheduled');
  });
});

describe('Fix #3 — OR double-booking has a DB constraint (force cannot overlap)', () => {
  it('rejects an overlapping insert even with force=true', async () => {
    await schedule({ ot_room: 'CS-OT-CLASH', scheduled_time: '09:00', estimated_duration: 60 });
    // Overlapping window (09:30 inside 09:00–10:00) in the same room, WITH
    // force=true — the app pre-check is skipped but migration 319's exclusion
    // constraint rejects the real overlap.
    await expect(
      schedule({ ot_room: 'CS-OT-CLASH', scheduled_time: '09:30', estimated_duration: 60, force: true }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'OT_ROOM_DOUBLE_BOOKED' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM ot_schedules
        WHERE tenant_id = $1::uuid AND ot_room = 'CS-OT-CLASH'
          AND status NOT IN ('cancelled','completed')`,
      TENANT_ID);
    expect(rows[0].n).toBe(1); // the overlapping insert never landed
  });

  it('allows a non-overlapping (back-to-back) booking in the same room', async () => {
    await schedule({ ot_room: 'CS-OT-SEQ', scheduled_time: '09:00', estimated_duration: 60 });
    // 10:00 starts exactly when the first ends → half-open ranges do not
    // overlap, so this is allowed.
    const second = await schedule({ ot_room: 'CS-OT-SEQ', scheduled_time: '10:00', estimated_duration: 60 });
    expect(second.id).toBeDefined();
  });
});

describe('Fix #4 — WHO sign-out + consent gates', () => {
  it('blocks the start (pre_op → in_progress) when consent is not documented', async () => {
    const s = await schedule({ ot_room: 'CS-OT-6', scheduled_time: '08:00', consent_obtained: false });
    await theatreService.updateStatus(s.id, 'pre_op', SURGEON_UID, { tenantId: TENANT_ID });
    await markTimeOutComplete(s.id); // time-out done, but consent absent
    await expect(
      theatreService.updateStatus(s.id, 'in_progress', SURGEON_UID, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SURGICAL_CONSENT_REQUIRED' });
    const row = await prisma.$queryRawUnsafe(`SELECT status FROM ot_schedules WHERE id = $1`, s.id);
    expect(row[0].status).toBe('pre_op');
  });

  it('blocks closure (in_progress → post_op) without the WHO sign-out', async () => {
    const s = await schedule({ ot_room: 'CS-OT-7', scheduled_time: '08:00', consent_obtained: true });
    await theatreService.updateStatus(s.id, 'pre_op', SURGEON_UID, { tenantId: TENANT_ID });
    await markTimeOutComplete(s.id);
    await theatreService.updateStatus(s.id, 'in_progress', SURGEON_UID, { tenantId: TENANT_ID });
    // Anaesthesia + intraop note finalized + counts correct, but NO sign-out.
    await seedClosurePrereqs(s.id, { signOut: false });
    await expect(
      theatreService.updateStatus(s.id, 'post_op', SURGEON_UID, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'WHO_SIGNOUT_REQUIRED' });
    const row = await prisma.$queryRawUnsafe(`SELECT status FROM ot_schedules WHERE id = $1`, s.id);
    expect(row[0].status).toBe('in_progress');
  });

  it('allows closure once the WHO sign-out is complete', async () => {
    const s = await schedule({ ot_room: 'CS-OT-8', scheduled_time: '08:00', consent_obtained: true });
    await theatreService.updateStatus(s.id, 'pre_op', SURGEON_UID, { tenantId: TENANT_ID });
    await markTimeOutComplete(s.id);
    await theatreService.updateStatus(s.id, 'in_progress', SURGEON_UID, { tenantId: TENANT_ID });
    await seedClosurePrereqs(s.id, { signOut: true });
    const res = await theatreService.updateStatus(s.id, 'post_op', SURGEON_UID, { tenantId: TENANT_ID });
    expect(res.status).toBe('post_op');
  });
});

describe('Fix #5 — anaesthesia totals are atomic (match SUM under concurrent entries)', () => {
  it('case-record totals equal SUM() over chart entries after concurrent inserts', async () => {
    const s = await schedule({ ot_room: 'CS-OT-9', scheduled_time: '08:00' });
    await surgicalDocs.upsertSafetyChecklistPhase({
      tenantId: TENANT_ID,
      otScheduleId: s.id,
      patientUid: PATIENT_UID,
      phase: 'sign_in',
      performedBy: ANESTHETIST_UID,
      items: [{ item: 'identity_and_anesthesia_readiness', confirmed: true }],
      allItemsConfirmed: true,
    });
    // Fire many chart entries concurrently. Each commits its own atomic
    // insert + deterministic recompute; the rollup must equal the SUM().
    const entries = Array.from({ length: 12 }, (_, i) => ({
      iv_fluids_ml: 100 + i,
      blood_loss_ml: 5 + i,
      urine_output_ml: 10 + i,
    }));
    await Promise.all(entries.map((e, i) => anesthesia.recordEntry({
      tenantId: TENANT_ID,
      ot_schedule_id: s.id,
      recorded_at: new Date(Date.now() + i * 1000).toISOString(),
      recorded_by: ANESTHETIST_UID,
      ...e,
    })));

    const expectedFluids = entries.reduce((a, e) => a + e.iv_fluids_ml, 0);
    const expectedBlood = entries.reduce((a, e) => a + e.blood_loss_ml, 0);
    const expectedUrine = entries.reduce((a, e) => a + e.urine_output_ml, 0);

    const totals = await anesthesia.totalsForCase({ tenantId: TENANT_ID, ot_schedule_id: s.id });
    expect(totals.entries).toBe(entries.length);
    expect(totals.total_iv_fluids_ml).toBe(expectedFluids);
    expect(totals.total_blood_loss_ml).toBe(expectedBlood);

    // The rolled-up case record must match the chart SUM exactly — no drift.
    const rec = await prisma.$queryRawUnsafe(
      `SELECT fluids_in_ml, blood_loss_ml, urine_output_ml, status,
              jsonb_array_length(events) AS event_count
         FROM anesthesia_records WHERE tenant_id = $1::uuid AND ot_schedule_id = $2`,
      TENANT_ID, s.id);
    expect(rec[0].fluids_in_ml).toBe(expectedFluids);
    expect(rec[0].blood_loss_ml).toBe(expectedBlood);
    expect(rec[0].urine_output_ml).toBe(expectedUrine);
    expect(rec[0].status).toBe('draft');
  });
});
