// src/services/uhi/uhiAdapterService.js
//
// Thin UHI (Unified Health Interface / DHP-beckn) provider-side adapter
// (migration 705). One evidence + replay-dedupe row per protocol message leg
// in uhi_transactions; bookings land in the EXISTING appointments tables
// through appointmentService.createAppointment / transitionAppointment — the
// exact paths the patient portal uses — so the canonical clinical timeline +
// audit invariant is inherited, never re-implemented. UHI never grows a
// parallel booking store.
//
// PRE-RLS POSTURE: the webhook mount sits before tenant middleware, so every
// query here carries an explicit `tenant_id = $N::uuid` predicate and every
// INSERT writes tenant_id explicitly (never a GUC-reading default —
// backend-pre-rls-tenant-model rule; the 705 header documents the same).
//
// Replay model: the durable cross-replica dedupe authority is the table's own
// UNIQUE (tenant_id, environment, transaction_id, message_id, action) —
// INSERT ... ON CONFLICT DO NOTHING; a conflicting redelivery returns the
// existing row and the route answers a replay-safe ACK without reprocessing.
// `action` is in the key deliberately: beckn callbacks REUSE the originating
// message_id, so our outbound on_search shares (txn, msg) with the inbound
// search.

import { UHI_CONFIG } from '../../config/uhiConfig.js';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import appointmentService from '../appointment/appointmentService.js';
import { transitionAppointment } from '../appointment/appointmentLifecycleService.js';
import { sendUhiCallback } from './uhiGatewayClient.js';

export const UHI_ACTIONS = Object.freeze([
  'search', 'on_search', 'init', 'on_init', 'confirm', 'on_confirm',
  'status', 'on_status', 'cancel', 'on_cancel',
]);

const TXN_COLUMNS = `id, tenant_id, environment, transaction_id, message_id, action,
       direction, counterparty_subscriber_id, payload, signature_verified,
       verification_failure_reason, status, ack, error_code, error_message,
       appointment_id, booking_snapshot, received_at, processed_at, created_at, updated_at`;

function clean(value, max) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

/** Extracts the DHP context identifiers this adapter relies on. */
export function parseUhiContext(body) {
  const context = body?.context;
  if (!context || typeof context !== 'object') {
    throw AppError.badRequest('UHI message context is required', 'UHI_CONTEXT_REQUIRED');
  }
  const transactionId = clean(context.transaction_id, 120);
  const messageId = clean(context.message_id, 120);
  if (!transactionId || !messageId) {
    throw AppError.badRequest(
      'UHI context.transaction_id and context.message_id are required',
      'UHI_CONTEXT_IDS_REQUIRED',
    );
  }
  return {
    transactionId,
    messageId,
    action: clean(context.action, 20),
    // Provider (us / HSP) identity — the tenant-resolution key.
    providerId: clean(context.bpp_id ?? context.provider_id, 200),
    // Counterparty (EUA / gateway) identity + callback base.
    consumerId: clean(context.bap_id ?? context.consumer_id, 200),
    consumerUri: clean(context.bap_uri ?? context.consumer_uri, 500),
  };
}

/**
 * Records one message leg with the ON CONFLICT dedupe. Returns
 * { row, duplicate } — duplicate=true means the identical leg
 * (tenant, environment, txn, msg, action) already exists; the caller answers
 * a replay-safe ACK and does NOT reprocess.
 */
export async function recordUhiLeg({
  tenantId,
  environment = UHI_CONFIG.environment,
  transactionId,
  messageId,
  action,
  direction,
  counterpartySubscriberId = null,
  payload = {},
  signatureVerified = false,
  verificationFailureReason = null,
  status = 'received',
  ack = null,
  errorCode = null,
  errorMessage = null,
}) {
  if (!tenantId) throw AppError.internal('UHI leg requires a resolved tenant', 'UHI_TENANT_REQUIRED');
  if (!UHI_ACTIONS.includes(action)) {
    throw AppError.badRequest(`Unsupported UHI action: ${action}`, 'UHI_ACTION_INVALID');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO uhi_transactions (
       tenant_id, environment, transaction_id, message_id, action, direction,
       counterparty_subscriber_id, payload, signature_verified,
       verification_failure_reason, status, ack, error_code, error_message,
       processed_at
     )
     VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,
             $7::text, $8::jsonb, $9::boolean, $10::text, $11::text, $12::text,
             $13::text, $14::text,
             CASE WHEN $11::text IN ('processed', 'failed', 'rejected') THEN NOW() ELSE NULL END)
     ON CONFLICT ON CONSTRAINT uq_uhi_txn_leg DO NOTHING
     RETURNING ${TXN_COLUMNS}`,
    tenantId,
    environment,
    transactionId,
    messageId,
    action,
    direction,
    counterpartySubscriberId,
    JSON.stringify(payload ?? {}),
    signatureVerified === true,
    clean(verificationFailureReason, 300),
    status,
    ack,
    clean(errorCode, 80),
    clean(errorMessage, 500),
  );
  if (rows.length > 0) return { row: rows[0], duplicate: false };
  const existing = await prisma.$queryRawUnsafe(
    `SELECT ${TXN_COLUMNS} FROM uhi_transactions
      WHERE tenant_id = $1::uuid AND environment = $2::text
        AND transaction_id = $3::text AND message_id = $4::text AND action = $5::text
      LIMIT 1`,
    tenantId,
    environment,
    transactionId,
    messageId,
    action,
  );
  return { row: existing[0] ?? null, duplicate: true };
}

async function markLeg(tenantId, id, {
  status, ack = null, errorCode = null, errorMessage = null,
  appointmentId = null, bookingSnapshot = null,
}) {
  await prisma.$executeRawUnsafe(
    `UPDATE uhi_transactions
        SET status = $3::text,
            ack = COALESCE($4::text, ack),
            error_code = COALESCE($5::text, error_code),
            error_message = COALESCE($6::text, error_message),
            appointment_id = COALESCE($7::int, appointment_id),
            booking_snapshot = COALESCE($8::jsonb, booking_snapshot),
            processed_at = NOW(),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    tenantId,
    Number(id),
    status,
    ack,
    clean(errorCode, 80),
    clean(errorMessage, 500),
    appointmentId == null ? null : Number(appointmentId),
    bookingSnapshot == null ? null : JSON.stringify(bookingSnapshot),
  );
}

/* ─── catalog / slot helpers (thin, tenant-scoped, explicit predicates) ──── */

async function listDoctorsForCatalog(tenantId, { specialty = null, name = null } = {}) {
  return prisma.$queryRawUnsafe(
    `SELECT doc.id AS doctor_id, doc.user_id, doc.department, doc.specialty,
            doc.available_days, doc.available_hours, u.name AS doctor_name
       FROM doctors doc
       JOIN users u ON u.id = doc.user_id AND u.tenant_id = $1::uuid
      WHERE doc.tenant_id = $1::uuid
        AND u.is_active = TRUE
        AND ($2::text IS NULL OR LOWER(COALESCE(doc.specialty, '')) LIKE '%' || LOWER($2::text) || '%'
             OR LOWER(COALESCE(doc.department, '')) LIKE '%' || LOWER($2::text) || '%')
        AND ($3::text IS NULL OR LOWER(u.name) LIKE '%' || LOWER($3::text) || '%')
      ORDER BY u.name ASC
      LIMIT 50`,
    tenantId,
    clean(specialty, 120),
    clean(name, 120),
  );
}

async function findBookedTimes(tenantId, doctorUserId, date) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT appointment_time FROM appointments
      WHERE tenant_id = $1::uuid
        AND doctor_id = $2::int
        AND DATE(appointment_date) = DATE($3::date)
        AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')`,
    tenantId,
    Number(doctorUserId),
    date,
  );
  return new Set(rows.map((r) => r.appointment_time));
}

function generateSlots(doctor, date, bookedTimes) {
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(`${date}T00:00:00`).getDay()
  ];
  if (Array.isArray(doctor.available_days) && doctor.available_days.length > 0
      && !doctor.available_days.includes(dayName)) {
    return [];
  }
  const hours = doctor.available_hours?.[dayName] ?? { start: '09:00', end: '17:00' };
  const [startH, startM] = String(hours.start || '09:00').split(':').map(Number);
  const [endH, endM] = String(hours.end || '17:00').split(':').map(Number);
  const slots = [];
  let current = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  while (current < endMinutes) {
    const time = `${String(Math.floor(current / 60)).padStart(2, '0')}:${String(current % 60).padStart(2, '0')}`;
    if (!bookedTimes.has(time)) slots.push(time);
    current += 30;
  }
  return slots;
}

function buildContextReply(context, action) {
  return {
    domain: UHI_CONFIG.domain,
    country: UHI_CONFIG.country,
    city: UHI_CONFIG.city,
    action,
    transaction_id: context.transactionId,
    message_id: context.messageId,
    bpp_id: context.providerId,
    bap_id: context.consumerId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Sends an outbound on_* callback and records it as its own uhi_transactions
 * leg (direction outbound; signature_verified=true by construction — we sign
 * it). Delivery failure marks the outbound leg failed but never throws: the
 * inbound leg was already processed and acknowledged.
 */
async function dispatchCallback({ tenantId, environment, context, action, message, error: errorBody }) {
  const body = {
    context: buildContextReply(context, action),
    ...(message ? { message } : {}),
    ...(errorBody ? { error: errorBody } : {}),
  };
  const { row, duplicate } = await recordUhiLeg({
    tenantId,
    environment,
    transactionId: context.transactionId,
    messageId: context.messageId,
    action,
    direction: 'outbound',
    counterpartySubscriberId: context.consumerId,
    payload: body,
    signatureVerified: true,
    status: 'received',
  });
  if (duplicate) return { row, delivered: false, duplicate: true };
  const delivery = await sendUhiCallback({ action, targetUrl: context.consumerUri, body });
  await markLeg(tenantId, row.id, delivery.ok
    ? { status: 'processed', ack: 'ACK' }
    : { status: 'failed', errorCode: 'UHI_CALLBACK_DELIVERY_FAILED', errorMessage: delivery.error });
  return { row, delivered: delivery.ok, duplicate: false };
}

/* ─── inbound leg handlers ───────────────────────────────────────────────── */

/**
 * search → catalog of matching doctors + open slots → on_search.
 */
export async function handleUhiSearch({ tenantId, environment, context, body }) {
  const intent = body?.message?.intent ?? {};
  const specialty = intent?.fulfillment?.agent?.speciality
    ?? intent?.item?.descriptor?.name
    ?? intent?.speciality
    ?? null;
  const doctorName = intent?.fulfillment?.agent?.name ?? null;
  const date = clean(intent?.fulfillment?.start?.time?.timestamp, 10)
    ?? new Date().toISOString().slice(0, 10);

  const doctors = await listDoctorsForCatalog(tenantId, { specialty, name: doctorName });
  const items = [];
  for (const doctor of doctors) {
    const booked = await findBookedTimes(tenantId, doctor.user_id, date);
    const slots = generateSlots(doctor, date, booked);
    items.push({
      id: String(doctor.doctor_id),
      descriptor: { name: doctor.doctor_name },
      fulfillment: {
        agent: {
          id: String(doctor.doctor_id),
          name: doctor.doctor_name,
          speciality: doctor.specialty ?? doctor.department ?? null,
        },
        slots: slots.map((time) => ({ date, time })),
      },
    });
  }
  const message = {
    catalog: {
      descriptor: { name: 'VH Health appointment catalog' },
      items,
    },
  };
  const callback = await dispatchCallback({ tenantId, environment, context, action: 'on_search', message });
  return { message, callback };
}

/**
 * init → soft slot validation + quote → on_init. No hold rows (thin scope —
 * a durable hold is a follow-up if UHI volume ever materializes).
 */
export async function handleUhiInit({ tenantId, environment, context, body }) {
  const order = body?.message?.order ?? {};
  const { doctorId, date, time } = parseOrderSlot(order);
  const availability = await checkSlotAvailability(tenantId, doctorId, date, time);
  if (!availability.available) {
    const errorBody = { code: availability.code, message: availability.reason };
    const callback = await dispatchCallback({ tenantId, environment, context, action: 'on_init', error: errorBody });
    return { error: errorBody, callback };
  }
  const message = {
    order: {
      ...order,
      state: 'INITIALIZED',
      quote: { price: { currency: 'INR', value: '0' } },
    },
  };
  const callback = await dispatchCallback({ tenantId, environment, context, action: 'on_init', message });
  return { message, callback };
}

/**
 * confirm → book through appointmentService.createAppointment (the portal's
 * path — canonical clinical timeline + audit rows are recorded inside that
 * service's transaction), stamp the confirm evidence row with
 * appointment_id + booking_snapshot, reply on_confirm.
 *
 * Patient identity: the confirm order carries customer name/phone. This thin
 * adapter resolves an EXISTING registered patient by phone within the tenant
 * and NACKs unregistered customers (UHI_PATIENT_NOT_REGISTERED) rather than
 * auto-creating identities — resolve-or-create through the guarded front-desk
 * registration path is the flagged open product decision.
 */
export async function handleUhiConfirm({ tenantId, environment, context, body, legId }) {
  const order = body?.message?.order ?? {};
  const { doctorId, date, time } = parseOrderSlot(order);
  const customerPhone = order?.customer?.contact?.phone
    ?? order?.fulfillment?.customer?.contact?.phone
    ?? null;
  if (!customerPhone) {
    throw AppError.badRequest('UHI confirm requires customer contact phone', 'UHI_CUSTOMER_PHONE_REQUIRED');
  }
  const phone = normalizePhone(String(customerPhone));
  const patients = await prisma.$queryRawUnsafe(
    `SELECT id, uid, name, phone FROM users
      WHERE tenant_id = $1::uuid AND role = 'PATIENT' AND is_active = TRUE
        AND (phone = $2::text OR phone = '+' || $2::text OR RIGHT(phone, 10) = RIGHT($2::text, 10))
      ORDER BY id ASC
      LIMIT 1`,
    tenantId,
    phone,
  );
  const patient = patients[0];
  if (!patient) {
    const errorBody = {
      code: 'UHI_PATIENT_NOT_REGISTERED',
      message: 'No registered patient matches the confirm customer contact',
    };
    await markLeg(tenantId, legId, {
      status: 'rejected', ack: 'NACK', errorCode: errorBody.code, errorMessage: errorBody.message,
    });
    const callback = await dispatchCallback({ tenantId, environment, context, action: 'on_confirm', error: errorBody });
    return { error: errorBody, callback };
  }

  const appointment = await appointmentService.createAppointment({
    patient_id: patient.id,
    doctor_id: doctorId,
    appointment_date: date,
    appointment_time: time,
    reason: clean(order?.fulfillment?.reason ?? 'UHI network booking', 500),
    tenant_id: tenantId,
  }, {
    // The booking arrives on the patient's behalf (their EUA sent the
    // confirm) — attribute the evidence to the resolved patient identity.
    actorUid: patient.uid,
    actorId: Number(patient.id),
    actorRole: 'PATIENT',
    source: 'uhi',
  });

  const bookingSnapshot = {
    appointment_id: Number(appointment.id),
    patient_uid: appointment.patient_uid ?? patient.uid,
    doctor_id: appointment.doctor_id ?? null,
    slot: { date, time },
    booked_at: new Date().toISOString(),
  };
  await markLeg(tenantId, legId, {
    status: 'processed',
    ack: 'ACK',
    appointmentId: Number(appointment.id),
    bookingSnapshot,
  });
  const message = {
    order: {
      ...order,
      id: String(appointment.id),
      state: 'CONFIRMED',
    },
  };
  const callback = await dispatchCallback({ tenantId, environment, context, action: 'on_confirm', message });
  return { appointment, bookingSnapshot, message, callback };
}

/** status → read model over the transaction's confirmed appointment → on_status. */
export async function handleUhiStatus({ tenantId, environment, context }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT t.appointment_id, a.status AS appointment_status
       FROM uhi_transactions t
       LEFT JOIN appointments a
         ON a.id = t.appointment_id AND a.tenant_id = $1::uuid
      WHERE t.tenant_id = $1::uuid AND t.transaction_id = $2::text
        AND t.action = 'confirm' AND t.appointment_id IS NOT NULL
      ORDER BY t.id DESC
      LIMIT 1`,
    tenantId,
    context.transactionId,
  );
  const correlated = rows[0] ?? null;
  const message = correlated
    ? {
      order: {
        id: String(correlated.appointment_id),
        state: correlated.appointment_status ?? 'UNKNOWN',
      },
    }
    : null;
  const errorBody = correlated
    ? null
    : { code: 'UHI_ORDER_NOT_FOUND', message: 'No confirmed booking for this transaction' };
  const callback = await dispatchCallback({
    tenantId, environment, context, action: 'on_status', message, error: errorBody,
  });
  return { message, error: errorBody, callback };
}

/**
 * cancel → transitionAppointment to CANCELLED (canonical timeline + audit
 * inherited from appointmentLifecycleService) → on_cancel.
 */
export async function handleUhiCancel({ tenantId, environment, context, body, legId }) {
  const orderId = Number.parseInt(
    body?.message?.order_id ?? body?.message?.order?.id ?? '',
    10,
  );
  const rows = await prisma.$queryRawUnsafe(
    `SELECT appointment_id FROM uhi_transactions
      WHERE tenant_id = $1::uuid AND transaction_id = $2::text
        AND action = 'confirm' AND appointment_id IS NOT NULL
      ORDER BY id DESC
      LIMIT 1`,
    tenantId,
    context.transactionId,
  );
  const appointmentId = Number.isInteger(orderId) && orderId > 0
    ? orderId
    : (rows[0]?.appointment_id ?? null);
  if (!appointmentId || (rows[0] && Number(rows[0].appointment_id) !== Number(appointmentId))) {
    const errorBody = {
      code: 'UHI_ORDER_NOT_FOUND',
      message: 'No confirmed booking for this transaction',
    };
    await markLeg(tenantId, legId, {
      status: 'rejected', ack: 'NACK', errorCode: errorBody.code, errorMessage: errorBody.message,
    });
    const callback = await dispatchCallback({ tenantId, environment, context, action: 'on_cancel', error: errorBody });
    return { error: errorBody, callback };
  }
  const reason = clean(body?.message?.cancellation_reason_id ?? 'UHI network cancellation', 500);
  // The network cancel arrives on the patient's behalf (their EUA sent it):
  // resolve the booked patient and run the SAME patient self-service cancel
  // path the portal uses — authorizeAppointmentTransitionTx verifies the
  // actor row and ownership, and the canonical timeline + audit evidence is
  // recorded by transitionAppointment itself.
  const owners = await prisma.$queryRawUnsafe(
    `SELECT u.id, u.uid FROM appointments a
       JOIN users u ON u.id = a.patient_id AND u.tenant_id = $1::uuid
      WHERE a.id = $2::int AND a.tenant_id = $1::uuid
      LIMIT 1`,
    tenantId,
    Number(appointmentId),
  );
  if (!owners[0]) {
    const errorBody = {
      code: 'UHI_ORDER_NOT_FOUND',
      message: 'No confirmed booking for this transaction',
    };
    await markLeg(tenantId, legId, {
      status: 'rejected', ack: 'NACK', errorCode: errorBody.code, errorMessage: errorBody.message,
    });
    const callback = await dispatchCallback({ tenantId, environment, context, action: 'on_cancel', error: errorBody });
    return { error: errorBody, callback };
  }
  await transitionAppointment({
    tenantId,
    appointmentId: Number(appointmentId),
    toStatus: 'CANCELLED',
    actorUid: owners[0].uid,
    actorId: Number(owners[0].id),
    actorRole: 'PATIENT',
    reason,
    source: 'cancel',
  });
  await markLeg(tenantId, legId, { status: 'processed', ack: 'ACK' });
  const message = { order: { id: String(appointmentId), state: 'CANCELLED' } };
  const callback = await dispatchCallback({ tenantId, environment, context, action: 'on_cancel', message });
  return { message, callback };
}

/* ─── shared helpers ─────────────────────────────────────────────────────── */

function parseOrderSlot(order) {
  const doctorId = Number.parseInt(
    order?.fulfillment?.agent?.id ?? order?.item?.id ?? order?.items?.[0]?.id ?? '',
    10,
  );
  const timestamp = order?.fulfillment?.start?.time?.timestamp ?? null;
  if (!Number.isInteger(doctorId) || doctorId < 1 || !timestamp) {
    throw AppError.badRequest(
      'UHI order requires fulfillment.agent.id and fulfillment.start.time.timestamp',
      'UHI_ORDER_SLOT_REQUIRED',
    );
  }
  const dt = new Date(timestamp);
  if (Number.isNaN(dt.getTime())) {
    throw AppError.badRequest('UHI order slot timestamp is invalid', 'UHI_ORDER_SLOT_INVALID');
  }
  // Take date/time from the LITERAL string when it is ISO-shaped: the slot
  // vocabulary is the hospital's local wall clock (appointments store
  // 'HH:MM' strings), and a UTC round-trip could shift the date across
  // midnight for a sender in another zone.
  const raw = String(timestamp);
  const literal = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(raw);
  const iso = dt.toISOString();
  return {
    doctorId,
    date: literal ? literal[1] : iso.slice(0, 10),
    time: literal ? literal[2] : iso.slice(11, 16),
  };
}

async function checkSlotAvailability(tenantId, doctorId, date, time) {
  const doctors = await prisma.$queryRawUnsafe(
    `SELECT doc.id, doc.user_id FROM doctors doc
      WHERE doc.tenant_id = $1::uuid AND (doc.id = $2::int OR doc.user_id = $2::int)
      LIMIT 1`,
    tenantId,
    doctorId,
  );
  if (!doctors[0]) {
    return { available: false, code: 'UHI_DOCTOR_NOT_FOUND', reason: 'Doctor not found' };
  }
  const booked = await findBookedTimes(tenantId, doctors[0].user_id, date);
  if (booked.has(time)) {
    return { available: false, code: 'UHI_SLOT_UNAVAILABLE', reason: 'Slot no longer available' };
  }
  return { available: true };
}

/** Admin evidence list (ops debugging surface; admin-role-gated in routes). */
export async function listUhiTransactions(tenantId, {
  status = '', action = '', transactionId = '', limit = 100, offset = 0,
} = {}) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const statusFilter = clean(status, 20)?.toLowerCase() ?? '';
  const actionFilter = clean(action, 20)?.toLowerCase() ?? '';
  if (actionFilter && !UHI_ACTIONS.includes(actionFilter)) {
    throw AppError.badRequest(`action must be one of: ${UHI_ACTIONS.join(', ')}`, 'UHI_ACTION_INVALID');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${TXN_COLUMNS}
       FROM uhi_transactions
      WHERE tenant_id = $1::uuid
        AND ($2::text = '' OR status = $2::text)
        AND ($3::text = '' OR action = $3::text)
        AND ($4::text = '' OR transaction_id = $4::text)
      ORDER BY received_at DESC, id DESC
      LIMIT $5::int OFFSET $6::int`,
    tenantId,
    statusFilter,
    actionFilter,
    clean(transactionId, 120) ?? '',
    safeLimit,
    safeOffset,
  );
  return {
    transactions: rows.map((row) => ({
      id: Number(row.id),
      environment: row.environment,
      transactionId: row.transaction_id,
      messageId: row.message_id,
      action: row.action,
      direction: row.direction,
      counterpartySubscriberId: row.counterparty_subscriber_id ?? null,
      signatureVerified: row.signature_verified === true,
      verificationFailureReason: row.verification_failure_reason ?? null,
      status: row.status,
      ack: row.ack ?? null,
      errorCode: row.error_code ?? null,
      errorMessage: row.error_message ?? null,
      appointmentId: row.appointment_id == null ? null : Number(row.appointment_id),
      receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
      processedAt: row.processed_at instanceof Date ? row.processed_at.toISOString() : row.processed_at,
    })),
    limit: safeLimit,
    offset: safeOffset,
  };
}

export { markLeg as markUhiLeg };

export default {
  UHI_ACTIONS,
  parseUhiContext,
  recordUhiLeg,
  markUhiLeg: markLeg,
  handleUhiSearch,
  handleUhiInit,
  handleUhiConfirm,
  handleUhiStatus,
  handleUhiCancel,
  listUhiTransactions,
};

// Re-exported for tests that need the internal helper shapes.
export const __testing__ = {
  parseOrderSlot,
  generateSlots,
  buildContextReply,
};
