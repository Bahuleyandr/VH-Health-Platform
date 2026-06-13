// src/services/billing/billingService.js
// Migrated from raw pg to Prisma ORM

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { normalizeClinicalJustification } from '../insurance/clinicalJustificationTemplate.js';

// SEC-3 — open a financial interactive transaction that is ALWAYS RLS-tenant-
// scoped. A known tenantId scopes to it; a falsy tenantId (single-tenant
// operation) scopes to DEFAULT_TENANT_ID rather than falling through to a bare
// `prisma.$transaction`, which would leave app.current_tenant_id unset and hit
// the permissive branch of every tenant_isolation policy. The default-tenant
// path is load-bearing for single-tenant deployments, so a falsy tenant must
// NOT throw — it just removes the permissive-open branch so the GUC is always
// set. When scoped, `invoices` (a tenant_isolation table) writes inside the tx
// are constrained to the resolved tenant — both the USING filter on the row
// lock/lookup and WITH CHECK on the update.
function scopedTx(tenantId, fn) {
  return setTenantTx(tenantId || DEFAULT_TENANT_ID, fn);
}

const VALID_INVOICE_TYPES = ['consultation', 'investigation', 'pharmacy', 'procedure', 'room_charge'];
const VALID_PAYMENT_METHODS = ['cash', 'card', 'upi', 'insurance', 'cheque'];
const VALID_PAYMENT_STATUSES = ['pending', 'partial', 'paid', 'refunded', 'written_off'];
// `settled_partial` (TPA settled less than approved, with a disallowed
// amount the patient owes) and `settled_full` (clean settle) are both
// post-`paid` end-states. `partially_approved` is the in-between state
// after preauth comes back with caps. See finding
// 2026-05-08-tpa-insurance-claim-billing-no-settled-partial-state.
const VALID_CLAIM_STATUSES = [
  'submitted', 'under_review', 'approved', 'partially_approved',
  'rejected', 'paid', 'settled_partial', 'settled_full',
];

// `preauth` (initial submission), `enhancement` (mid-stay top-up), `final`
// (discharge claim). Helps the TPA desk + downstream reports tell apart
// the lifecycle stages of a single admission's claims.
// Documents lifecycle stages; referenced by name in DB rows + downstream docs.
const _VALID_CLAIM_STAGES = ['preauth', 'enhancement', 'final'];

class BillingService {

  /**
   * Generate a unique invoice number: INV-YYYYMM-XXXX
   */
  async _generateInvoiceNumber() {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `INV-${yearMonth}-`;

    const last = await prisma.invoices.findFirst({
      where: { invoice_number: { startsWith: prefix } },
      orderBy: { id: 'desc' },
      select: { invoice_number: true },
    });

    let sequence = 1;
    if (last) {
      const lastSeq = parseInt(last.invoice_number.split('-')[2], 10);
      if (!isNaN(lastSeq)) sequence = lastSeq + 1;
    }

    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }

  /**
   * Generate a unique claim number: CLM-YYYYMM-XXXX
   */
  async _generateClaimNumber() {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `CLM-${yearMonth}-`;

    const last = await prisma.insurance_claims.findFirst({
      where: { claim_number: { startsWith: prefix } },
      orderBy: { id: 'desc' },
      select: { claim_number: true },
    });

    let sequence = 1;
    if (last) {
      const lastSeq = parseInt(last.claim_number.split('-')[2], 10);
      if (!isNaN(lastSeq)) sequence = lastSeq + 1;
    }

    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }

  /**
   * Create a new invoice
   */
  async createInvoice(data) {
    const {
      patient_uid, appointment_id, type, items,
      subtotal, tax_amount = 0, discount_amount = 0, total_amount,
      payment_method, notes, issued_by, due_date, tenant_id,
    } = data;

    if (!patient_uid) throw AppError.badRequest('Patient UID is required');
    if (!type || !VALID_INVOICE_TYPES.includes(type.toLowerCase())) {
      throw AppError.badRequest(`Invalid invoice type. Must be one of: ${VALID_INVOICE_TYPES.join(', ')}`);
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw AppError.badRequest('At least one line item is required');
    }
    if (subtotal === null || total_amount === null) {
      throw AppError.badRequest('Subtotal and total_amount are required');
    }

    const invoiceNumber = await this._generateInvoiceNumber();
    const now = new Date();

    const invoice = await prisma.invoices.create({
      data: {
        invoice_number: invoiceNumber,
        patient_uid,
        appointment_id: appointment_id || null,
        type: type.toLowerCase(),
        items,
        subtotal,
        tax_amount,
        discount_amount,
        total_amount,
        payment_method: payment_method ? payment_method.toLowerCase() : null,
        notes: notes || null,
        issued_by: issued_by || null,
        due_date: due_date ? new Date(due_date) : null,
        ...(tenant_id ? { tenant_id: String(tenant_id) } : {}),
        updated_at: now,
      },
    });

    logger.info(`Invoice created: ${invoiceNumber} for patient ${patient_uid}`);
    return invoice;
  }

  /**
   * Record a payment against an invoice
   */
  async recordPayment(invoiceId, amount, method, processedBy, transactionRef = null, tenantId = null) {
    if (!invoiceId) throw AppError.badRequest('Invoice ID is required');
    if (!amount || amount <= 0) throw AppError.badRequest('Payment amount must be greater than zero');
    if (!method || !VALID_PAYMENT_METHODS.includes(method.toLowerCase())) {
      throw AppError.badRequest(`Invalid payment method. Must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`);
    }

    const invoice = await prisma.invoices.findFirst({
      where: {
        id: invoiceId,
        ...(tenantId ? { tenant_id: String(tenantId) } : {}),
      },
      select: { id: true, total_amount: true, paid_amount: true, payment_status: true },
    });

    if (!invoice) throw AppError.notFound('Invoice not found');

    const totalAmount = parseFloat(invoice.total_amount);
    const currentPaid = parseFloat(invoice.paid_amount);
    const newPaid = currentPaid + parseFloat(amount);

    if (newPaid > totalAmount) {
      throw AppError.badRequest(
        `Payment of ${amount} would exceed the remaining balance of ${(totalAmount - currentPaid).toFixed(2)}`
      );
    }

    let newStatus;
    if (newPaid >= totalAmount) {
      newStatus = 'paid';
    } else if (newPaid > 0) {
      newStatus = 'partial';
    } else {
      newStatus = 'pending';
    }

    const paidAt = newStatus === 'paid' ? new Date() : null;
    const now = new Date();

    // Transaction + invoice update atomically. Interactive form (not the
    // array form) because the tenant-RLS model wrapper in src/lib/prisma.js
    // returns real Promises under an active tenant context, which the
    // array form rejects (see roadmap A2 notes in lib/prisma.js).
    // SEC-3: scopedTx scopes the tx to `tenantId` so the invoices update runs
    // under the tenant_isolation policy (the bare $transaction left the GUC
    // unset → permissive branch → cross-tenant invoice write was reachable).
    const [transaction, updatedInvoice] = await scopedTx(tenantId, async (tx) => Promise.all([
      tx.payment_transactions.create({
        data: {
          invoice_id: invoiceId,
          amount,
          payment_method: method.toLowerCase(),
          transaction_ref: transactionRef || null,
          processed_by: processedBy || null,
        },
      }),
      tx.invoices.update({
        where: { id: invoiceId },
        data: {
          paid_amount: newPaid,
          payment_status: newStatus,
          payment_method: method.toLowerCase(),
          paid_at: paidAt,
          updated_at: now,
        },
        select: {
          id: true, invoice_number: true, patient_uid: true, total_amount: true,
          paid_amount: true, payment_status: true, payment_method: true, paid_at: true,
        },
      }),
    ]));

    logger.info(`Payment of ${amount} recorded for invoice ${invoiceId}, status: ${newStatus}`);
    return { invoice: updatedInvoice, transaction };
  }

  /**
   * Get patient invoices with pagination and filters
   */
  async getPatientInvoices(patientUid, filters = {}, options = {}) {
    if (!patientUid) throw AppError.badRequest('Patient UID is required');

    const { status, type, date_from, date_to } = filters;
    const { tenantId = null } = options;
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const where = {
      patient_uid: patientUid,
      ...(tenantId ? { tenant_id: String(tenantId) } : {}),
    };

    if (status && VALID_PAYMENT_STATUSES.includes(status)) where.payment_status = status;
    if (type && VALID_INVOICE_TYPES.includes(type.toLowerCase())) where.type = type.toLowerCase();
    if (date_from || date_to) {
      where.issued_at = {};
      if (date_from) where.issued_at.gte = new Date(date_from);
      if (date_to) where.issued_at.lte = new Date(date_to);
    }

    // Interactive form — see roadmap A2 note on the model wrapper.
    // SEC-3: scope the read tx to `tenantId` (defense-in-depth atop the
    // app-level tenant_id filter) and route it to the read replica when one is
    // configured (readOnly). Falls back to a permissive primary tx untenanted.
    const [total, invoices] = await scopedTx(tenantId, async (tx) => Promise.all([
      tx.invoices.count({ where }),
      tx.invoices.findMany({
        where,
        select: {
          id: true, invoice_number: true, type: true, subtotal: true,
          tax_amount: true, discount_amount: true, total_amount: true,
          paid_amount: true, payment_status: true, payment_method: true,
          issued_at: true, due_date: true, created_at: true,
        },
        orderBy: { created_at: 'desc' },
        skip: listQuery.offset,
        take: listQuery.limit,
      }),
    ]));

    return {
      invoices,
      pagination: buildPagination(total, listQuery.page, listQuery.limit),
    };
  }

  /**
   * Get full invoice detail with payment history
   */
  async getInvoiceDetail(invoiceId, options = {}) {
    if (!invoiceId) throw AppError.badRequest('Invoice ID is required');
    const { tenantId = null, requester = null } = options;

    const invoice = await prisma.invoices.findFirst({
      where: {
        id: invoiceId,
        ...(tenantId ? { tenant_id: String(tenantId) } : {}),
      },
      include: {
        payment_transactions: {
          orderBy: { created_at: 'desc' },
        },
      },
    });

    if (!invoice) throw AppError.notFound('Invoice not found');
    if (
      String(requester?.role || '').toUpperCase() === 'PATIENT' &&
      String(requester?.uid || '').toLowerCase() !== String(invoice.patient_uid || '').toLowerCase()
    ) {
      throw AppError.forbidden(
        'Patients can only access their own billing invoices',
        'BILLING_PATIENT_ACCESS_DENIED',
      );
    }

    // Fetch linked insurance claim if any
    let insuranceClaim = null;
    if (invoice.insurance_claim_id) {
      insuranceClaim = await prisma.insurance_claims.findFirst({
        where: {
          id: invoice.insurance_claim_id,
          ...(tenantId ? { tenant_id: String(tenantId) } : {}),
        },
        select: {
          id: true, claim_number: true, insurance_provider: true, policy_number: true,
          claim_amount: true, approved_amount: true, status: true,
          submitted_at: true, reviewed_at: true,
        },
      });
    }

    return { ...invoice, insurance_claim: insuranceClaim };
  }

  /**
   * Get revenue statistics for a date range
   */
  async getRevenueStats(dateFrom, dateTo) {
    if (!dateFrom || !dateTo) throw AppError.badRequest('dateFrom and dateTo are required');

    const from = new Date(dateFrom);
    const to = new Date(dateTo);

    const [byType, summary] = await Promise.all([
      prisma.invoices.groupBy({
        by: ['type'],
        where: { issued_at: { gte: from, lte: to } },
        _count: { id: true },
        _sum: { total_amount: true, paid_amount: true },
        orderBy: { _sum: { total_amount: 'desc' } },
      }),
      prisma.invoices.aggregate({
        where: { issued_at: { gte: from, lte: to } },
        _count: { id: true },
        _sum: {
          total_amount: true,
          paid_amount: true,
          discount_amount: true,
          tax_amount: true,
        },
      }),
    ]);

    const [byMethod, dailyRaw, statusCounts] = await Promise.all([
      prisma.payment_transactions.groupBy({
        by: ['payment_method'],
        where: { created_at: { gte: from, lte: to } },
        _count: { id: true },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
      }),
      // Daily aggregates still use raw SQL for DATE truncation
      prisma.$queryRaw`
        SELECT
          DATE(issued_at) AS date,
          COUNT(*)::int AS invoice_count,
          SUM(total_amount) AS billed,
          SUM(paid_amount) AS collected
        FROM invoices
        WHERE issued_at >= ${from} AND issued_at <= ${to}
        GROUP BY DATE(issued_at)
        ORDER BY date
      `,
      prisma.invoices.groupBy({
        by: ['payment_status'],
        where: { issued_at: { gte: from, lte: to } },
        _count: { id: true },
      }),
    ]);

    const statusMap = Object.fromEntries(
      statusCounts.map(s => [s.payment_status, s._count.id])
    );

    return {
      summary: {
        total_invoices: summary._count.id,
        total_billed: summary._sum.total_amount,
        total_collected: summary._sum.paid_amount,
        total_outstanding: (
          parseFloat(summary._sum.total_amount || 0) -
          parseFloat(summary._sum.paid_amount || 0)
        ).toFixed(2),
        total_discounts: summary._sum.discount_amount,
        total_taxes: summary._sum.tax_amount,
        paid_count: statusMap['paid'] || 0,
        pending_count: statusMap['pending'] || 0,
        partial_count: statusMap['partial'] || 0,
      },
      by_type: byType.map(r => ({
        type: r.type,
        invoice_count: r._count.id,
        total_billed: r._sum.total_amount,
        total_collected: r._sum.paid_amount,
        outstanding: (
          parseFloat(r._sum.total_amount || 0) -
          parseFloat(r._sum.paid_amount || 0)
        ).toFixed(2),
      })),
      by_payment_method: byMethod.map(r => ({
        payment_method: r.payment_method,
        transaction_count: r._count.id,
        total_amount: r._sum.amount,
      })),
      daily_totals: dailyRaw,
    };
  }

  /**
   * Submit an insurance claim
   */
  async submitInsuranceClaim(data) {
    const {
      patient_uid, invoice_id, insurance_provider,
      policy_number, claim_amount, documents = [], tenant_id,
    } = data;

    if (!patient_uid) throw AppError.badRequest('Patient UID is required');
    if (!insurance_provider || !policy_number) {
      throw AppError.badRequest('Insurance provider and policy number are required');
    }
    if (!claim_amount || claim_amount <= 0) {
      throw AppError.badRequest('Claim amount must be greater than zero');
    }

    if (invoice_id) {
      const inv = await prisma.invoices.findFirst({
        where: {
          id: invoice_id,
          ...(tenant_id ? { tenant_id: String(tenant_id) } : {}),
        },
        select: { id: true, patient_uid: true },
      });
      if (!inv) throw AppError.notFound('Linked invoice not found');
      if (inv.patient_uid !== patient_uid) {
        throw AppError.badRequest('Invoice does not belong to the specified patient');
      }
    }

    const claimNumber = await this._generateClaimNumber();
    const now = new Date();

    const claim = await prisma.insurance_claims.create({
      data: {
        claim_number: claimNumber,
        patient_uid,
        invoice_id: invoice_id || null,
        insurance_provider,
        policy_number,
        claim_amount,
        documents,
        ...(tenant_id ? { tenant_id: String(tenant_id) } : {}),
        updated_at: now,
      },
    });

    // Link claim to invoice
    if (invoice_id) {
      await prisma.invoices.update({
        where: { id: invoice_id },
        data: { insurance_claim_id: claim.id, updated_at: now },
      });
    }

    logger.info(`Insurance claim created: ${claimNumber} for patient ${patient_uid}`);
    return claim;
  }

  /**
   * Update insurance claim status. The 4th arg may be a plain string
   * (legacy: rejection_reason text) OR an options object with
   * { documents, payment_reference, actor_uid } so callers can persist
   * partial-approval caps and payment evidence. Both shapes are accepted
   * for backward compat.
   */
  async updateClaimStatus(claimId, status, approvedAmount = null, reasonOrOpts = null) {
    if (!claimId) throw AppError.badRequest('Claim ID is required');
    if (!status || !VALID_CLAIM_STATUSES.includes(status)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_CLAIM_STATUSES.join(', ')}`);
    }

    const opts = (reasonOrOpts && typeof reasonOrOpts === 'object')
      ? reasonOrOpts
      : { documents: undefined, payment_reference: undefined, actor_uid: null, _legacyReason: reasonOrOpts };
    const reason = opts._legacyReason ?? opts.rejection_reason ?? null;
    const documentsPatch = opts.documents;
    const paymentReference = opts.payment_reference ?? null;
    // Settled-partial fields. See finding
    // 2026-05-08-tpa-insurance-claim-billing-no-settled-partial-state.
    const nonPayableAmount = opts.non_payable_amount ?? null;
    const disallowedReason = opts.disallowed_reason ?? null;

    const existing = await prisma.insurance_claims.findUnique({
      where: { id: claimId },
      select: { id: true, documents: true, status: true },
    });
    if (!existing) throw AppError.notFound('Insurance claim not found');

    // Merge partial-approval caps and other structured payload bits into
    // the existing `documents` jsonb instead of overwriting. Caller can
    // pass `documents: null` to explicitly clear. See finding
    // 2026-05-08-tpa-insurance-claim-billing-claim-update-drops-fields.
    let mergedDocuments = existing.documents ?? null;
    if (documentsPatch !== undefined) {
      if (documentsPatch === null) {
        mergedDocuments = null;
      } else if (typeof documentsPatch === 'object' && !Array.isArray(documentsPatch)) {
        mergedDocuments = { ...(existing.documents ?? {}), ...documentsPatch };
      } else {
        mergedDocuments = documentsPatch;
      }
    }
    // Stamp the payment reference + actor inside `documents` so we have an
    // audit trail without a separate column. Real ledger linkage can be
    // wired through payment_transactions in a follow-up.
    if (status === 'paid' && paymentReference) {
      mergedDocuments = {
        ...(typeof mergedDocuments === 'object' && mergedDocuments !== null ? mergedDocuments : {}),
        payment: {
          reference: paymentReference,
          recorded_by: opts.actor_uid ?? null,
          recorded_at: new Date().toISOString(),
        },
      };
    }

    const reviewedAt = ['approved', 'partially_approved', 'rejected', 'paid', 'settled_partial', 'settled_full'].includes(status)
      ? new Date()
      : null;
    const now = new Date();

    const updated = await prisma.insurance_claims.update({
      where: { id: claimId },
      data: {
        status,
        approved_amount: approvedAmount ?? null,
        rejection_reason: reason ?? null,
        non_payable_amount: nonPayableAmount,
        disallowed_reason: disallowedReason,
        documents: mergedDocuments,
        reviewed_at: reviewedAt,
        updated_at: now,
      },
    });

    logger.info(`Insurance claim ${claimId} updated to status: ${status}`);
    return updated;
  }

  /**
   * Open an enhancement claim — a child claim referencing the original
   * preauth. Used mid-stay when the patient's plan extends past the
   * approved length-of-stay or when complications add cost. See finding
   * 2026-05-08-tpa-insurance-claim-doctor-enhancement-workflow-absent.
   *
   * @param {Object} args
   * @param {number} args.parentClaimId  Original preauth claim id
   * @param {number} args.enhancementAmount  Additional amount being requested
   * @param {string} [args.justification]  Legacy free-text clinical reason
   * @param {Object} [args.clinicalJustification]  Structured justification
   *   matching the enhancement justification template — preferred over the
   *   free-text `justification`. Finding:
   *   2026-05-09-tpa-insurance-claim-doctor-no-clinical-justification-template
   * @param {string} [args.actorUid]
   * @returns {Object} new child claim row
   */
  async createEnhancementClaim({
    parentClaimId, enhancementAmount, justification = null,
    clinicalJustification = null, actorUid = null,
  }) {
    if (!parentClaimId) throw AppError.badRequest('parentClaimId is required');
    const amount = Number(enhancementAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw AppError.badRequest('enhancementAmount must be a positive number');
    }
    // Accept either the structured template object or a legacy free-text
    // string. Throws AppError.badRequest on a malformed structured body.
    const normalizedJustification = normalizeClinicalJustification(
      clinicalJustification ?? justification,
    );

    // Probe both tables. `insurance_claims` is the legacy billing-side
    // surface this endpoint writes to; `tpa_claims` is the Sprint 5 TPA
    // workflow and uses `insurance_preauth.parent_preauth_id` instead
    // (see CLAUDE.md table-split note + commit 8c2b157a).
    const parentRows = await prisma.$queryRawUnsafe(
      `SELECT id, claim_number, patient_uid, invoice_id, insurance_provider, policy_number, tenant_id
         FROM insurance_claims WHERE id = $1::int`,
      Number(parentClaimId),
    );
    if (!parentRows.length) {
      const tpaRows = await prisma.$queryRawUnsafe(
        `SELECT id, claim_number FROM tpa_claims WHERE id = $1::int`,
        Number(parentClaimId),
      );
      if (tpaRows.length) {
        throw AppError.badRequest(
          `Claim ${parentClaimId} (${tpaRows[0].claim_number}) is a TPA claim — ` +
          `use the insurance_preauth enhancement workflow (request_type='enhancement') ` +
          `instead of /billing/insurance/claim/:id/enhancement.`,
          'TPA_CLAIM_USE_PREAUTH_ENHANCEMENT'
        );
      }
      throw AppError.notFound('Parent insurance claim not found');
    }
    const parent = parentRows[0];

    // claim_number is VARCHAR(30). The parent number plus a `-E<n>` suffix
    // can overflow if the parent is close to the limit, so cap the prefix
    // length defensively before suffixing.
    const baseNumber = String(parent.claim_number || '').slice(0, 26);

    // Allocate the next `-E<n>` slot + insert in a single transaction so
    // two concurrent enhancement requests don't both pick E1 and collide
    // on the unique constraint. Raw SQL mirrors the manual INSERT shape
    // that the finding confirmed works against the live schema (the
    // prior `prisma.insurance_claims.create({ data: { ... } })` path
    // returned 500 — see finding
    // 2026-05-09-tpa-insurance-claim-doctor-enhancement-api-500).
    const docsJson = normalizedJustification.format !== 'none'
      ? JSON.stringify({
          enhancement: {
            justification: normalizedJustification.text,
            justification_format: normalizedJustification.format,
            justification_structured: normalizedJustification.structured,
            template_version: normalizedJustification.template_version ?? null,
            requested_by: actorUid ?? null,
            requested_at: new Date().toISOString(),
          },
        })
      : null;

    try {
      // SEC: scope the tx to the parent claim's tenant so insurance_claims (a
      // tenant_isolation table) is RLS-filtered on the suffix-count read and
      // WITH CHECK-enforced on the enhancement INSERT. A bare prisma.$transaction
      // leaves app.current_tenant_id unset → policy falls to its permissive
      // branch. setTenantTx sets the GUC as the first statement of the tx.
      const created = await setTenantTx(parent.tenant_id, async (tx) => {
        const countRows = await tx.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS n
             FROM insurance_claims
            WHERE parent_claim_id = $1::int AND stage = 'enhancement'`,
          Number(parentClaimId),
        );
        const nextSuffix = (countRows[0]?.n ?? 0) + 1;
        const enhancementClaimNumber = `${baseNumber}-E${nextSuffix}`;

        const insertedRows = await tx.$queryRawUnsafe(
          `INSERT INTO insurance_claims
             (claim_number, patient_uid, invoice_id,
              insurance_provider, policy_number,
              claim_amount, status, stage, parent_claim_id,
              documents, tenant_id, submitted_at, created_at, updated_at)
           VALUES ($1, $2::uuid, $3::int,
                   $4, $5,
                   $6::numeric, 'submitted', 'enhancement', $7::int,
                   $8::jsonb, $9::uuid, NOW(), NOW(), NOW())
           RETURNING id, claim_number, patient_uid, invoice_id,
                     insurance_provider, policy_number, claim_amount,
                     status, stage, parent_claim_id, documents,
                     submitted_at, created_at, updated_at`,
          enhancementClaimNumber,
          parent.patient_uid,
          parent.invoice_id ?? null,
          parent.insurance_provider,
          parent.policy_number,
          amount,
          Number(parentClaimId),
          docsJson,
          parent.tenant_id,
        );
        return insertedRows[0];
      });

      logger.info(
        `Enhancement claim ${created.claim_number} (id=${created.id}) opened against parent claim ${parentClaimId} for ${amount}`
      );
      return created;
    } catch (err) {
      // Log the actual Postgres error before the global handler scrubs it,
      // so future regressions in this path are diagnosable from the
      // backend logs instead of needing a `psql` repro. Finding
      // 2026-05-09-tpa-insurance-claim-doctor-enhancement-api-500
      // explicitly called out that the root cause never reached the
      // log files.
      logger.error('createEnhancementClaim insert failed', {
        parentClaimId,
        amount,
        code: err.code,
        message: err.message,
      });
      throw err;
    }
  }

  /**
   * List insurance claims with filters
   */
  async getInsuranceClaims(filters = {}, options = {}) {
    const { patient_uid, status } = filters;
    const { tenantId = null } = options;
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at'
    });

    const where = tenantId ? { tenant_id: String(tenantId) } : {};
    if (patient_uid) where.patient_uid = patient_uid;
    if (status && VALID_CLAIM_STATUSES.includes(status)) where.status = status;

    // Interactive form — see roadmap A2 note on the model wrapper.
    // SEC-3: scope the read tx to `tenantId` so insurance_claims (a
    // tenant_isolation table) is RLS-filtered inside the tx, defense-in-depth
    // atop the app-level tenant_id where-clause.
    const [total, claims] = await scopedTx(tenantId, async (tx) => Promise.all([
      tx.insurance_claims.count({ where }),
      tx.insurance_claims.findMany({
        where,
        select: {
          id: true, claim_number: true, patient_uid: true, invoice_id: true,
          insurance_provider: true, policy_number: true, claim_amount: true,
          approved_amount: true, status: true, submitted_at: true,
          reviewed_at: true, rejection_reason: true, created_at: true,
        },
        orderBy: { created_at: 'desc' },
        skip: listQuery.offset,
        take: listQuery.limit,
      }),
    ]));

    return {
      claims,
      pagination: buildPagination(total, listQuery.page, listQuery.limit),
    };
  }
}

export default new BillingService();
