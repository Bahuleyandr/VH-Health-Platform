// "Results" tab of InvestigationsScreen — lists the patient's
// investigations with collection instructions, expandable file lists,
// gauge-rendered numeric results and a detail bottom-sheet. Extracted as
// its own StatefulWidget; the parent holds a
// GlobalKey<InvestigationResultsTabState> and calls refresh() after an
// upload.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/features/investigations/widgets/result_gauge_widget.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

class InvestigationResultsTab extends StatefulWidget {
  const InvestigationResultsTab({super.key});

  @override
  State<InvestigationResultsTab> createState() =>
      InvestigationResultsTabState();
}

class InvestigationResultsTabState extends State<InvestigationResultsTab>
    with AutomaticKeepAliveClientMixin {
  List<dynamic> _investigations = [];
  bool _isLoadingResults = true;
  String? _resultsError;

  // Expanded investigation file lists
  final Map<String, List<dynamic>> _fileCache = {};
  final Set<String> _expandedIds = {};
  final Set<String> _loadingFiles = {};

  late final bool _isGuest;
  late final String _phone;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _phone = context.read<UserProvider>().phone;
    _isGuest = _phone.toLowerCase() == 'guest' || _phone.trim().isEmpty;
    if (!_isGuest) {
      _fetchInvestigations();
    } else {
      _isLoadingResults = false;
    }
  }

  /// Re-fetch the investigations list. Called by the parent (via GlobalKey)
  /// after a new upload on the Upload tab.
  void refresh() => _fetchInvestigations();

  Future<void> _fetchInvestigations() async {
    if (!mounted) return;
    setState(() {
      _isLoadingResults = true;
      _resultsError = null;
    });

    // Self-service: the backend derives the patient from the JWT — no
    // patient_id or phone in the URL.
    const path = '/investigations/my';

    try {
      final response = await ApiClient.get(path);
      if (!mounted) return;

      if (response.isSuccess) {
        final data = response.data;
        final List<dynamic> investigations = data is List
            ? data
            : (data is Map ? (data['investigations'] ?? []) : [])
                  as List<dynamic>;
        setState(() {
          _investigations = investigations;
          _isLoadingResults = false;
        });
      } else {
        setState(() {
          _isLoadingResults = false;
          _resultsError = 'Failed to load investigations';
        });
      }
    } catch (e) {
      debugPrint('Fetch investigations failed: $e');
      if (!mounted) return;
      setState(() {
        _isLoadingResults = false;
        _resultsError = 'Network error';
      });
    }
  }

  Future<void> _fetchFiles(String investigationId) async {
    if (_fileCache.containsKey(investigationId)) return;

    setState(() => _loadingFiles.add(investigationId));

    try {
      final response = await ApiClient.get(
        '/investigations/$investigationId/files',
      );
      if (!mounted) return;

      if (response.isSuccess) {
        final data = response.data;
        final List<dynamic> files = data is List
            ? data
            : (data is Map ? (data['files'] ?? []) : []) as List<dynamic>;
        setState(() {
          _fileCache[investigationId] = files;
          _loadingFiles.remove(investigationId);
        });
      } else {
        setState(() => _loadingFiles.remove(investigationId));
      }
    } catch (e) {
      debugPrint('Fetch investigation files failed: $e');
      if (mounted) setState(() => _loadingFiles.remove(investigationId));
    }
  }

  Future<void> _downloadFile(
    String investigationId,
    String fileId,
    String fileName,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;

    final uri = Uri.parse(
      '${ApiConfig.baseUrl}/investigations/$investigationId/files/$fileId/download',
    );

    try {
      final resp = await http
          .get(uri, headers: await ApiConfig.authenticatedAuthHeaders())
          .timeout(const Duration(seconds: 15));
      if (!mounted) return;

      if (resp.statusCode == 200) {
        // The response might be the file itself or a redirect URL
        final contentType = resp.headers['content-type'] ?? '';
        if (contentType.contains('application/json')) {
          // Response contains a URL to download
          final body = jsonDecode(resp.body);
          final url =
              body['data']?['url'] ??
              body['data']?['storage_url'] ??
              body['url'];
          if (url != null) {
            final file = await CacheFileUtils.downloadAndCacheFile(
              fileName,
              url,
            );
            if (file != null) {
              await CacheFileUtils.openCachedFile(file.path);
              return;
            }
          }
          throw Exception('No download URL');
        } else {
          // Direct file content
          final file = await CacheFileUtils.saveBytesToCache(
            fileName,
            resp.bodyBytes,
          );
          if (file != null) {
            await CacheFileUtils.openCachedFile(file.path);
            return;
          }
          throw Exception('Failed to save file');
        }
      } else {
        throw Exception('Download failed');
      }
    } catch (e) {
      debugPrint('Investigation file download failed: $e');
      if (!mounted) return;
      messenger.showSnackBar(
        LiveRegionSnackBar.build(
          message: l10n.investigationsDownloadFailed,
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  void _toggleExpand(String id) {
    setState(() {
      if (_expandedIds.contains(id)) {
        _expandedIds.remove(id);
      } else {
        _expandedIds.add(id);
        _fetchFiles(id);
      }
    });
  }

  void _showResultDetail(Map<String, dynamic> inv) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final dateFmt = DateFormat.yMMMd(
      Localizations.localeOf(context).toString(),
    );
    final id = (inv['id'] ?? '').toString();
    final testName = inv['test_name'] ?? inv['type'] ?? 'Investigation';
    final status = (inv['status'] ?? 'pending').toString();
    final type = inv['type'] ?? '';
    final results = inv['results'] ?? inv['result'];
    final normalRange = inv['normal_range'] ?? '';
    final fileKey = inv['file_key'];

    DateTime? orderedDate;
    final orderedStr = inv['ordered_date'] ?? inv['created_at'] ?? inv['date'];
    if (orderedStr != null) {
      try {
        orderedDate = DateTime.parse(orderedStr.toString()).toLocal();
      } catch (e) {
        debugPrint('Ordered date parse failed: $e');
      }
    }

    DateTime? completedDate;
    final completedStr = inv['completed_date'];
    if (completedStr != null) {
      try {
        completedDate = DateTime.parse(completedStr.toString()).toLocal();
      } catch (e) {
        debugPrint('Completed date parse failed: $e');
      }
    }

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.5,
        minChildSize: 0.3,
        maxChildSize: 0.85,
        builder: (ctx, scrollController) => SingleChildScrollView(
          controller: scrollController,
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: cs.onSurface.withAlpha(50),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              Text(
                testName.toString(),
                style: theme.textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 12),
              _detailRow('Type', type.toString(), cs),
              _detailRow('Status', status, cs),
              if (orderedDate != null)
                _detailRow('Ordered', dateFmt.format(orderedDate), cs),
              if (completedDate != null)
                _detailRow('Completed', dateFmt.format(completedDate), cs),
              if (normalRange.toString().isNotEmpty)
                _detailRow('Normal Range', normalRange.toString(), cs),
              if (results != null && results.toString().isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(
                  'Result',
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: cs.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    results.toString(),
                    style: theme.textTheme.bodyMedium,
                  ),
                ),
              ],
              if (fileKey != null && fileKey.toString().isNotEmpty) ...[
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton.icon(
                    onPressed: () {
                      // Use the file download endpoint
                      _fetchFiles(id);
                      Navigator.pop(ctx);
                      // Expand the card to show files
                      setState(() => _expandedIds.add(id));
                    },
                    icon: const Icon(Icons.download_outlined),
                    label: Text(
                      AppLocalizations.of(
                        context,
                      )!.investigationsViewDownloadReport,
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 16),
            ],
          ),
        ),
      ),
    );
  }

  Widget _detailRow(String label, String value, ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 100,
            child: Text(
              label,
              style: TextStyle(
                color: cs.onSurfaceVariant,
                fontSize: 13,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final dateFmt = DateFormat.yMMMd(
      Localizations.localeOf(context).toString(),
    );

    if (_isGuest) {
      return Center(
        child: Text(
          l10n.yourHealthLoginToView,
          style: theme.textTheme.bodyLarge?.copyWith(
            color: cs.onSurfaceVariant,
          ),
        ),
      );
    }

    if (_isLoadingResults) {
      return Center(
        child: CircularProgressIndicator(
          valueColor: AlwaysStoppedAnimation(cs.primary),
        ),
      );
    }

    if (_resultsError != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 48, color: cs.error),
            const SizedBox(height: 12),
            Text(_resultsError!),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: _fetchInvestigations,
              child: Text(AppLocalizations.of(context)!.commonRetry),
            ),
          ],
        ),
      );
    }

    if (_investigations.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.science_outlined,
              size: 48,
              color: cs.onSurface.withAlpha(100),
            ),
            const SizedBox(height: 12),
            Text(
              l10n.investigationsNoResults,
              style: theme.textTheme.bodyLarge?.copyWith(
                color: cs.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchInvestigations,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _investigations.length,
        itemBuilder: (_, i) {
          final inv = _investigations[i];
          final id = (inv['id'] ?? inv['_id'] ?? '').toString();
          final testName = inv['test_name'] ?? inv['type'] ?? 'Investigation';
          final status = (inv['status'] ?? 'pending').toString().toLowerCase();
          final isCompleted = status == 'completed' || status == 'done';
          final results = inv['results'] ?? inv['result'];

          DateTime? date;
          final dateStr =
              inv['created_at'] ?? inv['date'] ?? inv['requested_at'];
          if (dateStr != null) {
            try {
              date = DateTime.parse(dateStr.toString()).toLocal();
            } catch (e) {
              debugPrint('Investigation date parse failed: $e');
            }
          }

          final isExpanded = _expandedIds.contains(id);
          final files = _fileCache[id];
          final isLoadingFileList = _loadingFiles.contains(id);

          // Collection instructions (migration 203). Only rendered for
          // pending orders — once completed, the location/deadline/fasting
          // banner is stale and the patient's focus shifts to results.
          final collectionLocation = inv['collection_location']?.toString();
          final collectionDeadlineRaw = inv['collection_deadline_at']
              ?.toString();
          DateTime? collectionDeadline;
          if (collectionDeadlineRaw != null &&
              collectionDeadlineRaw.isNotEmpty) {
            try {
              collectionDeadline = DateTime.parse(
                collectionDeadlineRaw,
              ).toLocal();
            } catch (_) {
              collectionDeadline = null;
            }
          }
          final fastingRequired = inv['fasting_required'] == true;
          final fastingInstructions = inv['fasting_instructions']?.toString();
          final hasInstructions =
              !isCompleted &&
              ((collectionLocation != null && collectionLocation.isNotEmpty) ||
                  collectionDeadline != null ||
                  fastingRequired ||
                  (fastingInstructions != null &&
                      fastingInstructions.isNotEmpty));

          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: InkWell(
              onTap: () => _showResultDetail(inv),
              borderRadius: BorderRadius.circular(12),
              child: Column(
                children: [
                  ListTile(
                    leading: Icon(
                      isCompleted
                          ? Icons.check_circle_outlined
                          : Icons.hourglass_empty_outlined,
                      color: isCompleted ? cs.tertiary : cs.onSurfaceVariant,
                    ),
                    title: Text(
                      testName.toString(),
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    subtitle: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (date != null) Text(dateFmt.format(date)),
                        const SizedBox(height: 4),
                        Chip(
                          label: Text(
                            isCompleted
                                ? l10n.investigationsStatusCompleted
                                : l10n.investigationsStatusPending,
                            style: TextStyle(fontSize: 11),
                          ),
                          backgroundColor: isCompleted
                              ? cs.tertiaryContainer
                              : cs.surfaceContainerHighest,
                          visualDensity: VisualDensity.compact,
                        ),
                      ],
                    ),
                    trailing: id.isNotEmpty
                        ? IconButton(
                            icon: Icon(
                              isExpanded
                                  ? Icons.expand_less
                                  : Icons.expand_more,
                            ),
                            onPressed: () => _toggleExpand(id),
                          )
                        : null,
                    isThreeLine: true,
                  ),
                  if (hasInstructions)
                    _buildCollectionInstructions(
                      theme,
                      location: collectionLocation,
                      deadline: collectionDeadline,
                      fastingRequired: fastingRequired,
                      fastingInstructions: fastingInstructions,
                    ),
                  // Results — gauge if numeric value + parseable reference range, else text
                  if (results != null && results.toString().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 6,
                      ),
                      child: _buildResultBlock(
                        theme,
                        testName.toString(),
                        results.toString(),
                        inv['normal_range']?.toString() ??
                            inv['reference_range']?.toString(),
                        inv['unit']?.toString(),
                        previousValue: _findPreviousNumericValue(
                          _investigations,
                          currentIndex: i,
                          testName: testName.toString(),
                        ),
                      ),
                    ),
                  // Expandable file list
                  if (isExpanded) ...[
                    const Divider(height: 1),
                    if (isLoadingFileList)
                      const Padding(
                        padding: EdgeInsets.all(12),
                        child: SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    else if (files != null && files.isNotEmpty)
                      ...files.map((f) {
                        final fileId = (f['id'] ?? f['_id'] ?? '').toString();
                        final fName =
                            f['file_name'] ??
                            f['filename'] ??
                            f['original_name'] ??
                            'Report';
                        return ListTile(
                          dense: true,
                          leading: Icon(
                            Icons.description_outlined,
                            size: 20,
                            color: cs.primary,
                          ),
                          title: Text(
                            fName.toString(),
                            style: theme.textTheme.bodySmall,
                          ),
                          trailing: IconButton(
                            icon: Icon(
                              Icons.download_outlined,
                              color: cs.primary,
                            ),
                            onPressed: () =>
                                _downloadFile(id, fileId, fName.toString()),
                            tooltip: l10n.investigationsDownloadReport,
                          ),
                        );
                      })
                    else
                      Padding(
                        padding: const EdgeInsets.all(12),
                        child: Text(
                          l10n.investigationsNoFiles,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  /// Renders the lab-order intake panel: where to give the sample, by
  /// when, and whether fasting is required. Migration 203 surfaces these
  /// fields on `investigations`; the patient app previously had no way
  /// to display them and a CBC sample was realistically missed because
  /// the patient could not tell where to go.
  Widget _buildCollectionInstructions(
    ThemeData theme, {
    String? location,
    DateTime? deadline,
    required bool fastingRequired,
    String? fastingInstructions,
  }) {
    final cs = theme.colorScheme;
    final children = <Widget>[];
    if (location != null && location.isNotEmpty) {
      children.add(
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.place_outlined, size: 18, color: cs.primary),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                location,
                style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurface),
              ),
            ),
          ],
        ),
      );
    }
    if (deadline != null) {
      final deadlineFmt = DateFormat('EEE, dd MMM • h:mm a');
      children.add(
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.schedule_outlined, size: 18, color: cs.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Collect by ${deadlineFmt.format(deadline)}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: cs.onSurface,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    }
    if (fastingRequired) {
      final fastingText =
          (fastingInstructions != null && fastingInstructions.isNotEmpty)
          ? fastingInstructions
          : 'Fasting required before this test.';
      children.add(
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: cs.errorContainer.withAlpha(150),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: cs.error.withAlpha(120)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.no_food_outlined, size: 18, color: cs.error),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    fastingText,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: cs.onErrorContainer,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: children,
      ),
    );
  }

  // ── Result rendering helpers ────────────────────────────────────────────

  /// Attempts to render a gauge visualisation for a numeric lab result. Falls
  /// back to a plain text line when the value or reference range cannot be
  /// parsed into numbers.
  Widget _buildResultBlock(
    ThemeData theme,
    String testName,
    String results,
    String? normalRange,
    String? unit, {
    double? previousValue,
  }) {
    final numeric = _extractLeadingNumber(results);
    final range = LabReferenceRange.tryParse(normalRange, unit: unit);
    if (numeric != null && range != null) {
      return ResultGaugeWidget(
        testName: testName,
        value: numeric,
        previousValue: previousValue,
        range: range,
        unit: unit,
      );
    }
    return Align(
      alignment: Alignment.centerLeft,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(results, style: theme.textTheme.bodySmall),
          if (normalRange != null && normalRange.isNotEmpty)
            Text(
              'Reference: $normalRange',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.hintColor,
              ),
            ),
        ],
      ),
    );
  }

  /// Pulls the first numeric token out of a result string like "95 mg/dL" or
  /// "HbA1c: 5.8%".
  double? _extractLeadingNumber(String s) {
    final m = RegExp(r'(-?\d+(?:\.\d+)?)').firstMatch(s);
    if (m == null) return null;
    return double.tryParse(m.group(1)!);
  }

  /// Finds the most recent previous numeric result for the same test so the
  /// gauge can show a trend chip. Walks newer → older from [currentIndex]+1.
  double? _findPreviousNumericValue(
    List<dynamic> list, {
    required int currentIndex,
    required String testName,
  }) {
    for (var j = currentIndex + 1; j < list.length; j++) {
      final other = list[j];
      if (other is! Map) continue;
      final otherName = (other['test_name'] ?? other['type'] ?? '').toString();
      if (otherName != testName) continue;
      final otherResult = (other['results'] ?? other['result'])?.toString();
      if (otherResult == null || otherResult.isEmpty) continue;
      final n = _extractLeadingNumber(otherResult);
      if (n != null) return n;
    }
    return null;
  }
}
