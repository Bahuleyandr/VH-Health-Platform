// lib/features/portal/screens/bill_detail_screen.dart
//
// Bill detail — items + payments + "Pay now" UPI link.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class BillDetailScreen extends StatefulWidget {
  const BillDetailScreen({super.key, required this.invoiceId});
  final int invoiceId;

  @override
  State<BillDetailScreen> createState() => _BillDetailScreenState();
}

class _BillDetailScreenState extends State<BillDetailScreen> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _invoice;
  List<Map<String, dynamic>> _items = const [];
  List<Map<String, dynamic>> _payments = const [];
  Map<String, dynamic>? _tpaBreakdown;
  bool _generatingLink = false;
  String? _linkUrl;
  String? _linkToken;

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/portal/bills/${widget.invoiceId}');
      if (!mounted) return;
      if (response.isSuccess) {
        final data = response.dataAsMap();
        setState(() {
          _invoice = data['invoice'] as Map<String, dynamic>?;
          _items = (data['items'] as List? ?? [])
              .whereType<Map<String, dynamic>>()
              .toList();
          _payments = (data['payments'] as List? ?? [])
              .whereType<Map<String, dynamic>>()
              .toList();
          _tpaBreakdown = data['tpa_breakdown'] as Map<String, dynamic>?;
          _loading = false;
        });
      } else {
        final l = AppLocalizations.of(context)!;
        setState(() {
          _error = response.failureMessage(l.billDetailLoadFailed);
          _loading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _generatePaymentLink() async {
    setState(() {
      _generatingLink = true;
    });
    try {
      final response = await ApiClient.post(
        '/portal/bills/${widget.invoiceId}/payment-link',
      );
      if (!mounted) return;
      if (response.isSuccess) {
        final link = response.dataAsMap();
        setState(() {
          _linkUrl = link['upi_deep_link']?.toString();
          _linkToken = link['link_token']?.toString();
          _generatingLink = false;
        });
        if (_linkUrl != null) {
          // Hand off to the user's UPI app (PhonePe / GPay / Paytm) with the
          // amount pre-filled. SafeUrlLauncher allows the upi:// scheme.
          await SafeUrlLauncher.launch(
            _linkUrl!,
            mode: LaunchMode.externalApplication,
          );
        }
      } else {
        final l = AppLocalizations.of(context)!;
        setState(() {
          _generatingLink = false;
          _error = response.failureMessage(l.billDetailPaymentLinkFailed);
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _generatingLink = false;
        _error = e.toString();
      });
    }
  }

  double _toDouble(dynamic v) => v == null
      ? 0.0
      : (v is num ? v.toDouble() : double.tryParse(v.toString()) ?? 0.0);
  String _inr(double n) => '₹${n.toStringAsFixed(2)}';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final l = AppLocalizations.of(context)!;
    final due = _invoice == null ? 0.0 : _toDouble(_invoice!['amount_due']);
    final hasDue = due > 0.01;

    return FeatureScreenScaffold(
      title:
          _invoice?['invoice_number']?.toString() ??
          l.billsInvoiceFallback(widget.invoiceId),
      icon: Icons.receipt_long,
      color: colors.primary,
      scrollable: true,
      child: _loading
          ? const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: CircularProgressIndicator(),
              ),
            )
          : _error != null
          ? Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                children: [
                  Icon(
                    Icons.error_outline,
                    size: 48,
                    color: theme.colorScheme.error,
                  ),
                  const SizedBox(height: 16),
                  Text(_error!, textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  ElevatedButton(onPressed: _fetch, child: Text(l.commonRetry)),
                ],
              ),
            )
          : Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _summaryCard(theme, l, due, hasDue),
                  const SizedBox(height: 16),
                  if (hasDue) _payCard(theme, l, due),
                  if (hasDue) const SizedBox(height: 16),
                  if (_tpaBreakdown != null) _insuranceSection(theme, l),
                  if (_tpaBreakdown != null) const SizedBox(height: 16),
                  _itemsSection(theme, l),
                  const SizedBox(height: 16),
                  _paymentsSection(theme, l),
                ],
              ),
            ),
    );
  }

  Widget _summaryCard(
    ThemeData theme,
    AppLocalizations l,
    double due,
    bool hasDue,
  ) {
    final inv = _invoice ?? <String, dynamic>{};
    final discount = _toDouble(inv['discount_amount']);
    final igst = _toDouble(inv['igst_amount']);
    final cgst = _toDouble(inv['cgst_amount']);
    final sgst = _toDouble(inv['sgst_amount']);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l.tpaClaimSummary, style: theme.textTheme.titleMedium),
            const SizedBox(height: 12),
            _row(l.billDetailSubtotal, _inr(_toDouble(inv['subtotal']))),
            // Indian GST: intra-state shows CGST + SGST equal halves;
            // inter-state shows a single IGST line. We render whichever
            // variant has a non-zero amount.
            if (igst > 0)
              _row('IGST', _inr(igst))
            else if (cgst > 0 || sgst > 0) ...[
              _row('CGST', _inr(cgst)),
              _row('SGST', _inr(sgst)),
            ],
            if (discount > 0) _row(l.billDetailDiscount, '− ${_inr(discount)}'),
            const Divider(height: 24),
            _row(
              l.billsTotal,
              _inr(_toDouble(inv['total_amount'])),
              bold: true,
            ),
            _row(l.billsPaid, _inr(_toDouble(inv['amount_paid']))),
            _row(
              l.billsDue,
              _inr(due),
              bold: true,
              colour: hasDue ? theme.colorScheme.error : null,
            ),
          ],
        ),
      ),
    );
  }

  Widget _payCard(ThemeData theme, AppLocalizations l, double due) {
    return Card(
      color: theme.colorScheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l.billDetailPayViaUpi(_inr(due)),
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(l.billDetailPayViaUpiBody, style: theme.textTheme.bodySmall),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _generatingLink ? null : _generatePaymentLink,
              icon: _generatingLink
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.qr_code),
              label: Text(
                _generatingLink ? l.billDetailGenerating : l.billDetailPayNow,
              ),
            ),
            if (_linkToken != null) ...[
              const SizedBox(height: 8),
              Text(
                l.billDetailPaymentLinkReference(_linkToken!.substring(0, 12)),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _insuranceSection(ThemeData theme, AppLocalizations l) {
    final tpa = _tpaBreakdown;
    if (tpa == null) return const SizedBox.shrink();
    final summary = tpa['summary'] as Map<String, dynamic>? ?? const {};
    final claim = tpa['claim'] as Map<String, dynamic>? ?? const {};
    final lineDecisions = (tpa['line_decisions'] as List? ?? [])
        .whereType<Map<String, dynamic>>()
        .toList();
    final latestMessage =
        tpa['latest_insurer_message'] as Map<String, dynamic>?;

    final billed = _toDouble(summary['hospital_billed']);
    final approved = _toDouble(summary['tpa_approved']);
    final paid = _toDouble(summary['tpa_paid']);
    final disallowed = _toDouble(summary['tpa_disallowed']);
    final nonPayable = _toDouble(summary['non_payable']);
    final copay = _toDouble(summary['patient_copay']);
    final patientShare = _toDouble(summary['patient_share']);
    final claimNumber = claim['claim_number']?.toString();
    final claimStatus = claim['status']?.toString();

    return Card(
      // Tint the insurance section so it reads as a distinct block, not
      // another GST sub-card.
      color: theme.colorScheme.secondaryContainer.withValues(alpha: 0.4),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.shield_outlined, color: theme.colorScheme.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    l.billDetailInsuranceBreakdown,
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                if (claimStatus != null)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surface,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      claimStatus.replaceAll('_', ' '),
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
              ],
            ),
            if (claimNumber != null) ...[
              const SizedBox(height: 4),
              Text(
                l.billDetailClaimNumber(claimNumber),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
            ],
            const SizedBox(height: 12),
            _row(l.billDetailTotalBilled, _inr(billed)),
            _row(l.tpaClaimTpaApproved, _inr(approved)),
            _row(l.billDetailTpaPaid, _inr(paid)),
            if (disallowed > 0) _row(l.tpaClaimTpaDisallowed, _inr(disallowed)),
            if (copay > 0) _row(l.tpaClaimPolicyCopay, _inr(copay)),
            if (nonPayable > 0)
              _row(l.tpaClaimNonPayableItems, _inr(nonPayable)),
            if (patientShare > 0)
              _row(
                l.billDetailPatientShare,
                _inr(patientShare),
                bold: true,
                colour: theme.colorScheme.error,
              ),
            if (lineDecisions.isNotEmpty) ...[
              const Divider(height: 24),
              Text(
                l.billDetailWhatWasNotCovered,
                style: theme.textTheme.titleSmall,
              ),
              const SizedBox(height: 8),
              ...lineDecisions.map((d) => _decisionRow(theme, d)),
            ],
            if (latestMessage != null) ...[
              const Divider(height: 24),
              Text(
                l.billDetailLatestInsurerNote,
                style: theme.textTheme.titleSmall,
              ),
              const SizedBox(height: 6),
              if (latestMessage['subject'] != null)
                Text(
                  latestMessage['subject'].toString(),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              if (latestMessage['body'] != null) ...[
                const SizedBox(height: 4),
                Text(
                  latestMessage['body'].toString(),
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ],
            if (claim['id'] != null) ...[
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: () {
                    final claimId = claim['id'];
                    final id = claimId is int
                        ? claimId
                        : int.tryParse(claimId.toString());
                    if (id == null) return;
                    context.push('/portal/tpa/claims/$id');
                  },
                  icon: const Icon(Icons.open_in_new, size: 16),
                  label: Text(l.billDetailViewFullInsuranceClaim),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _decisionRow(ThemeData theme, Map<String, dynamic> d) {
    final desc = d['item_description']?.toString() ?? '—';
    final amount = _toDouble(d['non_payable_amount']);
    final label =
        d['reason_label']?.toString() ??
        d['reason_text']?.toString() ??
        d['reason_code']?.toString() ??
        '';
    final reasonText = d['reason_text']?.toString();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(desc, style: theme.textTheme.bodyMedium)),
              const SizedBox(width: 8),
              Text(
                '− ${_inr(amount)}',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.error,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          if (label.isNotEmpty)
            Text(
              label,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.outline,
              ),
            ),
          if (reasonText != null &&
              reasonText.isNotEmpty &&
              reasonText != label)
            Text(
              reasonText,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.outline,
                fontStyle: FontStyle.italic,
              ),
            ),
        ],
      ),
    );
  }

  Widget _itemsSection(ThemeData theme, AppLocalizations l) {
    if (_items.isEmpty) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l.billDetailItems, style: theme.textTheme.titleMedium),
            const SizedBox(height: 12),
            ...(_items.map((item) {
              final qty = _toDouble(item['quantity']);
              final unit = _toDouble(item['unit_price']);
              final total = _toDouble(item['line_total']);
              return Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(item['description']?.toString() ?? '—'),
                    Text(
                      '${qty.toStringAsFixed(qty == qty.toInt() ? 0 : 2)} × ${_inr(unit)}',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.outline,
                      ),
                    ),
                    Align(
                      alignment: Alignment.centerRight,
                      child: Text(
                        _inr(total),
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            })),
          ],
        ),
      ),
    );
  }

  Widget _paymentsSection(ThemeData theme, AppLocalizations l) {
    if (_payments.isEmpty) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              l.billDetailPaymentHistory,
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            ...(_payments.map((p) {
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    Icon(
                      p['reversed'] == true
                          ? Icons.replay
                          : Icons.check_circle_outline,
                      color: p['reversed'] == true
                          ? theme.colorScheme.outline
                          : Colors.green,
                      size: 20,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(_inr(_toDouble(p['amount']))),
                          if (p['reference'] != null)
                            Text(
                              '${p['mode']} · ${p['reference']}',
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.colorScheme.outline,
                              ),
                            ),
                        ],
                      ),
                    ),
                    Text(
                      (p['collected_at']?.toString() ?? '').split('T').first,
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              );
            })),
          ],
        ),
      ),
    );
  }

  Widget _row(String label, String value, {bool bold = false, Color? colour}) {
    final theme = Theme.of(context);
    final style =
        (bold ? theme.textTheme.titleSmall : theme.textTheme.bodyMedium)
            ?.copyWith(color: colour);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.outline,
              ),
            ),
          ),
          Text(value, style: style),
        ],
      ),
    );
  }
}
