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
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class TpaClaimsScreen extends StatefulWidget {
  const TpaClaimsScreen({super.key});

  @override
  State<TpaClaimsScreen> createState() => _TpaClaimsScreenState();
}

class _TpaClaimsScreenState extends State<TpaClaimsScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _claims = [];
  bool _didLoad = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_didLoad) return;
    _didLoad = true;
    _fetch();
  }

  Future<void> _fetch() async {
    final l = AppLocalizations.of(context)!;
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
          _error = response.message ?? l.tpaClaimsLoadFailed;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = l.tpaClaimsLoadFailed;
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l.tpaClaimsTitle)),
      body: DataStateBuilder<Map<String, dynamic>>(
        isLoading: _loading,
        error: _error,
        data: _claims,
        onRetry: _fetch,
        emptyIcon: Icons.policy_outlined,
        emptyTitle: l.tpaClaimsEmptyTitle,
        emptySubtitle: l.tpaClaimsEmptySubtitle,
        errorTitle: l.genericError,
        errorActionLabel: l.commonRetryButton,
        emptyActionLabel: l.commonRefreshButton,
        builder: (context, claims) {
          return RefreshIndicator(
            onRefresh: _fetch,
            child: ListView.builder(
              itemCount: claims.length,
              itemBuilder: (context, i) {
                return _TpaClaimCard(claim: claims[i]);
              },
            ),
          );
        },
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
    final l = AppLocalizations.of(context)!;
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
                      claim['claim_number']?.toString() ?? l.tpaClaimFallback,
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  Semantics(
                    container: true,
                    label: status,
                    excludeSemantics: true,
                    child: Chip(
                      label: Text(status, style: const TextStyle(fontSize: 11)),
                      visualDensity: VisualDensity.compact,
                    ),
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
              _kv(theme, l.tpaClaimClaimed, _inr(claimed)),
              _kv(theme, l.tpaClaimApproved, _inr(approved)),
              _kv(theme, l.tpaClaimPaidByInsurer, _inr(paid)),
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
  String? _documentsError;
  Map<String, dynamic>? _data;
  List<Map<String, dynamic>> _documents = const [];
  final Set<int> _downloadingDocIds = <int>{};
  bool _didLoad = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_didLoad) return;
    _didLoad = true;
    _fetch();
  }

  Future<void> _fetch() async {
    final l = AppLocalizations.of(context)!;
    setState(() {
      _loading = true;
      _error = null;
      _documentsError = null;
    });
    try {
      final resp = await ApiClient.get('/portal/tpa/claims/${widget.claimId}');
      if (!mounted) return;
      if (resp.isSuccess) {
        List<Map<String, dynamic>> docs = const [];
        String? docsError;
        final docsResp = await ApiClient.get(
          '/portal/tpa/claims/${widget.claimId}/documents',
        );
        if (!mounted) return;
        if (docsResp.isSuccess) {
          docs = docsResp
              .dataAsList()
              .whereType<Map<String, dynamic>>()
              .toList();
        } else {
          docsError = docsResp.message ?? l.tpaClaimDocumentsLoadFailed;
        }
        setState(() {
          _data = resp.dataAsMap();
          _documents = docs;
          _documentsError = docsError;
          _loading = false;
        });
      } else {
        setState(() {
          _error = resp.message ?? l.tpaClaimLoadFailed;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = l.tpaClaimLoadFailed;
          _loading = false;
        });
      }
    }
  }

  Future<void> _downloadDocument(Map<String, dynamic> doc) async {
    final l = AppLocalizations.of(context)!;
    final docId = _toInt(doc['id']);
    if (docId == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    setState(() {
      _downloadingDocIds.add(docId);
    });

    try {
      final resp = await ApiClient.get(
        '/portal/tpa/claims/${widget.claimId}/documents/$docId/download-url',
        timeout: const Duration(seconds: 20),
      );
      if (!mounted) return;
      if (!resp.isSuccess) {
        throw Exception(resp.message ?? l.tpaClaimDocumentDownloadFailed);
      }
      final data = resp.dataAsMap();
      final url = data['url']?.toString();
      if (url == null || url.isEmpty) {
        throw Exception(l.tpaClaimDocumentDownloadFailed);
      }
      final returnedDoc = (data['document'] as Map?)?.cast<String, dynamic>();
      final fileName =
          returnedDoc?['file_name']?.toString() ??
          doc['file_name']?.toString() ??
          'claim-document-$docId.pdf';
      final cacheKey =
          'tpa_claim_${widget.claimId}_document_${docId}_$fileName';
      final file = await CacheFileUtils.downloadAndCacheFile(cacheKey, url);
      if (!mounted) return;
      if (file == null) {
        throw Exception(l.tpaClaimDocumentDownloadFailed);
      }
      await CacheFileUtils.openCachedFile(file.path);
    } catch (e) {
      debugPrint('Claim document download failed: $e');
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(l.tpaClaimDocumentDownloadFailed),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    } finally {
      if (mounted) {
        setState(() {
          _downloadingDocIds.remove(docId);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l.tpaClaimBreakdownTitle)),
      body: DataStateBuilder<Map<String, dynamic>>(
        isLoading: _loading,
        error: _error,
        data: _data == null ? const [] : [_data!],
        onRetry: _fetch,
        emptyIcon: Icons.policy_outlined,
        emptyTitle: l.tpaClaimNoData,
        emptySubtitle: l.tpaClaimNoDataHint,
        errorTitle: l.genericError,
        errorActionLabel: l.commonRetryButton,
        emptyActionLabel: l.commonRefreshButton,
        builder: (context, _) {
          return RefreshIndicator(
            onRefresh: _fetch,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: _buildContent(theme, l),
            ),
          );
        },
      ),
    );
  }

  List<Widget> _buildContent(ThemeData theme, AppLocalizations l) {
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
        claim['claim_number']?.toString() ?? l.tpaClaimFallback,
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

    widgets.add(_summaryCard(theme, l, summary));

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

    if (_documents.isNotEmpty || _documentsError != null) {
      widgets.add(const SizedBox(height: 16));
      widgets.add(_claimDocumentsCard(theme, l));
    }

    if (correspondence.isNotEmpty) {
      widgets.add(const SizedBox(height: 16));
      widgets.add(_correspondenceList(theme, correspondence));
    }
    return widgets;
  }

  Widget _summaryCard(
    ThemeData theme,
    AppLocalizations l,
    Map<String, dynamic> s,
  ) {
    final hospital = _toNum(s['hospital_billed']);
    final claimed = _toNum(s['tpa_claimed']);
    final approved = _toNum(s['tpa_approved']);
    final paid = _toNum(s['tpa_paid']);
    final disallowed = _toNum(s['tpa_disallowed']);
    final nonPayable = _toNum(s['non_payable']);
    final copay = _toNum(s['patient_copay']);
    final patient = _toNum(s['patient_responsibility']);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l.tpaClaimSummary, style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            _row(theme, l.tpaClaimHospitalBilled, hospital),
            _row(theme, l.tpaClaimTpaClaimed, claimed),
            _row(theme, l.tpaClaimTpaApproved, approved),
            _row(theme, l.tpaClaimPaidByInsurer, paid, highlight: true),
            if (disallowed > 0)
              _row(theme, l.tpaClaimTpaDisallowed, disallowed),
            if (nonPayable > 0)
              _row(theme, l.tpaClaimNonPayableItems, nonPayable),
            if (copay > 0) _row(theme, l.tpaClaimPolicyCopay, copay),
            const Divider(),
            _row(theme, l.tpaClaimYouPaid, patient, highlight: true),
          ],
        ),
      ),
    );
  }

  Widget _claimDocumentsCard(ThemeData theme, AppLocalizations l) {
    final dateFmt = DateFormat('dd MMM yyyy');
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l.tpaClaimDocuments, style: theme.textTheme.titleMedium),
            if (_documentsError != null) ...[
              const SizedBox(height: 8),
              Text(
                _documentsError!,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ],
            if (_documents.isNotEmpty) ...[
              const SizedBox(height: 8),
              ..._documents.map((doc) {
                final id = _toInt(doc['id']);
                final downloading =
                    id != null && _downloadingDocIds.contains(id);
                DateTime? uploadedAt;
                try {
                  final raw = doc['uploaded_at']?.toString();
                  uploadedAt = raw == null
                      ? null
                      : DateTime.parse(raw).toLocal();
                } catch (_) {
                  uploadedAt = null;
                }
                final meta = [
                  doc['doc_type']?.toString().replaceAll('_', ' '),
                  if (uploadedAt != null) dateFmt.format(uploadedAt),
                  _formatBytes(doc['file_size_bytes']),
                ].where((v) => v != null && v.isNotEmpty).join(' • ');
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.description_outlined,
                        color: theme.colorScheme.primary,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              doc['file_name']?.toString() ??
                                  l.tpaClaimDocumentFallback,
                              style: theme.textTheme.bodyMedium?.copyWith(
                                fontWeight: FontWeight.w600,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                            if (meta.isNotEmpty)
                              Text(
                                meta,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filledTonal(
                        tooltip: l.tpaClaimDownloadTooltip,
                        onPressed: downloading || id == null
                            ? null
                            : () => _downloadDocument(doc),
                        icon: downloading
                            ? SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: theme.colorScheme.primary,
                                ),
                              )
                            : const Icon(Icons.download_outlined),
                      ),
                    ],
                  ),
                );
              }),
            ],
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
                    AppLocalizations.of(context)!.tpaClaimLatestInsurerMessage,
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
                    AppLocalizations.of(context)!.tpaClaimWhyDisallowed,
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
            Text(
              AppLocalizations.of(context)!.tpaClaimInvoiceBreakdown,
              style: theme.textTheme.titleMedium,
            ),
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
                Text(
                  AppLocalizations.of(context)!.tpaClaimTotal,
                  style: const TextStyle(fontWeight: FontWeight.w600),
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
            Text(
              AppLocalizations.of(context)!.tpaClaimCorrespondence,
              style: theme.textTheme.titleMedium,
            ),
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

int? _toInt(dynamic v) => v is int ? v : int.tryParse(v?.toString() ?? '');

String _inr(double n) => '₹${n.toStringAsFixed(0)}';

String? _formatBytes(dynamic v) {
  final bytes = _toNum(v);
  if (bytes <= 0) return null;
  if (bytes < 1024) return '${bytes.toStringAsFixed(0)} B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}
