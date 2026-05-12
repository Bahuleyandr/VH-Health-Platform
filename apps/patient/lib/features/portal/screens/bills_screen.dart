// lib/features/portal/screens/bills_screen.dart
//
// Patient bills list — Sprint 10. Hits GET /portal/bills, scoped to
// the JWT (we never pass patient_uid). Tap a row to drill into the
// itemised bill + paid history; from there the patient can mint a
// UPI payment link if there's an outstanding amount.

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class _Bill {
  _Bill.fromJson(Map<String, dynamic> j)
    : id = j['id'] as int,
      number = j['invoice_number']?.toString(),
      date = (j['issued_at'] ?? j['created_at'])?.toString(),
      type = j['invoice_type']?.toString() ?? 'OP',
      status = (j['status']?.toString() ?? 'DRAFT').toUpperCase(),
      total = _toDouble(j['total_amount']),
      paid = _toDouble(j['amount_paid']),
      due = _toDouble(j['amount_due']);

  final int id;
  final String? number;
  final String? date;
  final String type;
  final String status;
  final double total;
  final double paid;
  final double due;
}

double _toDouble(dynamic v) => v == null
    ? 0.0
    : (v is num ? v.toDouble() : double.tryParse(v.toString()) ?? 0.0);

String _inr(double n) => '₹${n.toStringAsFixed(0)}';

String _fmtDate(String? iso) {
  if (iso == null || iso.isEmpty) return '';
  // ISO timestamps from the backend: take the date portion.
  return iso.split('T').first;
}

const _statusColours = <String, Color>{
  'DRAFT': Color(0xFF94A3B8),
  'ISSUED': Color(0xFF3B82F6),
  'PAID': Color(0xFF10B981),
  'PARTIAL': Color(0xFF34D399),
  'VOID': Color(0xFFEF4444),
  'REFUNDED': Color(0xFFF59E0B),
};

class BillsScreen extends StatefulWidget {
  const BillsScreen({super.key});

  @override
  State<BillsScreen> createState() => _BillsScreenState();
}

class _BillsScreenState extends State<BillsScreen> {
  bool _loading = true;
  String? _error;
  List<_Bill> _bills = [];

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
      final response = await ApiClient.get('/portal/bills');
      if (!mounted) return;
      if (response.isSuccess) {
        final list = response.dataAsList();
        setState(() {
          _bills = list
              .whereType<Map<String, dynamic>>()
              .map(_Bill.fromJson)
              .toList();
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.message ?? 'Failed to load bills';
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

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: 'Bills',
      icon: Icons.receipt_long,
      color: const Color(0xFFB3E5FC),
      child: RefreshIndicator(
        onRefresh: _fetch,
        child: DataStateBuilder<_Bill>(
          isLoading: _loading,
          error: _error,
          data: _bills,
          onRetry: _fetch,
          emptyIcon: Icons.receipt_long_outlined,
          emptyTitle: 'No bills yet',
          emptySubtitle:
              'Bills issued by the hospital will appear here. Pull to refresh.',
          builder: (context, bills) {
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: bills.length,
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemBuilder: (_, i) => _BillCard(bill: bills[i]),
            );
          },
        ),
      ),
    );
  }
}

class _BillCard extends StatelessWidget {
  const _BillCard({required this.bill});
  final _Bill bill;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final statusColour =
        _statusColours[bill.status] ?? theme.colorScheme.outline;
    final hasDue = bill.due > 0.01;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => context.push('/portal/bills/${bill.id}'),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      bill.number ?? 'Invoice #${bill.id}',
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: statusColour.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      bill.status,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: statusColour,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                '${bill.type} · ${_fmtDate(bill.date)}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  _amountBlock(theme, 'Total', _inr(bill.total)),
                  const SizedBox(width: 12),
                  _amountBlock(theme, 'Paid', _inr(bill.paid)),
                  const SizedBox(width: 12),
                  _amountBlock(theme, 'Due', _inr(bill.due), highlight: hasDue),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _amountBlock(
    ThemeData theme,
    String label,
    String value, {
    bool highlight = false,
  }) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
          Text(
            value,
            style: theme.textTheme.titleSmall?.copyWith(
              color: highlight ? theme.colorScheme.error : null,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
