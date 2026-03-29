// src/services/billing/billingService.js

import db from '../../config/database.js';
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

    const result = await db.query(
      `SELECT invoice_number FROM invoices
       WHERE invoice_number LIKE $1
       ORDER BY id DESC LIMIT 1`,
      [`${prefix}%`]
    );

    let sequence = 1;
    if (result.rows.length > 0) {
      const lastNumber = result.rows[0].invoice_number;
      const lastSeq = parseInt(lastNumber.split('-')[2], 10);
      if (!isNaN(lastSeq)) {
        sequence = lastSeq + 1;
      }
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

    const result = await db.query(
      `SELECT claim_number FROM insurance_claims
       WHERE claim_number LIKE $1
       ORDER BY id DESC LIMIT 1`,
      [`${prefix}%`]
    );

    let sequence = 1;
    if (result.rows.length > 0) {
      const lastNumber = result.rows[0].claim_number;
      const lastSeq = parseInt(lastNumber.split('-')[2], 10);
      if (!isNaN(lastSeq)) {
        sequence = lastSeq + 1;
      }
    }

    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }

  /**
   * Create a new invoice
   * @param {Object} data - Invoice data
   * @returns {Object} Created invoice
   */
  async createInvoice(data) {
    const {
      patient_uid, appointment_id, type, items,
      subtotal, tax_amount = 0, discount_amount = 0, total_amount,
      payment_method, notes, issued_by, due_date
    } = data;

    if (!patient_uid) {
      throw AppError.badRequest('Patient UID is required');
    }
    if (!type || !VALID_INVOICE_TYPES.includes(type)) {
      throw AppError.badRequest(`Invalid invoice type. Must be one of: ${VALID_INVOICE_TYPES.join(', ')}`);
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw AppError.badRequest('At least one line item is required');
    }
    if (subtotal == null || total_amount == null) {
      throw AppError.badRequest('Subtotal and total_amount are required');
    }

    const invoiceNumber = await this._generateInvoiceNumber();

    const result = await db.query(
      `INSERT INTO invoices (
        invoice_number, patient_uid, appointment_id, type, items,
        subtotal, tax_amount, discount_amount, total_amount,
        payment_method, notes, issued_by, due_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, invoice_number, patient_uid, appointment_id, type, items,
        subtotal, tax_amount, discount_amount, total_amount, paid_amount,
        payment_status, payment_method, notes, issued_by, issued_at, due_date, created_at`,
      [
        invoiceNumber, patient_uid, appointment_id || null, type,
        JSON.stringify(items), subtotal, tax_amount, discount_amount,
        total_amount, payment_method || null, notes || null,
        issued_by || null, due_date || null
      ]
    );

    logger.info(`Invoice created: ${invoiceNumber} for patient ${patient_uid}`);
    return result.rows[0];
  }

  /**
   * Record a payment against an invoice
   * @param {number} invoiceId - Invoice ID
   * @param {number} amount - Payment amount
   * @param {string} method - Payment method
   * @param {string} processedBy - UID of the person processing payment
   * @param {string} transactionRef - Optional transaction reference
   * @returns {Object} Updated invoice and transaction
   */
  async recordPayment(invoiceId, amount, method, processedBy, transactionRef = null) {
    if (!invoiceId) {
      throw AppError.badRequest('Invoice ID is required');
    }
    if (!amount || amount <= 0) {
      throw AppError.badRequest('Payment amount must be greater than zero');
    }
    if (!method || !VALID_PAYMENT_METHODS.includes(method)) {
      throw AppError.badRequest(`Invalid payment method. Must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`);
    }

    // Fetch invoice
    const invoiceResult = await db.query(
      `SELECT id, total_amount, paid_amount, payment_status
       FROM invoices WHERE id = $1`,
      [invoiceId]
    );

    if (invoiceResult.rows.length === 0) {
      throw AppError.notFound('Invoice not found');
    }

    const invoice = invoiceResult.rows[0];
    const totalAmount = parseFloat(invoice.total_amount);
    const currentPaid = parseFloat(invoice.paid_amount);
    const newPaid = currentPaid + parseFloat(amount);

    if (newPaid > totalAmount) {
      throw AppError.badRequest(
        `Payment of ${amount} would exceed the remaining balance of ${(totalAmount - currentPaid).toFixed(2)}`
      );
    }

    // Determine new status
    let newStatus;
    if (newPaid >= totalAmount) {
      newStatus = 'paid';
    } else if (newPaid > 0) {
      newStatus = 'partial';
    } else {
      newStatus = 'pending';
    }

    const paidAt = newStatus === 'paid' ? new Date() : null;

    // Record transaction
    const txnResult = await db.query(
      `INSERT INTO payment_transactions (invoice_id, amount, payment_method, transaction_ref, processed_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, invoice_id, amount, payment_method, transaction_ref, status, processed_by, created_at`,
      [invoiceId, amount, method, transactionRef, processedBy || null]
    );

    // Update invoice
    const updatedInvoice = await db.query(
      `UPDATE invoices
       SET paid_amount = $1, payment_status = $2, payment_method = $3, paid_at = $4
       WHERE id = $5
       RETURNING id, invoice_number, patient_uid, total_amount, paid_amount,
         payment_status, payment_method, paid_at`,
      [newPaid, newStatus, method, paidAt, invoiceId]
    );

    logger.info(`Payment of ${amount} recorded for invoice ${invoiceId}, status: ${newStatus}`);

    return {
      invoice: updatedInvoice.rows[0],
      transaction: txnResult.rows[0]
    };
  }

  /**
   * Get patient invoices with pagination and filters
   * @param {string} patientUid - Patient UID
   * @param {Object} filters - Filters (status, type, page, limit, dateFrom, dateTo)
   * @returns {Object} Invoices list with pagination meta
   */
  async getPatientInvoices(patientUid, filters = {}) {
    if (!patientUid) {
      throw AppError.badRequest('Patient UID is required');
    }

    const {
      status, type, page = 1, limit = 20, date_from, date_to
    } = filters;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const conditions = ['i.patient_uid = $1'];
    const params = [patientUid];
    let paramIndex = 2;

    if (status && VALID_PAYMENT_STATUSES.includes(status)) {
      conditions.push(`i.payment_status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }
    if (type && VALID_INVOICE_TYPES.includes(type)) {
      conditions.push(`i.type = $${paramIndex}`);
      params.push(type);
      paramIndex++;
    }
    if (date_from) {
      conditions.push(`i.issued_at >= $${paramIndex}`);
      params.push(date_from);
      paramIndex++;
    }
    if (date_to) {
      conditions.push(`i.issued_at <= $${paramIndex}`);
      params.push(date_to);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    // Count total
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM invoices i WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Fetch page
    const dataParams = [...params, limitNum, offset];
    const result = await db.query(
      `SELECT i.id, i.invoice_number, i.type, i.subtotal, i.tax_amount,
        i.discount_amount, i.total_amount, i.paid_amount, i.payment_status,
        i.payment_method, i.issued_at, i.due_date, i.created_at
       FROM invoices i
       WHERE ${whereClause}
       ORDER BY i.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      dataParams
    );

    return {
      invoices: result.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    };
  }

  /**
   * Get full invoice detail with payment history
   * @param {number} invoiceId - Invoice ID
   * @returns {Object} Invoice with payment transactions
   */
  async getInvoiceDetail(invoiceId) {
    if (!invoiceId) {
      throw AppError.badRequest('Invoice ID is required');
    }

    const invoiceResult = await db.query(
      `SELECT i.id, i.invoice_number, i.patient_uid, i.appointment_id, i.type,
        i.items, i.subtotal, i.tax_amount, i.discount_amount, i.total_amount,
        i.paid_amount, i.payment_status, i.payment_method, i.insurance_claim_id,
        i.notes, i.issued_by, i.issued_at, i.paid_at, i.due_date, i.created_at
       FROM invoices i
       WHERE i.id = $1`,
      [invoiceId]
    );

    if (invoiceResult.rows.length === 0) {
      throw AppError.notFound('Invoice not found');
    }

    const invoice = invoiceResult.rows[0];

    // Fetch payment transactions
    const txnResult = await db.query(
      `SELECT id, amount, payment_method, transaction_ref, status, processed_by, created_at
       FROM payment_transactions
       WHERE invoice_id = $1
       ORDER BY created_at DESC`,
      [invoiceId]
    );

    // Fetch linked insurance claim if any
    let insuranceClaim = null;
    if (invoice.insurance_claim_id) {
      const claimResult = await db.query(
        `SELECT id, claim_number, insurance_provider, policy_number, claim_amount,
          approved_amount, status, submitted_at, reviewed_at
         FROM insurance_claims WHERE id = $1`,
        [invoice.insurance_claim_id]
      );
      if (claimResult.rows.length > 0) {
        insuranceClaim = claimResult.rows[0];
      }
    }

    return {
      ...invoice,
      payment_transactions: txnResult.rows,
      insurance_claim: insuranceClaim
    };
  }

  /**
   * Get revenue statistics for a date range
   * @param {string} dateFrom - Start date
   * @param {string} dateTo - End date
   * @returns {Object} Revenue stats
   */
  async getRevenueStats(dateFrom, dateTo) {
    if (!dateFrom || !dateTo) {
      throw AppError.badRequest('dateFrom and dateTo are required');
    }

    // Revenue by type
    const byTypeResult = await db.readQuery(
      `SELECT type,
        COUNT(*) as invoice_count,
        SUM(total_amount) as total_billed,
        SUM(paid_amount) as total_collected,
        SUM(total_amount - paid_amount) as outstanding
       FROM invoices
       WHERE issued_at >= $1 AND issued_at <= $2
       GROUP BY type
       ORDER BY total_billed DESC`,
      [dateFrom, dateTo]
    );

    // Revenue by payment method
    const byMethodResult = await db.readQuery(
      `SELECT payment_method,
        COUNT(*) as transaction_count,
        SUM(amount) as total_amount
       FROM payment_transactions
       WHERE created_at >= $1 AND created_at <= $2
       GROUP BY payment_method
       ORDER BY total_amount DESC`,
      [dateFrom, dateTo]
    );

    // Daily totals
    const dailyResult = await db.readQuery(
      `SELECT DATE(issued_at) as date,
        COUNT(*) as invoice_count,
        SUM(total_amount) as billed,
        SUM(paid_amount) as collected
       FROM invoices
       WHERE issued_at >= $1 AND issued_at <= $2
       GROUP BY DATE(issued_at)
       ORDER BY date`,
      [dateFrom, dateTo]
    );

    // Summary totals
    const summaryResult = await db.readQuery(
      `SELECT
        COUNT(*) as total_invoices,
        SUM(total_amount) as total_billed,
        SUM(paid_amount) as total_collected,
        SUM(total_amount - paid_amount) as total_outstanding,
        SUM(discount_amount) as total_discounts,
        SUM(tax_amount) as total_taxes,
        COUNT(*) FILTER (WHERE payment_status = 'paid') as paid_count,
        COUNT(*) FILTER (WHERE payment_status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE payment_status = 'partial') as partial_count
       FROM invoices
       WHERE issued_at >= $1 AND issued_at <= $2`,
      [dateFrom, dateTo]
    );

    return {
      summary: summaryResult.rows[0],
      by_type: byTypeResult.rows,
      by_payment_method: byMethodResult.rows,
      daily_totals: dailyResult.rows
    };
  }

  /**
   * Submit an insurance claim
   * @param {Object} data - Claim data
   * @returns {Object} Created claim
   */
  async submitInsuranceClaim(data) {
    const {
      patient_uid, invoice_id, insurance_provider,
      policy_number, claim_amount, documents = []
    } = data;

    if (!patient_uid) {
      throw AppError.badRequest('Patient UID is required');
    }
    if (!insurance_provider || !policy_number) {
      throw AppError.badRequest('Insurance provider and policy number are required');
    }
    if (!claim_amount || claim_amount <= 0) {
      throw AppError.badRequest('Claim amount must be greater than zero');
    }

    // Validate invoice exists if provided
    if (invoice_id) {
      const invoiceCheck = await db.query(
        `SELECT id, patient_uid FROM invoices WHERE id = $1`,
        [invoice_id]
      );
      if (invoiceCheck.rows.length === 0) {
        throw AppError.notFound('Linked invoice not found');
      }
      if (invoiceCheck.rows[0].patient_uid !== patient_uid) {
        throw AppError.badRequest('Invoice does not belong to the specified patient');
      }
    }

    const claimNumber = await this._generateClaimNumber();

    const result = await db.query(
      `INSERT INTO insurance_claims (
        claim_number, patient_uid, invoice_id, insurance_provider,
        policy_number, claim_amount, documents
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, claim_number, patient_uid, invoice_id, insurance_provider,
        policy_number, claim_amount, approved_amount, status, submitted_at,
        documents, created_at`,
      [claimNumber, patient_uid, invoice_id || null, insurance_provider,
       policy_number, claim_amount, documents]
    );

    // Link claim to invoice if provided
    if (invoice_id) {
      await db.query(
        `UPDATE invoices SET insurance_claim_id = $1 WHERE id = $2`,
        [result.rows[0].id, invoice_id]
      );
    }

    logger.info(`Insurance claim created: ${claimNumber} for patient ${patient_uid}`);
    return result.rows[0];
  }

  /**
   * Update insurance claim status
   * @param {number} claimId - Claim ID
   * @param {string} status - New status
   * @param {number} approvedAmount - Approved amount (for approved/partially_approved)
   * @param {string} reason - Rejection reason (for rejected)
   * @returns {Object} Updated claim
   */
  async updateClaimStatus(claimId, status, approvedAmount = null, reason = null) {
    if (!claimId) {
      throw AppError.badRequest('Claim ID is required');
    }
    if (!status || !VALID_CLAIM_STATUSES.includes(status)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${VALID_CLAIM_STATUSES.join(', ')}`);
    }

    const existing = await db.query(
      `SELECT id, status FROM insurance_claims WHERE id = $1`,
      [claimId]
    );
    if (existing.rows.length === 0) {
      throw AppError.notFound('Insurance claim not found');
    }

    const reviewedAt = ['approved', 'partially_approved', 'rejected'].includes(status)
      ? new Date()
      : null;

    const result = await db.query(
      `UPDATE insurance_claims
       SET status = $1, approved_amount = $2, rejection_reason = $3, reviewed_at = $4
       WHERE id = $5
       RETURNING id, claim_number, patient_uid, invoice_id, insurance_provider,
         policy_number, claim_amount, approved_amount, status, submitted_at,
         reviewed_at, rejection_reason, documents, created_at`,
      [status, approvedAmount, reason, reviewedAt, claimId]
    );

    logger.info(`Insurance claim ${claimId} updated to status: ${status}`);
    return result.rows[0];
  }

  /**
   * List insurance claims with filters
   * @param {Object} filters - Filters (patient_uid, status, page, limit)
   * @returns {Object} Claims list with pagination
   */
  async getInsuranceClaims(filters = {}) {
    const { patient_uid, status, page = 1, limit = 20 } = filters;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (patient_uid) {
      conditions.push(`ic.patient_uid = $${paramIndex}`);
      params.push(patient_uid);
      paramIndex++;
    }
    if (status && VALID_CLAIM_STATUSES.includes(status)) {
      conditions.push(`ic.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM insurance_claims ic ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const dataParams = [...params, limitNum, offset];
    const result = await db.query(
      `SELECT ic.id, ic.claim_number, ic.patient_uid, ic.invoice_id,
        ic.insurance_provider, ic.policy_number, ic.claim_amount,
        ic.approved_amount, ic.status, ic.submitted_at, ic.reviewed_at,
        ic.rejection_reason, ic.created_at
       FROM insurance_claims ic
       ${whereClause}
       ORDER BY ic.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      dataParams
    );

    return {
      claims: result.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    };
  }
}

export default new BillingService();
