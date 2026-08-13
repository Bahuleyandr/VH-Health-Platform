import 'dart:typed_data';

import 'package:http/http.dart' as http;

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
