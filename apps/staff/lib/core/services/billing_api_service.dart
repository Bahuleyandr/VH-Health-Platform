import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:vhhealth_core/services/idempotency_key.dart';

import 'api_client.dart';

class BillingApiService {
  BillingApiService._();

  static Map<String, dynamic> _dataFrom(ApiResponse response) {
    if (!response.isSuccess) {
      throw Exception(response.failureMessage('Billing request failed'));
    }
    final raw = response.raw;
    if (raw is Map<String, dynamic>) {
      final data = raw['data'];
      if (data is Map<String, dynamic>) return data;
      if (data is Map) return Map<String, dynamic>.from(data);
      if (data is List) return {'data': data};
      return raw;
    }
    return const {};
  }

  static List<Map<String, dynamic>> _listFrom(Map<String, dynamic> data) {
    dynamic value =
        data['invoices'] ?? data['items'] ?? data['rows'] ?? data['data'];
    if (value is Map) {
      value =
          value['invoices'] ?? value['items'] ?? value['rows'] ?? value['data'];
    }
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  static Future<List<Map<String, dynamic>>> listInvoices({
    String? patientUid,
    String? patientId,
    String? admissionId,
    String? status,
    String? invoiceType,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await ApiClient.get(
      '/billing/v2/invoices',
      queryParameters: {
        if (patientUid != null && patientUid.trim().isNotEmpty)
          'patient_uid': patientUid.trim(),
        if (patientId != null && patientId.trim().isNotEmpty)
          'patient_id': patientId.trim(),
        if (admissionId != null && admissionId.trim().isNotEmpty)
          'admission_id': admissionId.trim(),
        if (status != null && status.trim().isNotEmpty) 'status': status.trim(),
        if (invoiceType != null && invoiceType.trim().isNotEmpty)
          'invoice_type': invoiceType.trim(),
        'page': '$page',
        'limit': '$limit',
      },
    );
    return _listFrom(_dataFrom(response));
  }

  static Future<Map<String, dynamic>> createDraftInvoice({
    required String patientUid,
    String? patientName,
    String? patientPhone,
    String? admissionId,
    String invoiceType = 'OP',
    String? department,
    String? notes,
  }) async {
    final response = await ApiClient.post(
      '/billing/v2/invoices',
      body: {
        'patient_uid': patientUid.trim(),
        if (patientName != null && patientName.trim().isNotEmpty)
          'patient_name': patientName.trim(),
        if (patientPhone != null && patientPhone.trim().isNotEmpty)
          'patient_phone': patientPhone.trim(),
        if (admissionId != null && admissionId.trim().isNotEmpty)
          'admission_id': admissionId.trim(),
        'invoice_type': invoiceType.trim().toUpperCase(),
        if (department != null && department.trim().isNotEmpty)
          'department': department.trim(),
        if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
      },
    );
    return _dataFrom(response);
  }

  static Future<Map<String, dynamic>> issueInvoice(int invoiceId) async {
    final response = await ApiClient.post(
      '/billing/v2/invoices/$invoiceId/issue',
      body: const {},
    );
    return _dataFrom(response);
  }

  /// POST /billing/v2/payments.
  ///
  /// Mounted with `requireIdempotencyKey({ required: true, scope:
  /// 'billing_payment' })`, so [idempotencyKey] is required — without it the
  /// call is a hard 400. Mint it with `IdempotencyAttempt` and hold it for the
  /// life of one collection attempt so a retry replays rather than posting the
  /// payment twice.
  static Future<Map<String, dynamic>> collectPayment({
    required int invoiceId,
    required num amount,
    required String mode,
    required String idempotencyKey,
    String? reference,
    String? shift,
    String? notes,
  }) async {
    final response = await ApiClient.post(
      '/billing/v2/payments',
      idempotencyKey: idempotencyKey,
      body: {
        'invoice_id': invoiceId,
        'amount': amount,
        'mode': mode.trim().toUpperCase(),
        if (reference != null && reference.trim().isNotEmpty)
          'reference': reference.trim(),
        if (shift != null && shift.trim().isNotEmpty) 'shift': shift.trim(),
        if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
      },
    );
    return _dataFrom(response);
  }

  static Future<List<Map<String, dynamic>>> listMedicationCreditNotes({
    String? status,
    int limit = 100,
  }) async {
    final response = await ApiClient.get(
      '/billing/v2/credit-notes',
      queryParameters: {
        if (status != null && status.trim().isNotEmpty)
          'status': status.trim().toLowerCase(),
        'limit': '$limit',
      },
    );
    return _listFrom(_dataFrom(response));
  }

  static Future<Map<String, dynamic>> getMedicationCreditNote(
    String creditNoteId,
  ) async {
    final response = await ApiClient.get(
      '/billing/v2/credit-notes/${creditNoteId.trim()}',
    );
    return _dataFrom(response);
  }

  static Future<Map<String, dynamic>> approveMedicationCreditNote({
    required String creditNoteId,
    String? idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/billing/v2/credit-notes/${creditNoteId.trim()}/approve',
      body: const {},
      idempotencyKey: idempotencyKey ?? IdempotencyKey.generate(),
    );
    return _dataFrom(response);
  }

  static Future<Map<String, dynamic>> rejectMedicationCreditNote({
    required String creditNoteId,
    required String rejectionReason,
    String? idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/billing/v2/credit-notes/${creditNoteId.trim()}/reject',
      body: {'rejection_reason': rejectionReason.trim()},
      idempotencyKey: idempotencyKey ?? IdempotencyKey.generate(),
    );
    return _dataFrom(response);
  }

  static Future<Map<String, dynamic>> applyMedicationCreditNote({
    required String creditNoteId,
    String? refundMode,
    String? idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/billing/v2/credit-notes/${creditNoteId.trim()}/apply',
      body: {
        if (refundMode != null && refundMode.trim().isNotEmpty)
          'refund_mode': refundMode.trim().toUpperCase(),
      },
      idempotencyKey: idempotencyKey ?? IdempotencyKey.generate(),
    );
    return _dataFrom(response);
  }

  static Future<Map<String, dynamic>> approveRefund(
    int refundId, {
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/billing/v2/refunds/$refundId/approve',
      body: const {},
      idempotencyKey: idempotencyKey,
    );
    return _dataFrom(response);
  }

  static Future<Map<String, dynamic>> getRefund(int refundId) async {
    final response = await ApiClient.get('/billing/v2/refunds/$refundId');
    return _dataFrom(response);
  }

  static Future<List<Map<String, dynamic>>> listRefunds({
    int? refundId,
    String? counterSaleVoidRequestId,
  }) async {
    final response = await ApiClient.get(
      '/billing/v2/refunds',
      queryParameters: {
        if (refundId != null) 'id': '$refundId',
        if (counterSaleVoidRequestId != null &&
            counterSaleVoidRequestId.trim().isNotEmpty)
          'counter_sale_void_request_id': counterSaleVoidRequestId.trim(),
      },
    );
    return _listFrom(_dataFrom(response));
  }

  static Future<Map<String, dynamic>> markRefundPaid({
    required int refundId,
    required String reference,
    String? cashDrawerSessionId,
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/billing/v2/refunds/$refundId/pay',
      body: {
        'reference': reference.trim(),
        if (cashDrawerSessionId != null &&
            cashDrawerSessionId.trim().isNotEmpty)
          'cash_drawer_session_id': cashDrawerSessionId.trim(),
      },
      idempotencyKey: idempotencyKey,
    );
    return _dataFrom(response);
  }

  static Future<Map<String, dynamic>> markOfflineElectronicRefundPaid({
    required int refundId,
    required String originalPaymentReference,
    required String providerName,
    required String providerRefundReference,
    required DateTime providerRefundedAt,
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/billing/v2/refunds/$refundId/pay/offline-electronic',
      body: {
        'original_payment_reference': originalPaymentReference.trim(),
        'provider_name': providerName.trim(),
        'provider_refund_reference': providerRefundReference.trim(),
        'provider_refunded_at': providerRefundedAt.toUtc().toIso8601String(),
      },
      idempotencyKey: idempotencyKey,
    );
    return _dataFrom(response);
  }

  static Future<List<Map<String, dynamic>>> listCashDrawerSessions({
    required String cashierUid,
    String status = 'open',
    int limit = 100,
  }) async {
    final response = await ApiClient.get(
      '/billing/v2/cash-drawer/sessions',
      queryParameters: {
        'cashier_uid': cashierUid.trim(),
        'status': status.trim().toLowerCase(),
        'limit': '$limit',
      },
    );
    return _listFrom(_dataFrom(response));
  }

  static Future<List<Map<String, dynamic>>> listGatewayRefundCandidates(
    int refundId,
  ) async {
    final response = await ApiClient.get(
      '/billing/gateway/refunds/$refundId/candidates',
    );
    return _listFrom(_dataFrom(response));
  }

  static Future<Map<String, dynamic>> initiateGatewayRefund({
    required int refundId,
    required int gatewayOrderId,
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/billing/gateway/refunds',
      body: {'billing_refund_id': refundId, 'gateway_order_id': gatewayOrderId},
      idempotencyKey: idempotencyKey,
    );
    return _dataFrom(response);
  }

  static Future<List<Map<String, dynamic>>> listGatewayRefundReconciliations({
    bool includeResolved = false,
    int limit = 50,
    int offset = 0,
  }) async {
    final response = await ApiClient.get(
      '/billing/gateway/refund-reconciliation',
      queryParameters: {
        'include_resolved': '$includeResolved',
        'limit': '$limit',
        'offset': '$offset',
      },
    );
    final data = _dataFrom(response);
    final value = data['refunds'];
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }

  static Future<Map<String, dynamic>> reconcileGatewayRefund({
    required int gatewayRefundId,
    required String disposition,
    required String evidenceReference,
    required String note,
  }) async {
    final normalizedDisposition = disposition.trim().toLowerCase();
    final response = await ApiClient.post(
      '/billing/gateway/refunds/$gatewayRefundId/reconcile',
      body: {
        'disposition': normalizedDisposition,
        'evidence_reference': evidenceReference.trim(),
        'note': note.trim(),
        if (normalizedDisposition == 'provider_not_refunded')
          'recovery_path': 'gateway_retry',
      },
    );
    return _dataFrom(response);
  }

  static Future<Uint8List> downloadTaxInvoicePdf(int invoiceId) async {
    final response = await ApiClient.getBytes(
      '/billing/v2/invoices/$invoiceId/tax-invoice-pdf',
      timeout: const Duration(seconds: 30),
    );
    return _pdfBytesFrom(response, 'Tax invoice download failed');
  }

  static Future<Uint8List> downloadReceiptPdf(int invoiceId) async {
    final response = await ApiClient.getBytes(
      '/billing/v2/invoices/$invoiceId/receipt-pdf',
      timeout: const Duration(seconds: 30),
    );
    return _pdfBytesFrom(response, 'Receipt download failed');
  }

  static Uint8List _pdfBytesFrom(http.Response response, String fallback) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.bodyBytes;
    }
    final parsed = ApiResponse.parse(response.statusCode, response.body);
    throw Exception(parsed.message ?? '$fallback (${response.statusCode})');
  }
}
