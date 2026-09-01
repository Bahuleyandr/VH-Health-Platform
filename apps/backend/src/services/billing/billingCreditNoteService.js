import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  advanceBillingCreditNoteObligationTx,
  advanceBillingCreditNoteRefundObligationTx,
  completeBillingCreditNoteObligationTx,
  materializeBillingCreditNoteObligationTx,
} from '../ipd/wardIndentObligationService.js';
import {
  calculateInvoiceRefundHeadroomTx,
  deriveInvoicePaymentStateFromLedgerTx,
} from './billingV2Service.js';
import { resolveLedgerWiring } from './ledger/ledgerAuthoritativeMode.js';
import { postWardMedicationCreditEntry } from './ledger/ledgerPostings.js';

const CREDIT_NOTE_STATUSES = new Set(['pending', 'approved', 'rejected', 'applied']);
const REFUND_MODES = new Set([
  'CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET',
]);
const COMMAND_REPLAY_EXPECTATIONS = Object.freeze({
  approve: {
    actorField: 'approved_by',
    eventType: 'approved',
    statuses: new Set(['approved', 'applied']),
  },
  reject: {
    actorField: 'rejected_by',
    eventType: 'rejected',
    statuses: new Set(['rejected']),
  },
  apply: {
    actorField: 'applied_by',
    eventType: 'applied',
    statuses: new Set(['applied']),
  },
});

function positiveId(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function positiveBigInt(value, fieldName) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw AppError.badRequest(
      `${fieldName} must be sent as a decimal string above the JavaScript safe-integer range`,
    );
  }
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  const parsed = BigInt(text);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw AppError.badRequest(`${fieldName} exceeds the signed 64-bit range`);
  }
  return parsed;
}

function actorUid(value) {
  const text = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest('actorUid must be a UUID');
  }
  return text;
}

function requiredText(value, fieldName, max = 2000) {
  const text = String(value || '').trim();
  if (!text) throw AppError.badRequest(`${fieldName} is required`);
  return text.slice(0, max);
}

function eventKey(scope, id, commandKey) {
  const command = requiredText(commandKey, 'Idempotency-Key', 1000);
  const candidate = `billing-credit-note:${id}:${scope}:${command}`;
  if (candidate.length <= 200) return candidate;
  return `billing-credit-note:${id}:${scope}:${createHash('sha256').update(candidate).digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestBodySha256(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function normalizeBigInt(value) {
  if (typeof value !== 'bigint') return value;
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function normalizeCreditNote(row) {
  if (!row) return row;
  const normalized = { ...row };
  for (const field of [
    'id',
    'source_financial_event_id',
    'amount_minor',
    'receivable_credit_minor',
    'refund_obligation_minor',
  ]) {
    normalized[field] = normalizeBigInt(normalized[field]);
  }
  if (Array.isArray(normalized.events)) {
    normalized.events = normalized.events.map((event) => ({
      ...event,
      id: normalizeBigInt(event.id),
      credit_note_id: normalizeBigInt(event.credit_note_id),
    }));
  }
  return normalized;
}

async function lockCreditNote(tx, tenantId, creditNoteId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT note.*, invoice.status AS invoice_status,
            invoice.total_amount, invoice.credit_note_amount,
            invoice.amount_paid, invoice.amount_due
       FROM billing_credit_notes note
       JOIN billing_invoices invoice
         ON invoice.tenant_id = note.tenant_id
        AND invoice.id = note.invoice_id
      WHERE note.tenant_id = $1::uuid
        AND note.id = $2::bigint
      FOR UPDATE OF note, invoice`,
    tenantId,
    positiveBigInt(creditNoteId, 'creditNoteId'),
  );
  if (!rows[0]) throw AppError.notFound('Billing credit note not found');
  return rows[0];
}

async function loadCreditNoteTx(tx, tenantId, creditNoteId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT note.*,
            invoice.invoice_number,
            invoice.status AS invoice_status,
            invoice.total_amount,
            invoice.credit_note_amount,
            invoice.amount_paid,
            invoice.amount_due,
            financial.ward_indent_id,
            financial.ward_indent_item_id,
            financial.ward_indent_state_version,
            financial.clinical_order_id,
            financial.quantity,
            financial.unit_price_minor,
            financial.pricing_snapshot,
            indent.indent_number,
            indent.status AS ward_indent_status,
            indent.state_version AS current_ward_indent_state_version,
            indent.encounter_id
       FROM billing_credit_notes note
       JOIN billing_invoices invoice
         ON invoice.tenant_id = note.tenant_id
        AND invoice.id = note.invoice_id
       JOIN ward_indent_financial_events financial
         ON financial.tenant_id = note.tenant_id
        AND financial.id = note.source_financial_event_id
       JOIN ward_indents indent
         ON indent.tenant_id = financial.tenant_id
        AND indent.id = financial.ward_indent_id
      WHERE note.tenant_id = $1::uuid
        AND note.id = $2::bigint
      LIMIT 1`,
    tenantId,
    positiveBigInt(creditNoteId, 'creditNoteId'),
  );
  if (!rows[0]) return null;
  const events = await tx.$queryRawUnsafe(
    `SELECT *
       FROM billing_credit_note_events
      WHERE tenant_id = $1::uuid
        AND credit_note_id = $2::bigint
      ORDER BY occurred_at, id`,
    tenantId,
    positiveBigInt(creditNoteId, 'creditNoteId'),
  );
  const refund = rows[0].refund_id == null
    ? null
    : (await tx.$queryRawUnsafe(
      `SELECT *
         FROM billing_refunds
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        LIMIT 1`,
      tenantId,
      Number(rows[0].refund_id),
    ))[0] || null;
  return normalizeCreditNote({ ...rows[0], events, refund });
}

async function replayForEvent(
  tx,
  tenantId,
  creditNoteId,
  scope,
  commandKey,
  actor,
  requestBody,
) {
  const key = eventKey(scope, creditNoteId, commandKey);
  const requestHash = requestBodySha256(requestBody);
  const expectation = COMMAND_REPLAY_EXPECTATIONS[scope];
  if (!expectation) {
    throw AppError.internal(
      'Credit-note idempotency scope is not registered',
      'BILLING_CREDIT_NOTE_IDEMPOTENCY_SCOPE_INVALID',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT credit_note_id, event_type, actor_uid, request_body_sha256
       FROM billing_credit_note_events
      WHERE tenant_id = $1::uuid
        AND command_key = $2::text
      LIMIT 1`,
    tenantId,
    key,
  );
  if (!rows[0]) return { key, requestHash, replay: null };
  if (String(rows[0].actor_uid).toLowerCase() !== String(actor).toLowerCase()) {
    throw AppError.conflict(
      'Idempotency key was already used by another credit-note actor',
      'BILLING_CREDIT_NOTE_IDEMPOTENCY_ACTOR_CONFLICT',
    );
  }
  if (String(rows[0].request_body_sha256).trim() !== requestHash) {
    throw AppError.conflict(
      'Idempotency key was already used with a different credit-note command payload',
      'BILLING_CREDIT_NOTE_IDEMPOTENCY_PAYLOAD_CONFLICT',
    );
  }
  const replay = await loadCreditNoteTx(tx, tenantId, creditNoteId);
  if (
    String(rows[0].credit_note_id) !== String(positiveBigInt(creditNoteId, 'creditNoteId'))
    || rows[0].event_type !== expectation.eventType
    || !replay
    || !expectation.statuses.has(replay.status)
    || String(replay[expectation.actorField]).toLowerCase() !== String(actor).toLowerCase()
    || (scope === 'apply' && replay.application_key !== key)
  ) {
    throw AppError.conflict(
      'Idempotency event does not match the requested credit-note command state',
      'BILLING_CREDIT_NOTE_IDEMPOTENCY_STATE_CONFLICT',
    );
  }
  return { key, requestHash, replay };
}

async function insertLifecycleEvent(tx, {
  tenantId,
  creditNoteId,
  eventType,
  actor,
  commandKey,
  requestBody,
  details = {},
}) {
  const requestHash = requestBodySha256(requestBody ?? {
    event_type: eventType,
    details,
  });
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO billing_credit_note_events
       (tenant_id, credit_note_id, event_type, actor_uid, command_key,
        request_body_sha256, details)
     VALUES ($1::uuid, $2::bigint, $3::text, $4::uuid, $5::text, $6::text, $7::jsonb)
     RETURNING id, credit_note_id, event_type, actor_uid,
               request_body_sha256, occurred_at`,
    tenantId,
    BigInt(creditNoteId),
    eventType,
    actor,
    commandKey,
    requestHash,
    JSON.stringify(details),
  );
  return rows[0];
}

async function loadRefundTenderHeadroomTx(tx, tenantId, invoiceId) {
  const rows = await tx.$queryRawUnsafe(
    `WITH gross_rows AS (
       SELECT NULLIF(UPPER(BTRIM(payment.mode)), '') AS mode,
              payment.amount
         FROM billing_payments payment
        WHERE payment.tenant_id = $1::uuid
          AND payment.invoice_id = $2::int
          AND payment.reversed = FALSE
       UNION ALL
       SELECT NULLIF(UPPER(BTRIM(advance.mode)), '') AS mode,
              settlement.amount
         FROM billing_advance_settlements settlement
         JOIN billing_advances advance
           ON advance.tenant_id = $1::uuid
          AND advance.id = settlement.advance_id
        WHERE settlement.tenant_id = $1::uuid
          AND settlement.invoice_id = $2::int
     ), gross_by_mode AS (
       SELECT mode, COALESCE(SUM(amount), 0)::numeric AS gross_paid
         FROM gross_rows
        WHERE mode IS NOT NULL
        GROUP BY mode
     ), refunds_by_mode AS (
       SELECT NULLIF(UPPER(BTRIM(refund.mode)), '') AS mode,
              COALESCE(SUM(refund.amount), 0)::numeric AS active_refunds
         FROM billing_refunds refund
        WHERE refund.tenant_id = $1::uuid
          AND refund.invoice_id = $2::int
          AND refund.approval_status <> 'REJECTED'
        GROUP BY NULLIF(UPPER(BTRIM(refund.mode)), '')
     ), modes AS (
       SELECT mode FROM gross_by_mode
       UNION
       SELECT mode FROM refunds_by_mode WHERE mode IS NOT NULL
     )
     SELECT modes.mode,
            COALESCE(gross.gross_paid, 0)::numeric AS gross_paid,
            COALESCE(refunds.active_refunds, 0)::numeric AS active_refunds,
            GREATEST(
              COALESCE(gross.gross_paid, 0) - COALESCE(refunds.active_refunds, 0),
              0
            )::numeric AS refundable
       FROM modes
       LEFT JOIN gross_by_mode gross ON gross.mode = modes.mode
       LEFT JOIN refunds_by_mode refunds ON refunds.mode = modes.mode
      ORDER BY modes.mode`,
    tenantId,
    Number(invoiceId),
  );
  return rows.map((row) => ({
    mode: String(row.mode),
    gross_paid_minor: Math.round(Number(row.gross_paid || 0) * 100),
    active_refunds_minor: Math.round(Number(row.active_refunds || 0) * 100),
    refundable_minor: Math.round(Number(row.refundable || 0) * 100),
  }));
}

export async function createBillingCreditNoteFromFinancialEventTx(tx, {
  tenantId,
  sourceFinancialEventId,
  raisedBy,
  reason,
  eventKeyPrefix,
}) {
  const tid = requireTenantId(tenantId);
  const sourceId = positiveBigInt(sourceFinancialEventId, 'sourceFinancialEventId');
  const actor = actorUid(raisedBy);
  const cleanReason = requiredText(reason, 'reason');
  const existing = await tx.$queryRawUnsafe(
    `SELECT id
       FROM billing_credit_notes
      WHERE tenant_id = $1::uuid
        AND source_financial_event_id = $2::bigint
      LIMIT 1`,
    tid,
    sourceId,
  );
  if (existing[0]) return loadCreditNoteTx(tx, tid, existing[0].id);

  const sourceRows = await tx.$queryRawUnsafe(
    `SELECT financial.*, invoice.patient_uid, invoice.status AS invoice_status,
            invoice.total_amount, invoice.credit_note_amount,
            invoice.amount_paid, invoice.amount_due
       FROM ward_indent_financial_events financial
       JOIN billing_invoices invoice
         ON invoice.tenant_id = financial.tenant_id
        AND invoice.id = financial.invoice_id
      WHERE financial.tenant_id = $1::uuid
        AND financial.id = $2::bigint
        AND financial.event_kind = 'credit'
      FOR UPDATE OF invoice`,
    tid,
    sourceId,
  );
  const source = sourceRows[0];
  if (!source) {
    throw AppError.conflict(
      'Credit-note source must be an invoice-linked ward-indent credit event',
      'BILLING_CREDIT_NOTE_SOURCE_INVALID',
    );
  }
  const amountMinor = Math.abs(Number(source.amount_minor));
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw AppError.conflict('Credit-note source amount is invalid', 'BILLING_CREDIT_NOTE_SOURCE_INVALID');
  }
  const draft = source.invoice_status === 'DRAFT';
  const number = `CN-WI-${sourceId}`;
  const baseKey = requiredText(eventKeyPrefix, 'eventKeyPrefix', 120);
  const insertRows = await tx.$queryRawUnsafe(
    `INSERT INTO billing_credit_notes
       (tenant_id, credit_note_number, invoice_id, patient_uid,
        source_financial_event_id, amount_minor, currency, reason, status,
        raised_by, approved_by, approved_at, applied_by, applied_at,
        application_key, receivable_credit_minor, refund_obligation_minor)
     VALUES (
       $1::uuid, $2::text, $3::int, $4::uuid,
       $5::bigint, $6::bigint, $7::text, $8::text, $9::text,
       $10::uuid,
       CASE WHEN $11::boolean THEN $10::uuid ELSE NULL END,
       CASE WHEN $11::boolean THEN NOW() ELSE NULL END,
       CASE WHEN $11::boolean THEN $10::uuid ELSE NULL END,
       CASE WHEN $11::boolean THEN NOW() ELSE NULL END,
       CASE WHEN $11::boolean THEN $12::text ELSE NULL END,
       CASE WHEN $11::boolean THEN $6::bigint ELSE 0 END,
       0
     )
     ON CONFLICT (tenant_id, source_financial_event_id) DO NOTHING
     RETURNING *`,
    tid,
    number,
    Number(source.invoice_id),
    String(source.patient_uid),
    sourceId,
    BigInt(amountMinor),
    String(source.currency),
    cleanReason,
    draft ? 'applied' : 'pending',
    actor,
    draft,
    `${baseKey}:applied`,
  );
  const note = insertRows[0];
  if (!note) {
    const concurrent = await tx.$queryRawUnsafe(
      `SELECT id
         FROM billing_credit_notes
        WHERE tenant_id = $1::uuid
          AND source_financial_event_id = $2::bigint
        LIMIT 1`,
      tid,
      sourceId,
    );
    if (!concurrent[0]) {
      throw AppError.conflict(
        'Credit-note source was projected concurrently but cannot be reloaded',
        'BILLING_CREDIT_NOTE_PROJECTION_CONFLICT',
      );
    }
    return loadCreditNoteTx(tx, tid, concurrent[0].id);
  }
  const raisedEvent = await insertLifecycleEvent(tx, {
    tenantId: tid,
    creditNoteId: note.id,
    eventType: 'raised',
    actor,
    commandKey: `${baseKey}:raised`,
    details: { source_financial_event_id: String(sourceId), auto_applied_draft: draft },
  });
  let appliedEvent = null;
  if (draft) {
    await insertLifecycleEvent(tx, {
      tenantId: tid,
      creditNoteId: note.id,
      eventType: 'approved',
      actor,
      commandKey: `${baseKey}:approved`,
      details: { authority: 'draft_invoice_projection' },
    });
    appliedEvent = await insertLifecycleEvent(tx, {
      tenantId: tid,
      creditNoteId: note.id,
      eventType: 'applied',
      actor,
      commandKey: `${baseKey}:applied`,
      details: { receivable_credit_minor: amountMinor, refund_obligation_minor: 0 },
    });
    const updated = await tx.$queryRawUnsafe(
      `UPDATE billing_invoices
          SET credit_note_amount = credit_note_amount + ($1::numeric / 100),
              amount_due = GREATEST(
                total_amount - (credit_note_amount + ($1::numeric / 100)) - amount_paid,
                0
              ),
              updated_at = NOW()
        WHERE tenant_id = $2::uuid
          AND id = $3::int
          AND status = 'DRAFT'
          AND credit_note_amount + ($1::numeric / 100) <= total_amount + 0.005
        RETURNING id`,
      amountMinor,
      tid,
      Number(source.invoice_id),
    );
    if (!updated[0]) {
      throw AppError.conflict(
        'Draft invoice credit exceeds the invoice total or changed concurrently',
        'BILLING_CREDIT_NOTE_PROJECTION_CONFLICT',
      );
    }
  }
  const created = await loadCreditNoteTx(tx, tid, note.id);
  if (!draft) {
    await materializeBillingCreditNoteObligationTx(tx, {
      creditNote: created,
      actorUid: actor,
      sourceEvent: raisedEvent,
    });
  } else {
    await completeBillingCreditNoteObligationTx(tx, {
      creditNote: created,
      lifecycleEvent: appliedEvent,
      evidenceKind: 'billing_credit_note_application',
      actorUid: actor,
    });
  }
  return loadCreditNoteTx(tx, tid, note.id);
}

export async function listBillingCreditNotes({
  tenantId,
  status = null,
  invoiceId = null,
  limit = 100,
} = {}) {
  const tid = requireTenantId(tenantId);
  const cleanStatus = status == null ? null : String(status).trim().toLowerCase();
  if (cleanStatus && !CREDIT_NOTE_STATUSES.has(cleanStatus)) {
    throw AppError.badRequest('Invalid billing credit-note status');
  }
  const cleanInvoiceId = invoiceId == null ? null : positiveId(invoiceId, 'invoiceId');
  const cleanLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT note.*, invoice.invoice_number, invoice.status AS invoice_status,
              financial.ward_indent_id, financial.ward_indent_item_id,
              refund.approval_status AS refund_approval_status,
              refund.payout_rail AS refund_payout_rail
         FROM billing_credit_notes note
         JOIN billing_invoices invoice
           ON invoice.tenant_id = note.tenant_id
          AND invoice.id = note.invoice_id
         JOIN ward_indent_financial_events financial
           ON financial.tenant_id = note.tenant_id
          AND financial.id = note.source_financial_event_id
         LEFT JOIN billing_refunds refund
           ON refund.tenant_id = note.tenant_id
          AND refund.id = note.refund_id
        WHERE note.tenant_id = $1::uuid
          AND ($2::text IS NULL OR note.status = $2::text)
          AND ($3::int IS NULL OR note.invoice_id = $3::int)
        ORDER BY note.raised_at DESC, note.id DESC
        LIMIT $4::int`,
      tid,
      cleanStatus,
      cleanInvoiceId,
      cleanLimit,
    );
    return rows.map(normalizeCreditNote);
  }, { readOnly: true });
}

export async function getBillingCreditNote(creditNoteId, { tenantId } = {}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(
    tid,
    (tx) => loadCreditNoteTx(tx, tid, creditNoteId),
    { readOnly: true },
  );
}

export async function approveBillingCreditNote(creditNoteId, {
  tenantId,
  approvedBy,
  commandKey,
} = {}) {
  const tid = requireTenantId(tenantId);
  const actor = actorUid(approvedBy);
  const requestBody = {};
  return setTenantTx(tid, async (tx) => {
    let replay = await replayForEvent(
      tx, tid, creditNoteId, 'approve', commandKey, actor, requestBody,
    );
    if (replay.replay) return replay.replay;
    const note = await lockCreditNote(tx, tid, creditNoteId);
    replay = await replayForEvent(
      tx, tid, creditNoteId, 'approve', commandKey, actor, requestBody,
    );
    if (replay.replay) return replay.replay;
    if (note.status !== 'pending') {
      throw AppError.invalidTransition(note.status, 'approved', ['pending']);
    }
    await tx.$executeRawUnsafe(
      `UPDATE billing_credit_notes
          SET status = 'approved', approved_by = $1::uuid, approved_at = NOW(),
              updated_at = NOW()
        WHERE tenant_id = $2::uuid AND id = $3::bigint`,
      actor,
      tid,
      note.id,
    );
    const decisionEvent = await insertLifecycleEvent(tx, {
      tenantId: tid,
      creditNoteId: note.id,
      eventType: 'approved',
      actor,
      commandKey: replay.key,
      requestBody,
      details: { payout_authorized: false },
    });
    const approved = await loadCreditNoteTx(tx, tid, note.id);
    await advanceBillingCreditNoteObligationTx(tx, {
      creditNote: approved,
      approvalEvent: decisionEvent,
      actorUid: actor,
    });
    return approved;
  });
}

export async function rejectBillingCreditNote(creditNoteId, {
  tenantId,
  rejectedBy,
  rejectionReason,
  commandKey,
} = {}) {
  const tid = requireTenantId(tenantId);
  const actor = actorUid(rejectedBy);
  const reason = requiredText(rejectionReason, 'rejectionReason');
  const requestBody = { rejection_reason: reason };
  return setTenantTx(tid, async (tx) => {
    let replay = await replayForEvent(
      tx, tid, creditNoteId, 'reject', commandKey, actor, requestBody,
    );
    if (replay.replay) return replay.replay;
    const note = await lockCreditNote(tx, tid, creditNoteId);
    replay = await replayForEvent(
      tx, tid, creditNoteId, 'reject', commandKey, actor, requestBody,
    );
    if (replay.replay) return replay.replay;
    if (note.status !== 'pending') {
      throw AppError.invalidTransition(note.status, 'rejected', ['pending']);
    }
    await tx.$executeRawUnsafe(
      `UPDATE billing_credit_notes
          SET status = 'rejected', rejected_by = $1::uuid, rejected_at = NOW(),
              rejection_reason = $2::text, updated_at = NOW()
        WHERE tenant_id = $3::uuid AND id = $4::bigint`,
      actor,
      reason,
      tid,
      note.id,
    );
    const decisionEvent = await insertLifecycleEvent(tx, {
      tenantId: tid,
      creditNoteId: note.id,
      eventType: 'rejected',
      actor,
      commandKey: replay.key,
      requestBody,
      details: { rejection_reason: reason },
    });
    const rejected = await loadCreditNoteTx(tx, tid, note.id);
    await completeBillingCreditNoteObligationTx(tx, {
      creditNote: rejected,
      lifecycleEvent: decisionEvent,
      evidenceKind: 'billing_credit_note_decision',
      actorUid: actor,
    });
    return rejected;
  });
}

export async function applyBillingCreditNote(creditNoteId, {
  tenantId,
  appliedBy,
  refundMode = null,
  commandKey,
} = {}) {
  const tid = requireTenantId(tenantId);
  const actor = actorUid(appliedBy);
  const cleanMode = refundMode == null ? null : String(refundMode).trim().toUpperCase();
  if (cleanMode && !REFUND_MODES.has(cleanMode)) {
    throw AppError.badRequest('refundMode is invalid');
  }
  const requestBody = { refund_mode: cleanMode };
  const wiring = await resolveLedgerWiring(tid);
  const application = await setTenantTx(tid, async (tx) => {
    let replay = await replayForEvent(
      tx, tid, creditNoteId, 'apply', commandKey, actor, requestBody,
    );
    if (replay.replay) return { creditNote: replay.replay, replayed: true };
    const note = await lockCreditNote(tx, tid, creditNoteId);
    replay = await replayForEvent(
      tx, tid, creditNoteId, 'apply', commandKey, actor, requestBody,
    );
    if (replay.replay) return { creditNote: replay.replay, replayed: true };
    if (note.status !== 'approved') {
      throw AppError.invalidTransition(note.status, 'applied', ['approved']);
    }
    const amountMinor = Number(note.amount_minor);
    const dueMinor = Math.max(0, Math.round(Number(note.amount_due || 0) * 100));
    const receivableMinor = Math.min(amountMinor, dueMinor);
    const refundMinor = amountMinor - receivableMinor;
    if (refundMinor > 0 && !cleanMode) {
      throw AppError.conflict(
        'refundMode is required before applying a paid-invoice credit',
        'BILLING_CREDIT_NOTE_REFUND_MODE_REQUIRED',
      );
    }
    if (refundMinor > 0) {
      const headroom = await calculateInvoiceRefundHeadroomTx(tx, note.invoice_id);
      const refundableMinor = Math.round(headroom.refundable * 100);
      if (refundMinor > refundableMinor) {
        throw AppError.conflict(
          'The credit creates a refund obligation above the remaining paid balance',
          'BILLING_CREDIT_NOTE_REFUND_HEADROOM_CONFLICT',
          {
            refund_obligation_minor: refundMinor,
            refundable_minor: refundableMinor,
            gross_paid_minor: Math.round(headroom.gross_paid * 100),
            active_refunds_minor: Math.round(headroom.active_refunds * 100),
          },
        );
      }
      const tenderHeadroom = await loadRefundTenderHeadroomTx(tx, tid, note.invoice_id);
      const requestedTender = tenderHeadroom.find(({ mode }) => mode === cleanMode) || {
        mode: cleanMode,
        gross_paid_minor: 0,
        active_refunds_minor: 0,
        refundable_minor: 0,
      };
      if (refundMinor > requestedTender.refundable_minor) {
        throw AppError.conflict(
          'The selected refund mode exceeds receipts collected through that tender',
          'BILLING_CREDIT_NOTE_REFUND_TENDER_MISMATCH',
          {
            refund_mode: cleanMode,
            refund_obligation_minor: refundMinor,
            refundable_minor: requestedTender.refundable_minor,
            gross_paid_minor: requestedTender.gross_paid_minor,
            active_refunds_minor: requestedTender.active_refunds_minor,
            tender_headroom: tenderHeadroom,
          },
        );
      }
    }

    let refundId = null;
    if (refundMinor > 0) {
      const refundRows = await tx.$queryRawUnsafe(
        `INSERT INTO billing_refunds
           (patient_uid, invoice_id, amount, reason, mode,
            approval_status, raised_by, tenant_id)
         VALUES ($1::uuid, $2::int, $3::numeric, $4::text, $5::text,
                 'PENDING', $6::uuid, $7::uuid)
         RETURNING id`,
        String(note.patient_uid),
        Number(note.invoice_id),
        refundMinor / 100,
        `Ward medication credit note ${note.credit_note_number}`.slice(0, 500),
        cleanMode,
        actor,
        tid,
      );
      refundId = Number(refundRows[0].id);
    }

    const invoiceRows = await tx.$queryRawUnsafe(
      `UPDATE billing_invoices
          SET credit_note_amount = credit_note_amount + ($1::numeric / 100),
              amount_due = GREATEST(
                total_amount - (credit_note_amount + ($1::numeric / 100)) - amount_paid,
                0
              ),
              status = CASE
                WHEN status = 'DRAFT' THEN 'DRAFT'
                WHEN total_amount - (credit_note_amount + ($1::numeric / 100))
                     - amount_paid <= 0.005 THEN 'PAID'
                WHEN amount_paid <= 0.005 THEN 'ISSUED'
                ELSE 'PARTIAL'
              END,
              updated_at = NOW()
        WHERE tenant_id = $2::uuid
          AND id = $3::int
          AND status <> 'VOID'
          AND credit_note_amount + ($1::numeric / 100) <= total_amount + 0.005
        RETURNING id`,
      amountMinor,
      tid,
      Number(note.invoice_id),
    );
    if (!invoiceRows[0]) {
      throw AppError.conflict(
        'Invoice credit headroom changed before the credit note could be applied',
        'BILLING_CREDIT_NOTE_PROJECTION_CONFLICT',
      );
    }

    await tx.$executeRawUnsafe(
      `UPDATE billing_credit_notes
          SET status = 'applied', applied_by = $1::uuid, applied_at = NOW(),
              application_key = $2::text,
              receivable_credit_minor = $3::bigint,
              refund_obligation_minor = $4::bigint,
              refund_id = $5::int,
              updated_at = NOW()
        WHERE tenant_id = $6::uuid AND id = $7::bigint`,
      actor,
      replay.key,
      BigInt(receivableMinor),
      BigInt(refundMinor),
      refundId,
      tid,
      note.id,
    );
    const applicationEvent = await insertLifecycleEvent(tx, {
      tenantId: tid,
      creditNoteId: note.id,
      eventType: 'applied',
      actor,
      commandKey: replay.key,
      requestBody,
      details: {
        receivable_credit_minor: receivableMinor,
        refund_obligation_minor: refundMinor,
        refund_id: refundId,
        payout_authorized: false,
      },
    });
    const completed = await loadCreditNoteTx(tx, tid, note.id);
    if (completed.refund_id) {
      await advanceBillingCreditNoteRefundObligationTx(tx, {
        creditNote: completed,
        applicationEvent,
        actorUid: actor,
      });
    } else {
      await completeBillingCreditNoteObligationTx(tx, {
        creditNote: completed,
        lifecycleEvent: applicationEvent,
        evidenceKind: 'billing_credit_note_application',
        actorUid: actor,
      });
    }
    const postingNote = {
      ...note,
      receivable_credit_minor: receivableMinor,
      refund_obligation_minor: refundMinor,
    };
    if (wiring.sameTx && note.invoice_status !== 'DRAFT') {
      await postWardMedicationCreditEntry({ creditNote: postingNote, tenantId: tid, tx });
      await deriveInvoicePaymentStateFromLedgerTx(tx, Number(note.invoice_id));
    }
    return { creditNote: completed, replayed: false };
  });
  const applied = application.creditNote;

  if (!application.replayed && wiring.postCommit && applied?.invoice_status !== 'DRAFT') {
    try {
      await postWardMedicationCreditEntry({ creditNote: applied, tenantId: tid });
    } catch (err) {
      logger.error('Ward medication credit ledger post failed (non-blocking)', {
        creditNoteId: String(applied?.id || creditNoteId),
        error: err?.message,
      });
    }
  }
  return applied;
}

export default {
  createBillingCreditNoteFromFinancialEventTx,
  listBillingCreditNotes,
  getBillingCreditNote,
  approveBillingCreditNote,
  rejectBillingCreditNote,
  applyBillingCreditNote,
};
