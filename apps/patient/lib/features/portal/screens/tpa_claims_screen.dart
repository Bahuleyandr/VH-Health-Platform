// lib/features/portal/screens/tpa_claims_screen.dart
//
// Patient TPA / cashless claims list + detail. Hits
// GET /portal/tpa/claims (list) and GET /portal/tpa/claims/:id
// (detail with summary + invoice breakdown + recorded insurer
// correspondence). Scoped to the patient JWT — we never pass
// patient_uid in the body.
//
// Finding 2026-05-10-tpa-insurance-claim-patient-claim-breakdown-500:
// before this screen existed, the patient app only exposed
// /portal/bills, which shows two payment rows but not the cashless
// claim status, short-paid amount, or insurer disallowance
// explanation. This surface fills that gap.

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/services/api_client.dart';

class TpaClaimsScreen extends StatefulWidget {
  const TpaClaimsScreen({super.key});

  @override
  State<TpaClaimsScreen> createState() => _TpaClaimsScreenState();
}

class _TpaClaimsScreenState extends State<TpaClaimsScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _claims = [];

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
      final response = await ApiClient.get('/portal/tpa/claims');
      if (!mounted) return;
      if (response.isSuccess) {
        final list = response.dataAsList();
        setState(() {
          _claims = list.whereType<Map<String, dynamic>>().toList();
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.message ?? 'Failed to load claims';
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = 'Unable to load claims';
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Insurance claims')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(_error!, style: theme.textTheme.bodyLarge),
                  const SizedBox(height: 12),
                  FilledButton.tonal(
                    onPressed: _fetch,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            )
          : _claims.isEmpty
          ? const Center(child: Text('No insurance claims yet'))
          : RefreshIndicator(
              onRefresh: _fetch,
              child: ListView.builder(
                itemCount: _claims.length,
                itemBuilder: (context, i) {
                  final c = _claims[i];
                  return _TpaClaimCard(claim: c);
                },
              ),
            ),
    );
  }
}

class _TpaClaimCard extends StatelessWidget {
  final Map<String, dynamic> claim;
  const _TpaClaimCard({required this.claim});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = (claim['status'] ?? '').toString();
    final type = (claim['claim_type'] ?? '').toString();
    final claimed = _toNum(claim['claimed_amount']);
    final approved = _toNum(claim['approved_amount']);
    final paid = _toNum(claim['paid_amount']);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => TpaClaimDetailScreen(claimId: claim['id'] as int),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      claim['claim_number']?.toString() ?? 'Claim',
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  Chip(
                    label: Text(status, style: const TextStyle(fontSize: 11)),
                    visualDensity: VisualDensity.compact,
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                type.toUpperCase(),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 8),
              _kv(theme, 'Claimed', _inr(claimed)),
              _kv(theme, 'Approved', _inr(approved)),
              _kv(theme, 'Paid by insurer', _inr(paid)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _kv(ThemeData theme, String k, String v) => Padding(
    padding: const EdgeInsets.only(top: 2),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(k, style: theme.textTheme.bodySmall),
        Text(
          v,
          style: theme.textTheme.bodySmall?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    ),
  );
}

class TpaClaimDetailScreen extends StatefulWidget {
  final int claimId;
  const TpaClaimDetailScreen({super.key, required this.claimId});

  @override
  State<TpaClaimDetailScreen> createState() => _TpaClaimDetailScreenState();
}

class _TpaClaimDetailScreenState extends State<TpaClaimDetailScreen> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _data;

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
      final resp = await ApiClient.get('/portal/tpa/claims/${widget.claimId}');
      if (!mounted) return;
      if (resp.isSuccess) {
        setState(() {
          _data = resp.dataAsMap();
          _loading = false;
        });
      } else {
        setState(() {
          _error = resp.message ?? 'Failed to load claim';
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = 'Unable to load claim';
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Claim breakdown')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(child: Text(_error!))
          : _data == null
          ? const Center(child: Text('No data'))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: _buildContent(theme),
            ),
    );
  }

  List<Widget> _buildContent(ThemeData theme) {
    final data = _data!;
    final claim = (data['claim'] as Map?)?.cast<String, dynamic>() ?? {};
    final summary = (data['summary'] as Map?)?.cast<String, dynamic>() ?? {};
    final latest = (data['latest_insurer_message'] as Map?)
        ?.cast<String, dynamic>();
    final correspondence = (data['correspondence'] as List?) ?? const [];
    final invoiceBreakdown = (data['invoice_breakdown'] as Map?)
        ?.cast<String, dynamic>();
    final widgets = <Widget>[];

    widgets.add(
      Text(
        claim['claim_number']?.toString() ?? 'Claim',
        style: theme.textTheme.titleLarge,
      ),
    );
    widgets.add(const SizedBox(height: 4));
    widgets.add(
      Text(
        '${claim['policy_number'] ?? ''} • ${claim['claim_type'] ?? ''}',
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
    widgets.add(const SizedBox(height: 16));

    widgets.add(_summaryCard(theme, summary));

    if (latest != null) {
      widgets.add(const SizedBox(height: 16));
      widgets.add(_insurerMessageCard(theme, latest));
    }
    if (claim['denial_reason'] != null &&
        '${claim['denial_reason']}'.trim().isNotEmpty) {
      widgets.add(const SizedBox(height: 8));
      widgets.add(_denialReasonCard(theme, '${claim['denial_reason']}'));
    }

    if (invoiceBreakdown != null) {
      final lines = (invoiceBreakdown['lines'] as List?) ?? const [];
      if (lines.isNotEmpty) {
        widgets.add(const SizedBox(height: 16));
        widgets.add(_invoiceBreakdownCard(theme, lines, invoiceBreakdown));
      }
    }

    if (correspondence.isNotEmpty) {
      widgets.add(const SizedBox(height: 16));
      widgets.add(_correspondenceList(theme, correspondence));
    }
    return widgets;
  }

  Widget _summaryCard(ThemeData theme, Map<String, dynamic> s) {
    final hospital = _toNum(s['hospital_billed']);
    final claimed = _toNum(s['tpa_claimed']);
    final approved = _toNum(s['tpa_approved']);
    final paid = _toNum(s['tpa_paid']);
    final patient = _toNum(s['patient_responsibility']);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Summary', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            _row(theme, 'Hospital billed', hospital),
            _row(theme, 'TPA claimed', claimed),
            _row(theme, 'TPA approved', approved),
            _row(theme, 'Paid by insurer', paid, highlight: true),
            const Divider(),
            _row(theme, 'You paid', patient, highlight: true),
          ],
        ),
      ),
    );
  }

  Widget _insurerMessageCard(ThemeData theme, Map<String, dynamic> m) {
    return Card(
      color: theme.colorScheme.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.email_outlined, color: theme.colorScheme.tertiary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Latest insurer message',
                    style: theme.textTheme.titleSmall,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (m['subject'] != null)
              Text(
                m['subject'].toString(),
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            if (m['body'] != null) ...[
              const SizedBox(height: 4),
              Text(m['body'].toString(), style: theme.textTheme.bodySmall),
            ],
          ],
        ),
      ),
    );
  }

  Widget _denialReasonCard(ThemeData theme, String reason) {
    return Card(
      color: theme.colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.report_outlined, color: theme.colorScheme.error),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Why an amount was disallowed',
                    style: theme.textTheme.titleSmall,
                  ),
                  const SizedBox(height: 4),
                  Text(reason, style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _invoiceBreakdownCard(
    ThemeData theme,
    List lines,
    Map<String, dynamic> breakdown,
  ) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Invoice breakdown', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            ...lines.map((l) {
              final m = (l as Map).cast<String, dynamic>();
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(m['category']?.toString() ?? '—'),
                    Text(
                      _inr(_toNum(m['total'])),
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
              );
            }),
            const Divider(),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'Total',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
                Text(
                  _inr(_toNum(breakdown['total'])),
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _correspondenceList(ThemeData theme, List rows) {
    final df = DateFormat('dd MMM yyyy • h:mm a');
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Correspondence', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            ...rows.map((r) {
              final m = (r as Map).cast<String, dynamic>();
              DateTime? d;
              try {
                d = DateTime.parse(m['recorded_at'].toString()).toLocal();
              } catch (_) {
                d = null;
              }
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${m['direction'] ?? ''} • ${m['channel'] ?? ''}${d != null ? ' • ${df.format(d)}' : ''}',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    if (m['subject'] != null)
                      Text(
                        m['subject'].toString(),
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    if (m['body'] != null)
                      Text(
                        m['body'].toString(),
                        style: theme.textTheme.bodySmall,
                      ),
                  ],
                ),
              );
            }),
          ],
        ),
      ),
    );
  }

  Widget _row(
    ThemeData theme,
    String label,
    double v, {
    bool highlight = false,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: theme.textTheme.bodyMedium),
          Text(
            _inr(v),
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: highlight ? FontWeight.w700 : FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}

double _toNum(dynamic v) => v == null
    ? 0.0
    : (v is num ? v.toDouble() : double.tryParse(v.toString()) ?? 0.0);

String _inr(double n) => '₹${n.toStringAsFixed(0)}';
