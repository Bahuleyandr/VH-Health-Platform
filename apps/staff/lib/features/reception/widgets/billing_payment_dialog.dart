import 'package:flutter/material.dart';

import '../../../core/services/billing_api_service.dart';
import '../../../core/theme/app_theme.dart';

Future<bool> showBillingPaymentDialog({
  required BuildContext context,
  required Map<String, dynamic> invoice,
}) async {
  final id = _intFrom(invoice['id']);
  final due = billingInvoiceAmountDue(invoice);
  if (id == null || due <= 0) return false;

  final amountCtrl = TextEditingController(
    text: due.toStringAsFixed(due.truncateToDouble() == due ? 0 : 2),
  );
  final referenceCtrl = TextEditingController();
  final shiftCtrl = TextEditingController();
  final notesCtrl = TextEditingController();
  var mode = 'UPI';
  var saving = false;
  String? dialogError;

  final collected = await showDialog<bool>(
    context: context,
    builder: (dialogContext) {
      return StatefulBuilder(
        builder: (context, setDialogState) {
          Future<void> collect() async {
            final amount = num.tryParse(amountCtrl.text.trim());
            final reference = referenceCtrl.text.trim();
            final shift = shiftCtrl.text.trim();
            if (amount == null || amount <= 0) {
              setDialogState(
                () => dialogError = 'Enter a payment amount greater than 0.',
              );
              return;
            }
            if (amount > due + 0.01) {
              setDialogState(
                () => dialogError =
                    'Payment cannot exceed outstanding due ${billingMoney(due)}.',
              );
              return;
            }
            if (mode == 'CASH' && shift.isEmpty) {
              setDialogState(
                () => dialogError =
                    'Cash payments require a cashier shift for drawer reconciliation.',
              );
              return;
            }
            if (mode != 'CASH' && reference.isEmpty) {
              setDialogState(
                () => dialogError =
                    'Enter a transaction reference for non-cash payments.',
              );
              return;
            }

            setDialogState(() {
              saving = true;
              dialogError = null;
            });
            try {
              await BillingApiService.collectPayment(
                invoiceId: id,
                amount: amount,
                mode: mode,
                reference: reference.isEmpty ? null : reference,
                shift: shift.isEmpty ? null : shift,
                notes: notesCtrl.text.trim().isEmpty
                    ? null
                    : notesCtrl.text.trim(),
              );
              if (dialogContext.mounted) {
                Navigator.of(dialogContext).pop(true);
              }
            } catch (e) {
              setDialogState(() {
                dialogError = e.toString().replaceFirst('Exception: ', '');
                saving = false;
              });
            }
          }

          return AlertDialog(
            title: const Text('Collect Payment'),
            content: SizedBox(
              width: 520,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.receipt_long_outlined),
                      title: Text(
                        (invoice['invoice_number'] ?? '#$id').toString(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text('Outstanding ${billingMoney(due)}'),
                    ),
                    const SizedBox(height: 8),
                    TextField(
                      controller: amountCtrl,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                        labelText: 'Amount',
                        prefixIcon: Icon(Icons.currency_rupee),
                      ),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: mode,
                      decoration: const InputDecoration(
                        labelText: 'Mode',
                        prefixIcon: Icon(Icons.payments_outlined),
                      ),
                      items:
                          const [
                                'UPI',
                                'CARD',
                                'NETBANKING',
                                'CHEQUE',
                                'DD',
                                'WALLET',
                                'CASH',
                              ]
                              .map(
                                (value) => DropdownMenuItem(
                                  value: value,
                                  child: Text(value),
                                ),
                              )
                              .toList(),
                      onChanged: saving
                          ? null
                          : (value) =>
                                setDialogState(() => mode = value ?? mode),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: referenceCtrl,
                      textInputAction: TextInputAction.next,
                      decoration: InputDecoration(
                        labelText: mode == 'CASH'
                            ? 'Reference (optional)'
                            : 'Transaction reference',
                        prefixIcon: const Icon(Icons.numbers_outlined),
                      ),
                    ),
                    if (mode == 'CASH') ...[
                      const SizedBox(height: 12),
                      TextField(
                        controller: shiftCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Cashier shift',
                          prefixIcon: Icon(Icons.point_of_sale_outlined),
                        ),
                      ),
                    ],
                    const SizedBox(height: 12),
                    TextField(
                      controller: notesCtrl,
                      minLines: 2,
                      maxLines: 3,
                      decoration: const InputDecoration(
                        labelText: 'Notes',
                        prefixIcon: Icon(Icons.notes_outlined),
                      ),
                    ),
                    if (dialogError != null) ...[
                      const SizedBox(height: 10),
                      Text(
                        dialogError!,
                        style: TextStyle(color: AppTheme.errorOnSurface),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(
                onPressed: saving ? null : () => Navigator.pop(context),
                child: const Text('Cancel'),
              ),
              FilledButton.icon(
                onPressed: saving ? null : collect,
                icon: saving
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.payments_outlined),
                label: const Text('Collect'),
              ),
            ],
          );
        },
      );
    },
  );

  amountCtrl.dispose();
  referenceCtrl.dispose();
  shiftCtrl.dispose();
  notesCtrl.dispose();

  return collected == true;
}

bool billingInvoiceCanCollect(Map<String, dynamic> invoice) {
  final status = invoice['status']?.toString().toUpperCase() ?? 'DRAFT';
  return status != 'DRAFT' &&
      status != 'VOID' &&
      status != 'PAID' &&
      billingInvoiceAmountDue(invoice) > 0;
}

num billingInvoiceAmountDue(Map<String, dynamic> invoice) {
  final explicitDue = _numFrom(invoice['amount_due']);
  if (explicitDue != null) return explicitDue;
  final total = _numFrom(invoice['total_amount']) ?? 0;
  final paid = _numFrom(invoice['amount_paid']) ?? 0;
  final due = total - paid;
  return due < 0 ? 0 : due;
}

num billingInvoiceAmountPaid(Map<String, dynamic> invoice) {
  final explicitPaid = _numFrom(invoice['amount_paid']);
  if (explicitPaid != null) return explicitPaid < 0 ? 0 : explicitPaid;
  final total = _numFrom(invoice['total_amount']) ?? 0;
  final paid = total - billingInvoiceAmountDue(invoice);
  return paid < 0 ? 0 : paid;
}

String billingMoney(dynamic value) {
  final number = value is num ? value : num.tryParse(value?.toString() ?? '');
  if (number == null) return 'Rs 0';
  return 'Rs ${number.toStringAsFixed(number.truncateToDouble() == number ? 0 : 2)}';
}

int? _intFrom(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

num? _numFrom(dynamic value) {
  if (value is num) return value;
  return num.tryParse(value?.toString() ?? '');
}
