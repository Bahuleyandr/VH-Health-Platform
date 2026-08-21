import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

import '../../../core/services/billing_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import 'billing_payment_dialog.dart';

enum BillingDocumentType { taxInvoice, receipt }

Future<void> printBillingDocument({
  required BuildContext context,
  required Map<String, dynamic> invoice,
  required BillingDocumentType type,
}) async {
  final s = AppStrings.of(context);
  final invoiceId = billingInvoiceId(invoice);
  if (invoiceId == null) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(s.billingInvoiceIdMissing)));
    return;
  }

  final label = type == BillingDocumentType.receipt
      ? s.billingReceiptLabel
      : s.billingTaxInvoiceLabel;
  final fileLabel = type == BillingDocumentType.receipt
      ? 'receipt'
      : 'tax invoice';
  try {
    final bytes = type == BillingDocumentType.receipt
        ? await BillingApiService.downloadReceiptPdf(invoiceId)
        : await BillingApiService.downloadTaxInvoicePdf(invoiceId);
    await Printing.layoutPdf(
      name: '${fileLabel.replaceAll(' ', '_')}_$invoiceId.pdf',
      onLayout: (_) async => bytes,
    );
  } catch (e) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          s.billingCouldNotOpenDocument(
            label,
            e.toString().replaceFirst('Exception: ', ''),
          ),
        ),
        backgroundColor: AppTheme.errorRed,
      ),
    );
  }
}

bool billingInvoiceCanPrintTaxInvoice(Map<String, dynamic> invoice) {
  final status = invoice['status']?.toString().toUpperCase() ?? 'DRAFT';
  return billingInvoiceId(invoice) != null &&
      status != 'DRAFT' &&
      status != 'VOID';
}

bool billingInvoiceCanPrintReceipt(Map<String, dynamic> invoice) {
  final status = invoice['status']?.toString().toUpperCase() ?? 'DRAFT';
  return billingInvoiceId(invoice) != null &&
      status != 'DRAFT' &&
      status != 'VOID' &&
      billingInvoiceAmountPaid(invoice) > 0;
}

int? billingInvoiceId(Map<String, dynamic> invoice) {
  final value = invoice['id'];
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}
