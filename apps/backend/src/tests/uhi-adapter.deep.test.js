// UHI adapter (migration 705) — deep suite against the real DB.
//
// Covers (service level; the public-route pipeline is pinned in
// unit/uhiCallbackPipeline.test.js and the beckn crypto in
// unit/uhiSignature.test.js):
//   - uq_uhi_txn_leg replay dedupe: a redelivered leg collapses onto one row;
//     an inbound `search` and outbound `on_search` sharing (txn, msg) coexist
//     because `action` is in the key;
//   - rejected evidence rows: signature failures persist with
//     signature_verified=false + reason, and the DB CHECK
//     (chk_uhi_txn_rejected_reason) refuses reason-less rejections;
//   - confirm → REAL appointments row through createAppointment, with the
//     canonical clinical timeline + audit rows present (the invariant is
//     inherited, never re-implemented) and appointment_id + booking_snapshot
//     stamped on the confirm evidence row;
//   - cancel → patient self-service cancel through transitionAppointment;
//   - tenant binding: tenant A's legs are invisible to tenant B.
//
// The outbound gateway client is mocked (abdmRegisterAbhaLinkage pattern) —
// no network I/O; everything else is real.

import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const sendUhiCallback = jest.fn(async () => ({ ok: true, status: 200, error: null }));
jest.unstable_mockModule('../services/uhi/uhiGatewayClient.js', () => ({
  sendUhiCallback,
  default: { sendUhiCallback },
}));

const prisma = (await import('../lib/prisma.js')).default;
const {
  handleUhiCancel,
  handleUhiConfirm,
  handleUhiSearch,
  listUhiTransactions,
  recordUhiLeg,
} = await import('../services/uhi/uhiAdapterService.js');
const { withAuditBypass } = await import('./helpers/auditBypass.js');

const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const PATIENT_PHONE = `98765${String(Math.floor(Math.random() * 90000) + 10000)}`;
const APPT_DATE = '2027-03-10';

let patientId;
let doctorUserId;

function context(overrides = {}) {
  return {
    transactionId: 'uhi-txn-1',
    messageId: `msg-${randomUUID().slice(0, 8)}`,
    providerId: 'hsp.deep-test',
    consumerId: 'eua.deep-test',
    consumerUri: 'https://eua.example/callback',
    ...overrides,
  };
}

async function cleanupTenant(tenantId) {
  await withAuditBypass(prisma, async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM uhi_transactions WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM appointment_status_history WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM appointment_queues WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM pathway_projector_inbox WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM event_outbox WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM notifications WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM care_team_members WHERE tenant_id = $1::uuid`, tenantId).catch(() => {});
    await tx.$executeRawUnsafe(`DELETE FROM care_teams WHERE tenant_id = $1::uuid`, tenantId).catch(() => {});
    await tx.$executeRawUnsafe(`DELETE FROM appointments WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM doctors WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM users WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId);
  }).catch(() => {});
}

async function cleanup() {
  await cleanupTenant(TENANT_ID);
  await cleanupTenant(OTHER_TENANT_ID);
}

d('UHI adapter (migration 705)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'UHI Deep Tenant',
               '{"care_pathways":{"op_contact_to_recovery":"active"},"uhi":{"enabled":true}}'::jsonb)`,
      TENANT_ID,
      `uhi-deep-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'UHI Deep Other Tenant', '{}'::jsonb)`,
      OTHER_TENANT_ID,
      `uhi-deep-o-${OTHER_TENANT_ID.slice(0, 8)}`,
    );
    const patient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, is_deleted, tenant_id, updated_at)
       VALUES ($1::uuid, $2::text, 'UHI Deep Patient', 'PATIENT', TRUE, 'active', FALSE, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID,
      `+91${PATIENT_PHONE}`,
      TENANT_ID,
    );
    patientId = Number(patient[0].id);
    const doctor = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, is_deleted, tenant_id, updated_at)
       VALUES ($1::uuid, $2::text, 'Dr UHI Deep Cardiologist', 'DOCTOR', TRUE, 'active', FALSE, $3::uuid, NOW())
       RETURNING id`,
      DOCTOR_UID,
      `+9198888${String(Math.floor(Math.random() * 90000) + 10000)}`,
      TENANT_ID,
    );
    doctorUserId = Number(doctor[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO doctors (user_id, name, department, specialty, is_active, is_available, tenant_id, updated_at)
       VALUES ($1::int, 'Dr UHI Deep Cardiologist', 'Cardiology', 'Cardiology', TRUE, TRUE, $2::uuid, NOW())`,
      doctorUserId,
      TENANT_ID,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(() => {
    sendUhiCallback.mockClear();
  });

  it('dedupes a redelivered leg on uq_uhi_txn_leg while letting inbound/outbound share (txn, msg)', async () => {
    const ctx = context({ messageId: 'msg-dedupe' });
    const first = await recordUhiLeg({
      tenantId: TENANT_ID,
      transactionId: ctx.transactionId,
      messageId: ctx.messageId,
      action: 'search',
      direction: 'inbound',
      payload: { context: { transaction_id: ctx.transactionId } },
      signatureVerified: true,
    });
    expect(first.duplicate).toBe(false);

    // Gateway redelivery of the SAME leg → collapses onto the existing row.
    const replay = await recordUhiLeg({
      tenantId: TENANT_ID,
      transactionId: ctx.transactionId,
      messageId: ctx.messageId,
      action: 'search',
      direction: 'inbound',
      payload: {},
      signatureVerified: true,
    });
    expect(replay.duplicate).toBe(true);
    expect(Number(replay.row.id)).toBe(Number(first.row.id));

    // Our on_search callback REUSES the originating message_id — action in
    // the unique key is what lets both legs be recorded.
    const outbound = await recordUhiLeg({
      tenantId: TENANT_ID,
      transactionId: ctx.transactionId,
      messageId: ctx.messageId,
      action: 'on_search',
      direction: 'outbound',
      payload: {},
      signatureVerified: true,
    });
    expect(outbound.duplicate).toBe(false);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT action, direction FROM uhi_transactions
        WHERE tenant_id = $1::uuid AND transaction_id = $2::text AND message_id = $3::text
        ORDER BY id ASC`,
      TENANT_ID,
      ctx.transactionId,
      ctx.messageId,
    );
    expect(rows).toEqual([
      { action: 'search', direction: 'inbound' },
      { action: 'on_search', direction: 'outbound' },
    ]);
  });

  it('persists signature failures as rejected evidence, and the DB refuses reason-less rejections', async () => {
    const { row } = await recordUhiLeg({
      tenantId: TENANT_ID,
      transactionId: 'uhi-txn-reject',
      messageId: 'msg-forged',
      action: 'confirm',
      direction: 'inbound',
      payload: { context: {} },
      signatureVerified: false,
      verificationFailureReason: 'UHI_SIGNATURE_INVALID',
      status: 'rejected',
      ack: 'NACK',
      errorCode: 'UHI_SIGNATURE_INVALID',
    });
    expect(row).toMatchObject({
      signature_verified: false,
      verification_failure_reason: 'UHI_SIGNATURE_INVALID',
      status: 'rejected',
      ack: 'NACK',
    });

    // chk_uhi_txn_rejected_reason: rejected must carry a reason or error code.
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO uhi_transactions
         (tenant_id, transaction_id, message_id, action, direction, status)
       VALUES ($1::uuid, 'uhi-txn-reject', 'msg-bare', 'confirm', 'inbound', 'rejected')`,
      TENANT_ID,
    )).rejects.toThrow(/chk_uhi_txn_rejected_reason|check constraint/i);
  });

  it('answers search from the real doctor/slot data', async () => {
    const ctx = context({ messageId: 'msg-search' });
    const result = await handleUhiSearch({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      context: ctx,
      body: {
        message: {
          intent: {
            fulfillment: {
              agent: { speciality: 'cardio' },
              start: { time: { timestamp: APPT_DATE } },
            },
          },
        },
      },
    });
    expect(result.message.catalog.items).toHaveLength(1);
    const item = result.message.catalog.items[0];
    expect(item.descriptor.name).toBe('Dr UHI Deep Cardiologist');
    expect(item.fulfillment.slots.length).toBeGreaterThan(0);
    expect(item.fulfillment.slots[0]).toMatchObject({ date: APPT_DATE });
    // The on_search callback went out through the (mocked) gateway client and
    // was recorded as its own outbound leg.
    expect(sendUhiCallback).toHaveBeenCalledWith(expect.objectContaining({ action: 'on_search' }));
    const outbound = await prisma.$queryRawUnsafe(
      `SELECT status, ack FROM uhi_transactions
        WHERE tenant_id = $1::uuid AND message_id = 'msg-search' AND action = 'on_search'`,
      TENANT_ID,
    );
    expect(outbound).toEqual([{ status: 'processed', ack: 'ACK' }]);
  });

  let confirmedAppointmentId;

  it('books confirm through createAppointment — canonical timeline + audit inherited, evidence stamped', async () => {
    const ctx = context({ messageId: 'msg-confirm' });
    const body = {
      message: {
        order: {
          fulfillment: {
            agent: { id: String(doctorUserId) },
            start: { time: { timestamp: `${APPT_DATE}T10:00:00` } },
          },
          customer: { person: { name: 'UHI Deep Patient' }, contact: { phone: PATIENT_PHONE } },
        },
      },
    };
    const intake = await recordUhiLeg({
      tenantId: TENANT_ID,
      transactionId: ctx.transactionId,
      messageId: ctx.messageId,
      action: 'confirm',
      direction: 'inbound',
      payload: body,
      signatureVerified: true,
    });
    expect(intake.duplicate).toBe(false);

    const result = await handleUhiConfirm({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      context: ctx,
      body,
      legId: intake.row.id,
    });
    expect(result.error).toBeUndefined();
    confirmedAppointmentId = Number(result.appointment.id);

    // Real appointments row, tenant-scoped, through the real booking service.
    const appts = await prisma.$queryRawUnsafe(
      `SELECT patient_id, doctor_id, status, appointment_time FROM appointments
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_ID,
      confirmedAppointmentId,
    );
    expect(appts).toHaveLength(1);
    expect(appts[0]).toMatchObject({
      patient_id: patientId,
      doctor_id: doctorUserId,
      status: 'SCHEDULED',
      appointment_time: '10:00',
    });

    // THE INVARIANT: one canonical timeline row + audit row, written inside
    // createAppointment's transaction (root CLAUDE.md rule — inherited by
    // booking through the service instead of raw-inserting).
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid AND source_table = 'appointments'
          AND source_id = $2::text AND event_type = 'appointment.created'`,
      TENANT_ID,
      String(confirmedAppointmentId),
    );
    expect(timeline).toHaveLength(1);
    const audit = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_audit_events
        WHERE tenant_id = $1::uuid AND resource_type = 'appointment'
          AND resource_id = $2::text`,
      TENANT_ID,
      String(confirmedAppointmentId),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);

    // Evidence correlation on the confirm leg.
    const leg = await prisma.$queryRawUnsafe(
      `SELECT status, ack, appointment_id, booking_snapshot FROM uhi_transactions
        WHERE tenant_id = $1::uuid AND message_id = 'msg-confirm' AND action = 'confirm'`,
      TENANT_ID,
    );
    expect(leg).toHaveLength(1);
    expect(leg[0]).toMatchObject({ status: 'processed', ack: 'ACK' });
    expect(Number(leg[0].appointment_id)).toBe(confirmedAppointmentId);
    expect(leg[0].booking_snapshot).toMatchObject({
      appointment_id: confirmedAppointmentId,
      patient_uid: PATIENT_UID,
      slot: { date: APPT_DATE, time: '10:00' },
    });
    expect(sendUhiCallback).toHaveBeenCalledWith(expect.objectContaining({ action: 'on_confirm' }));
  });

  it('NACKs a confirm for an unregistered customer without booking anything', async () => {
    const ctx = context({ transactionId: 'uhi-txn-stranger', messageId: 'msg-stranger' });
    const body = {
      message: {
        order: {
          fulfillment: {
            agent: { id: String(doctorUserId) },
            start: { time: { timestamp: `${APPT_DATE}T11:00:00` } },
          },
          customer: { contact: { phone: '9111100000' } },
        },
      },
    };
    const intake = await recordUhiLeg({
      tenantId: TENANT_ID,
      transactionId: ctx.transactionId,
      messageId: ctx.messageId,
      action: 'confirm',
      direction: 'inbound',
      payload: body,
      signatureVerified: true,
    });
    const result = await handleUhiConfirm({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      context: ctx,
      body,
      legId: intake.row.id,
    });
    expect(result.error).toMatchObject({ code: 'UHI_PATIENT_NOT_REGISTERED' });
    const legs = await prisma.$queryRawUnsafe(
      `SELECT status, ack, error_code, appointment_id FROM uhi_transactions
        WHERE tenant_id = $1::uuid AND transaction_id = 'uhi-txn-stranger' AND action = 'confirm'`,
      TENANT_ID,
    );
    expect(legs[0]).toMatchObject({
      status: 'rejected',
      ack: 'NACK',
      error_code: 'UHI_PATIENT_NOT_REGISTERED',
      appointment_id: null,
    });
    const count = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM appointments
        WHERE tenant_id = $1::uuid AND appointment_time = '11:00'`,
      TENANT_ID,
    );
    expect(count[0].n).toBe(0);
  });

  it('cancels through the patient self-service transition path', async () => {
    const ctx = context({ messageId: 'msg-cancel' });
    const body = { message: { order_id: String(confirmedAppointmentId) } };
    const intake = await recordUhiLeg({
      tenantId: TENANT_ID,
      transactionId: ctx.transactionId,
      messageId: ctx.messageId,
      action: 'cancel',
      direction: 'inbound',
      payload: body,
      signatureVerified: true,
    });
    const result = await handleUhiCancel({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      context: ctx,
      body,
      legId: intake.row.id,
    });
    expect(result.error).toBeUndefined();
    const appts = await prisma.$queryRawUnsafe(
      `SELECT status FROM appointments WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_ID,
      confirmedAppointmentId,
    );
    expect(appts[0].status).toBe('CANCELLED');
    expect(sendUhiCallback).toHaveBeenCalledWith(expect.objectContaining({ action: 'on_cancel' }));
  });

  it('binds every leg to its resolved tenant — tenant B sees nothing of tenant A', async () => {
    const mine = await listUhiTransactions(TENANT_ID, {});
    expect(mine.transactions.length).toBeGreaterThanOrEqual(6);
    const other = await listUhiTransactions(OTHER_TENANT_ID, {});
    expect(other.transactions).toHaveLength(0);
    // And the raw table agrees (explicit predicate, not RLS-dependent).
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM uhi_transactions WHERE tenant_id = $1::uuid`,
      OTHER_TENANT_ID,
    );
    expect(rows[0].n).toBe(0);
  });
});
