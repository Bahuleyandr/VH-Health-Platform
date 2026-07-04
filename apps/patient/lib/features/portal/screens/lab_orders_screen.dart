// lib/features/portal/screens/lab_orders_screen.dart
//
// Patient-facing lab orders — surfaces collection instructions BEFORE
// the sample is given (where, by when, fasting?) and the report PDF
// AFTER results are signed off. Distinct from lab_results_screen.dart
// which shows analyte-level values from the analyzer.

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class _LabOrder {
  _LabOrder.fromJson(Map<String, dynamic> j)
    : id = j['id'] as int,
      testName = j['test_name']?.toString() ?? '—',
      testCode = j['test_code']?.toString(),
      status = j['status']?.toString() ?? 'REQUESTED',
      priority = j['priority']?.toString(),
      requestedAt = _parseDate(j['requested_at']),
      scheduledDate = j['scheduled_date']?.toString(),
      collectedAt = _parseDate(j['collected_at']),
      completedAt = _parseDate(j['completed_at']),
      collectionLocation = j['collection_location']?.toString(),
      collectionDeadlineAt = _parseDate(j['collection_deadline_at']),
      fastingRequired = j['fasting_required'] == true,
      fastingInstructions = j['fasting_instructions']?.toString(),
      doctorName = j['doctor_name']?.toString(),
      resultSummary = j['result_summary']?.toString(),
      conclusion = j['conclusion']?.toString(),
      resultUploadedAt = _parseDate(j['result_uploaded_at']),
      fileKey = j['file_key']?.toString();

  final int id;
  final String testName;
  final String? testCode;
  final String status;
  final String? priority;
  final DateTime? requestedAt;
  final String? scheduledDate;
  final DateTime? collectedAt;
  final DateTime? completedAt;
  final String? collectionLocation;
  final DateTime? collectionDeadlineAt;
  final bool fastingRequired;
  final String? fastingInstructions;
  final String? doctorName;
  final String? resultSummary;
  final String? conclusion;
  final DateTime? resultUploadedAt;
  final String? fileKey;

  static DateTime? _parseDate(dynamic v) {
    if (v == null) return null;
    final s = v.toString();
    if (s.isEmpty) return null;
    return DateTime.tryParse(s);
  }

  bool get isPending {
    final s = status.toUpperCase();
    return s == 'REQUESTED' ||
        s == 'PENDING' ||
        s == 'SCHEDULED' ||
        s == 'SAMPLE_COLLECTED' ||
        s == 'PROCESSING';
  }

  bool get isCompleted {
    final s = status.toUpperCase();
    return s == 'COMPLETED' || s == 'REPORT_READY' || s == 'SIGNED_OFF';
  }
}

class LabOrdersScreen extends StatefulWidget {
  const LabOrdersScreen({super.key});

  @override
  State<LabOrdersScreen> createState() => _LabOrdersScreenState();
}

class _LabOrdersScreenState extends State<LabOrdersScreen> {
  bool _loading = true;
  String? _error;
  List<_LabOrder> _orders = const [];
  final Set<int> _downloadingIds = <int>{};

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
      final response = await ApiClient.get('/portal/lab-orders');
      if (!mounted) return;
      if (response.isSuccess) {
        final list = response.dataAsList();
        setState(() {
          _orders = list
              .whereType<Map<String, dynamic>>()
              .map(_LabOrder.fromJson)
              .toList();
          _loading = false;
        });
      } else {
        final l = AppLocalizations.of(context)!;
        setState(() {
          _error = response.failureMessage(l.labOrdersLoadFailed);
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

  Future<void> _downloadReport(_LabOrder order) async {
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;

    setState(() {
      _downloadingIds.add(order.id);
    });

    try {
      final uri = Uri.parse(
        '${ApiConfig.baseUrl}/portal/lab-orders/${order.id}/pdf',
      );
      final resp = await http
          .get(uri, headers: await ApiConfig.authenticatedAuthHeaders())
          .timeout(const Duration(seconds: 30));
      if (!mounted) return;
      if (resp.statusCode == 200 && resp.bodyBytes.isNotEmpty) {
        final fileName =
            'LabReport_${order.id}_${DateTime.now().toIso8601String().split('T').first}.pdf';
        final file = await CacheFileUtils.saveBytesToCache(
          fileName,
          resp.bodyBytes,
        );
        if (file != null) {
          await CacheFileUtils.openCachedFile(file.path);
        } else {
          throw Exception('Could not save file');
        }
      } else {
        throw Exception('Download failed (HTTP ${resp.statusCode})');
      }
    } catch (e) {
      debugPrint('Lab report download failed: $e');
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(l.labOrdersDownloadFailed),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    } finally {
      if (mounted) {
        setState(() {
          _downloadingIds.remove(order.id);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l.labOrdersTitle,
      icon: Icons.science,
      color: colors.secondary,
      child: RefreshIndicator(
        onRefresh: _fetch,
        child: DataStateBuilder<_LabOrder>(
          isLoading: _loading,
          error: _error,
          data: _orders,
          onRetry: _fetch,
          emptyIcon: Icons.science_outlined,
          emptyTitle: l.labOrdersEmptyTitle,
          emptySubtitle: l.labOrdersEmptySubtitle,
          builder: (context, orders) {
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: orders.length,
              separatorBuilder: (_, _) => const SizedBox(height: 10),
              itemBuilder: (_, i) => _LabOrderCard(
                order: orders[i],
                downloading: _downloadingIds.contains(orders[i].id),
                onDownload: () => _downloadReport(orders[i]),
                l: l,
              ),
            );
          },
        ),
      ),
    );
  }
}

class _LabOrderCard extends StatelessWidget {
  const _LabOrderCard({
    required this.order,
    required this.downloading,
    required this.onDownload,
    required this.l,
  });

  final _LabOrder order;
  final bool downloading;
  final VoidCallback onDownload;
  final AppLocalizations l;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dateFmt = DateFormat.yMMMd();
    final timeFmt = DateFormat.jm();

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    order.testName,
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                _StatusChip(status: order.status),
              ],
            ),
            if (order.doctorName != null && order.doctorName!.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                l.labOrdersOrderedBy(order.doctorName!),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
            ],
            if (order.isPending) ...[
              const SizedBox(height: 12),
              if (order.fastingRequired)
                _FastingBanner(instructions: order.fastingInstructions),
              if (order.fastingRequired) const SizedBox(height: 8),
              if (order.collectionLocation != null &&
                  order.collectionLocation!.isNotEmpty)
                _InstructionRow(
                  icon: Icons.place_outlined,
                  label: l.labOrdersWhere,
                  value: order.collectionLocation!,
                ),
              if (order.collectionDeadlineAt != null)
                _InstructionRow(
                  icon: Icons.schedule,
                  label: l.labOrdersBy,
                  value:
                      '${dateFmt.format(order.collectionDeadlineAt!.toLocal())} '
                      '${timeFmt.format(order.collectionDeadlineAt!.toLocal())}',
                ),
              if (order.scheduledDate != null &&
                  order.scheduledDate!.isNotEmpty &&
                  order.collectionDeadlineAt == null)
                _InstructionRow(
                  icon: Icons.event,
                  label: l.labOrdersScheduled,
                  value: order.scheduledDate!,
                ),
              if (order.collectionLocation == null &&
                  order.collectionDeadlineAt == null &&
                  !order.fastingRequired) ...[
                const SizedBox(height: 4),
                Text(
                  l.labOrdersNoCollectionInstructions,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                ),
              ],
            ],
            if (order.isCompleted) ...[
              const SizedBox(height: 12),
              if (order.completedAt != null)
                _InstructionRow(
                  icon: Icons.check_circle_outline,
                  label: l.labOrdersCompleted,
                  value: dateFmt.format(order.completedAt!.toLocal()),
                ),
              if (order.resultSummary != null &&
                  order.resultSummary!.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(order.resultSummary!, style: theme.textTheme.bodyMedium),
              ],
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.tonalIcon(
                  onPressed: downloading ? null : onDownload,
                  icon: downloading
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.file_download_outlined),
                  label: Text(
                    downloading
                        ? l.labOrdersDownloading
                        : l.labOrdersDownloadReport,
                  ),
                ),
              ),
            ],
            if (order.requestedAt != null) ...[
              const SizedBox(height: 10),
              Text(
                l.labOrdersRequestedOn(
                  dateFmt.format(order.requestedAt!.toLocal()),
                ),
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
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});
  final String status;

  Color _colour(BuildContext context) {
    final s = status.toUpperCase();
    final cs = Theme.of(context).colorScheme;
    if (s == 'COMPLETED' || s == 'REPORT_READY' || s == 'SIGNED_OFF') {
      return cs.primaryContainer;
    }
    if (s == 'CANCELLED') return cs.errorContainer;
    return cs.secondaryContainer;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: _colour(context),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        status.replaceAll('_', ' '),
        style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _FastingBanner extends StatelessWidget {
  const _FastingBanner({this.instructions});
  final String? instructions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l = AppLocalizations.of(context)!;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.tertiaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.no_food, color: cs.onTertiaryContainer),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l.labOrdersFastingRequired,
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: cs.onTertiaryContainer,
                  ),
                ),
                if (instructions != null && instructions!.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    instructions!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: cs.onTertiaryContainer,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _InstructionRow extends StatelessWidget {
  const _InstructionRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: theme.colorScheme.primary),
          const SizedBox(width: 10),
          SizedBox(
            width: 84,
            child: Text(
              label,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.outline,
              ),
            ),
          ),
          Expanded(child: Text(value, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}
