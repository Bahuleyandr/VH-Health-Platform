// lib/features/portal/screens/bill_detail_screen.dart
//
// Bill detail — items + payments + "Pay now" UPI link.

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

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
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.message ?? 'Failed to load bill';
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
        setState(() {
          _generatingLink = false;
          _error = response.message ?? 'Could not generate payment link';
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

  double _toDouble(dynamic v) =>
      v == null ? 0.0 : (v is num ? v.toDouble() : double.tryParse(v.toString()) ?? 0.0);
  String _inr(double n) => '₹${n.toStringAsFixed(2)}';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final due = _invoice == null ? 0.0 : _toDouble(_invoice!['amount_due']);
    final hasDue = due > 0.01;

    return FeatureScreenScaffold(
      title: _invoice?['invoice_number']?.toString() ??
          'Invoice #${widget.invoiceId}',
      icon: Icons.receipt_long,
      color: const Color(0xFFB3E5FC),
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
                      ElevatedButton(onPressed: _fetch, child: const Text('Retry')),
                    ],
                  ),
                )
              : Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _summaryCard(theme, due, hasDue),
                      const SizedBox(height: 16),
                      if (hasDue) _payCard(theme, due),
                      if (hasDue) const SizedBox(height: 16),
                      _itemsSection(theme),
                      const SizedBox(height: 16),
                      _paymentsSection(theme),
                    ],
                  ),
                ),
    );
  }

  Widget _summaryCard(ThemeData theme, double due, bool hasDue) {
    final inv = _invoice ?? {};
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Summary', style: theme.textTheme.titleMedium),
            const SizedBox(height: 12),
            _row('Subtotal', _inr(_toDouble(inv['subtotal']))),
            _row('GST', _inr(_toDouble(inv['gst_total']))),
            if (_toDouble(inv['discount_total']) > 0)
              _row('Discount', '− ${_inr(_toDouble(inv['discount_total']))}'),
            const Divider(height: 24),
            _row(
              'Total',
              _inr(_toDouble(inv['grand_total'])),
              bold: true,
            ),
            _row('Paid', _inr(_toDouble(inv['amount_paid']))),
            _row(
              'Due',
              _inr(due),
              bold: true,
              colour: hasDue ? theme.colorScheme.error : null,
            ),
          ],
        ),
      ),
    );
  }

  Widget _payCard(ThemeData theme, double due) {
    return Card(
      color: theme.colorScheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Pay ${_inr(due)} via UPI',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(
              'Tap to open your UPI app (PhonePe / GPay / Paytm) with the amount pre-filled.',
              style: theme.textTheme.bodySmall,
            ),
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
              label: Text(_generatingLink ? 'Generating…' : 'Pay now'),
            ),
            if (_linkToken != null) ...[
              const SizedBox(height: 8),
              Text(
                'Payment link reference: ${_linkToken!.substring(0, 12)}…',
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

  Widget _itemsSection(ThemeData theme) {
    if (_items.isEmpty) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Items', style: theme.textTheme.titleMedium),
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

  Widget _paymentsSection(ThemeData theme) {
    if (_payments.isEmpty) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Payment history', style: theme.textTheme.titleMedium),
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
