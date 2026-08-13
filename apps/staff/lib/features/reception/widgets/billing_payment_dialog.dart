import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

import '../../../core/services/billing_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../l10n/app_strings.dart';

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
  final formKey = GlobalKey<FormState>();
  var mode = 'UPI';
  var saving = false;
  String? dialogError;
  // Scoped to this dialog, i.e. to one payment-collection attempt. `saving`
  // blocks a second tap; this makes the retry of a request whose 2xx was lost
  // replay server-side instead of recording the cash twice.
  final paymentAttempt = IdempotencyAttempt('billing-payment');

  final collected = await showDialog<bool>(
    context: context,
    builder: (dialogContext) {
      return StatefulBuilder(
        builder: (context, setDialogState) {
          final s = AppStrings.of(context);

          void focusNextField() {
            FocusScope.of(context).nextFocus();
          }

          void handleNewline(
            TextEditingController controller,
            String value,
            VoidCallback action,
          ) {
            if (!value.contains('\n')) return;
            final cleaned = value.replaceAll(RegExp(r'\s*\n\s*'), ' ');
            controller.value = TextEditingValue(
              text: cleaned,
              selection: TextSelection.collapsed(offset: cleaned.length),
            );
            action();
          }

          Future<void> collect() async {
            if (saving) return;
            if (!(formKey.currentState?.validate() ?? false)) {
              setDialogState(() => dialogError = null);
              return;
            }
            final amount = num.parse(amountCtrl.text.trim());
            final reference = referenceCtrl.text.trim();
            final shift = shiftCtrl.text.trim();

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
                idempotencyKey: paymentAttempt.keyFor({
                  'invoice_id': id,
                  'amount': amount,
                  'mode': mode,
                  'reference': reference,
                  'shift': shift,
                  'notes': notesCtrl.text.trim(),
                }),
              );
              if (dialogContext.mounted) {
                Navigator.of(dialogContext).pop(true);
              }
            } catch (e) {
              setDialogState(() {
                dialogError = localizedApiErrorFromRaw(s, e);
                saving = false;
              });
            }
          }

          return FocusTraversalGroup(
            child: AlertDialog(
              title: Text(s.billingCollectPaymentTitle),
              content: SizedBox(
                width: 520,
                child: SingleChildScrollView(
                  child: Form(
                    key: formKey,
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
                          subtitle: Text(
                            s.billingOutstandingAmount(billingMoney(due)),
                          ),
                        ),
                        const SizedBox(height: 8),
                        TextFormField(
                          controller: amountCtrl,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          textInputAction: TextInputAction.next,
                          onFieldSubmitted: (_) => focusNextField(),
                          decoration: InputDecoration(
                            labelText: s.billingAmountLabel,
                            prefixIcon: const Icon(Icons.currency_rupee),
                          ),
                          validator: (value) {
                            final amount = num.tryParse(value?.trim() ?? '');
                            if (amount == null || amount <= 0) {
                              return s.billingPaymentAmountError;
                            }
                            if (amount > due + 0.01) {
                              return s.billingPaymentExceedsDue(
                                billingMoney(due),
                              );
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 12),
                        DropdownButtonFormField<String>(
                          initialValue: mode,
                          decoration: InputDecoration(
                            labelText: s.billingModeLabel,
                            prefixIcon: const Icon(Icons.payments_outlined),
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
                              : (value) => setDialogState(() {
                                  mode = value ?? mode;
                                  dialogError = null;
                                }),
                        ),
                        const SizedBox(height: 12),
                        TextFormField(
                          controller: referenceCtrl,
                          textInputAction: TextInputAction.next,
                          onFieldSubmitted: (_) => focusNextField(),
                          decoration: InputDecoration(
                            labelText: mode == 'CASH'
                                ? s.billingReferenceOptional
                                : s.billingTransactionReference,
                            prefixIcon: const Icon(Icons.numbers_outlined),
                          ),
                          validator: (value) {
                            if (mode == 'CASH') return null;
                            return (value ?? '').trim().isEmpty
                                ? s.billingReferenceRequired
                                : null;
                          },
                        ),
                        if (mode == 'CASH') ...[
                          const SizedBox(height: 12),
                          TextFormField(
                            controller: shiftCtrl,
                            textInputAction: TextInputAction.next,
                            onFieldSubmitted: (_) => focusNextField(),
                            decoration: InputDecoration(
                              labelText: s.billingCashierShiftLabel,
                              prefixIcon: const Icon(
                                Icons.point_of_sale_outlined,
                              ),
                            ),
                            validator: (value) => (value ?? '').trim().isEmpty
                                ? s.billingCashShiftRequired
                                : null,
                          ),
                        ],
                        const SizedBox(height: 12),
                        TextField(
                          controller: notesCtrl,
                          keyboardType: TextInputType.text,
                          textInputAction: TextInputAction.done,
                          onSubmitted: (_) => collect(),
                          onChanged: (value) =>
                              handleNewline(notesCtrl, value, collect),
                          minLines: 2,
                          maxLines: 3,
                          decoration: InputDecoration(
                            labelText: s.billingNotesLabel,
                            prefixIcon: const Icon(Icons.notes_outlined),
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
              ),
              actions: [
                TextButton(
                  onPressed: saving ? null : () => Navigator.pop(context),
                  child: Text(s.actionCancel),
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
                  label: Text(s.billingCollectButton),
                ),
              ],
            ),
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
