// src/services/billing/billingService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_INVOICE_TYPES = ['consultation', 'investigation', 'pharmacy', 'procedure', 'room_charge'];
const VALID_PAYMENT_METHODS = ['cash', 'card', 'upi', 'insurance', 'cheque'];
const VALID_PAYMENT_STATUSES = ['pending', 'partial', 'paid', 'refunded', 'written_off'];
const VALID_CLAIM_STATUSES = ['submitted', 'under_review', 'approved', 'partially_approved', 'rejected', 'paid'];

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
      payment_method, notes, issued_by, due_date,
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
        updated_at: now,
      },
    });

    logger.info(`Invoice created: ${invoiceNumber} for patient ${patient_uid}`);
    return invoice;
  }

  /**
   * Record a payment against an invoice
   */
  async recordPayment(invoiceId, amount, method, processedBy, transactionRef = null) {
    if (!invoiceId) throw AppError.badRequest('Invoice ID is required');
    if (!amount || amount <= 0) throw AppError.badRequest('Payment amount must be greater than zero');
    if (!method || !VALID_PAYMENT_METHODS.includes(method.toLowerCase())) {
      throw AppError.badRequest(`Invalid payment method. Must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`);
    }

    const invoice = await prisma.invoices.findUnique({
      where: { id: invoiceId },
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

    // Transaction + invoice update in one batch
    const [transaction, updatedInvoice] = await prisma.$transaction([
      prisma.payment_transactions.create({
        data: {
          invoice_id: invoiceId,
          amount,
          payment_method: method.toLowerCase(),
          transaction_ref: transactionRef || null,
          processed_by: processedBy || null,
        },
      }),
      prisma.invoices.update({
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
    ]);

    logger.info(`Payment of ${amount} recorded for invoice ${invoiceId}, status: ${newStatus}`);
    return { invoice: updatedInvoice, transaction };
  }

  /**
   * Get patient invoices with pagination and filters
   */
  async getPatientInvoices(patientUid, filters = {}) {
    if (!patientUid) throw AppError.badRequest('Patient UID is required');

    const { status, type, page = 1, limit = 20, date_from, date_to } = filters;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const where = { patient_uid: patientUid };

    if (status && VALID_PAYMENT_STATUSES.includes(status)) where.payment_status = status;
    if (type && VALID_INVOICE_TYPES.includes(type.toLowerCase())) where.type = type.toLowerCase();
    if (date_from || date_to) {
      where.issued_at = {};
      if (date_from) where.issued_at.gte = new Date(date_from);
      if (date_to) where.issued_at.lte = new Date(date_to);
    }

    const [total, invoices] = await prisma.$transaction([
      prisma.invoices.count({ where }),
      prisma.invoices.findMany({
        where,
        select: {
          id: true, invoice_number: true, type: true, subtotal: true,
          tax_amount: true, discount_amount: true, total_amount: true,
          paid_amount: true, payment_status: true, payment_method: true,
          issued_at: true, due_date: true, created_at: true,
        },
        orderBy: { created_at: 'desc' },
        skip: offset,
        take: limitNum,
      }),
    ]);

    return {
      invoices,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  }

  /**
   * Get full invoice detail with payment history
   */
  async getInvoiceDetail(invoiceId) {
    if (!invoiceId) throw AppError.badRequest('Invoice ID is required');

    const invoice = await prisma.invoices.findUnique({
      where: { id: invoiceId },
      include: {
        payment_transactions: {
          orderBy: { created_at: 'desc' },
        },
      },
    });

    if (!invoice) throw AppError.notFound('Invoice not found');

    // Fetch linked insurance claim if any
    let insuranceClaim = null;
    if (invoice.insurance_claim_id) {
      insuranceClaim = await prisma.insurance_claims.findUnique({
        where: { id: invoice.insurance_claim_id },
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
      policy_number, claim_amount, documents = [],
    } = data;

    if (!patient_uid) throw AppError.badRequest('Patient UID is required');
    if (!insurance_provider || !policy_number) {
      throw AppError.badRequest('Insurance provider and policy number are required');
    }
    if (!claim_amount || claim_amount <= 0) {
      throw AppError.badRequest('Claim amount must be greater than zero');
    }

    if (invoice_id) {
      const inv = await prisma.invoices.findUnique({
        where: { id: invoice_id },
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
   * Update insurance claim status
   */
  async updateClaimStatus(claimId, status, approvedAmount = null, reason = null) {
    if (!claimId) throw AppError.badRequest('Claim ID is required');
    if (!status || !VALID_CLAIM_STATUSES.includes(status)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_CLAIM_STATUSES.join(', ')}`);
    }

    const existing = await prisma.insurance_claims.findUnique({
      where: { id: claimId },
      select: { id: true },
    });
    if (!existing) throw AppError.notFound('Insurance claim not found');

    const reviewedAt = ['approved', 'partially_approved', 'rejected'].includes(status)
      ? new Date()
      : null;
    const now = new Date();

    const updated = await prisma.insurance_claims.update({
      where: { id: claimId },
      data: {
        status,
        approved_amount: approvedAmount ?? null,
        rejection_reason: reason ?? null,
        reviewed_at: reviewedAt,
        updated_at: now,
      },
    });

    logger.info(`Insurance claim ${claimId} updated to status: ${status}`);
    return updated;
  }

  /**
   * List insurance claims with filters
   */
  async getInsuranceClaims(filters = {}) {
    const { patient_uid, status, page = 1, limit = 20 } = filters;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const where = {};
    if (patient_uid) where.patient_uid = patient_uid;
    if (status && VALID_CLAIM_STATUSES.includes(status)) where.status = status;

    const [total, claims] = await prisma.$transaction([
      prisma.insurance_claims.count({ where }),
      prisma.insurance_claims.findMany({
        where,
        select: {
          id: true, claim_number: true, patient_uid: true, invoice_id: true,
          insurance_provider: true, policy_number: true, claim_amount: true,
          approved_amount: true, status: true, submitted_at: true,
          reviewed_at: true, rejection_reason: true, created_at: true,
        },
        orderBy: { created_at: 'desc' },
        skip: offset,
        take: limitNum,
      }),
    ]);

    return {
      claims,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  }
}

export default new BillingService();
