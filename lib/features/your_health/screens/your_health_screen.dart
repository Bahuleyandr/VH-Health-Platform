// Enhanced your_health_screen.dart — merged Records + Your Health into single hub
// Tab coordinator — delegates to self-contained tab widgets for Prescriptions,
// Consultations, Health Summary, Hospital Documents, and My Uploads.
// The Health Records tab (with offline caching) remains inline.
import 'package:go_router/go_router.dart';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/offline/record_cache_manager.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/l10n/app_localizations_ext.dart';

import 'package:vhhealth/features/your_health/widgets/prescriptions_tab.dart';
import 'package:vhhealth/features/your_health/widgets/consultations_tab.dart';
import 'package:vhhealth/features/your_health/widgets/health_summary_tab.dart';
import 'package:vhhealth/features/your_health/widgets/hospital_documents_tab.dart';
import 'package:vhhealth/features/your_health/widgets/my_uploads_tab.dart';

class YourHealthScreen extends StatefulWidget {
  final String phone;
  final int initialTab;
  const YourHealthScreen({super.key, required this.phone, this.initialTab = 0});

  @override
  State<YourHealthScreen> createState() => _YourHealthScreenState();
}

class _YourHealthScreenState extends State<YourHealthScreen>
    with SingleTickerProviderStateMixin {
  // Health Records tab state (kept here due to complex offline caching)
  List<dynamic> records = [];
  bool _isLoadingRecords = true;
  String _selectedType = 'All';
  bool _newestFirst = true;

  late final bool _isGuest;
  late final Color _color;
  late TabController _tabController;

  /// GlobalKey for the My Uploads tab so we can call showUploadSheet from the FAB.
  final GlobalKey<MyUploadsTabState> _myUploadsKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 6, vsync: this, initialIndex: widget.initialTab);
    _isGuest = widget.phone.trim().isEmpty ||
        widget.phone.toLowerCase() == 'guest';
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final extra = GoRouterState.of(context).extra as Map<String, dynamic>?;
    _color = extra?['color'] ??
        FeatureScreenScaffold.featureColors['your-health']!;

    if (extra?['defaultFilter'] == 'Investigation') {
      _selectedType = 'Investigation';
    }

    // Allow tab override from route extra
    final tabIndex = extra?['tab'] as int?;
    if (tabIndex != null && tabIndex >= 0 && tabIndex < 6) {
      _tabController.index = tabIndex;
    }

    if (!_isGuest) {
      _fetchRecords();
    } else {
      setState(() {
        _isLoadingRecords = false;
      });
    }
  }

  // ─── Health Records Tab (with offline caching — kept in main file) ───

  Future<void> _fetchRecords() async {
    if (!mounted) return;
    setState(() => _isLoadingRecords = true);

    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;

    final queryParams = <String, String>{};
    if (_selectedType != 'All') {
      queryParams['type'] = _selectedType.toLowerCase();
    }

    try {
      final response = await ApiClient.get(
        '/records/health-records/${widget.phone}',
        queryParameters: queryParams.isNotEmpty ? queryParams : null,
      );
      if (!mounted) return;

      if (response.isSuccess) {
        final rawData = response.data;
        final List<dynamic> data = rawData is List
            ? rawData
            : (rawData is Map
                ? (rawData['records'] ?? rawData ?? [])
                : []) as List<dynamic>;
        await RecordCacheManager.saveManifest(widget.phone, data);
        if (!mounted) return;
        setState(() {
          records = _newestFirst ? data : data.reversed.toList();
          _isLoadingRecords = false;
        });
      } else {
        _tryLoadFromCache(messenger, theme, l10n.recordsLoadFailed);
      }
    } catch (e) {
      debugPrint('Health records fetch failed: $e');
      _tryLoadFromCache(messenger, theme, l10n.networkError);
    }
  }

  Future<void> _tryLoadFromCache(
    ScaffoldMessengerState messenger,
    ThemeData theme,
    String errorMsg,
  ) async {
    final cached = await RecordCacheManager.loadManifest(widget.phone);
    if (!mounted) return;
    final l10n = AppLocalizations.of(context)!;

    if (!mounted) return;
    if (cached != null && cached.isNotEmpty) {
      setState(() {
        records = _newestFirst ? cached : cached.reversed.toList();
        _isLoadingRecords = false;
      });
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.recordsShowingOffline),
        backgroundColor: theme.colorScheme.tertiary,
        behavior: SnackBarBehavior.floating,
      ));
    } else {
      setState(() => _isLoadingRecords = false);
      messenger.showSnackBar(SnackBar(
        content: Text(errorMsg),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  void _onTypeChanged(String? type) {
    if (type != null && type != _selectedType) {
      setState(() => _selectedType = type);
      _fetchRecords();
    }
  }

  void _toggleSort() {
    if (records.isEmpty) return;
    setState(() {
      _newestFirst = !_newestFirst;
      records = records.reversed.toList();
    });
  }

  Future<void> _downloadIfSafe(String fileKey) async {
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;

    final granted = await PermissionsService.ensurePermission(
      context,
      Permission.photos,
    );
    if (!granted) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.downloadPermissionDenied),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }

    try {
      final response = await ApiClient.get('/upload/by-key/$fileKey');
      if (!mounted) return;

      if (response.isSuccess) {
        final data = response.dataAsMap();
        if (data['quarantined'] == true) {
          messenger.showSnackBar(SnackBar(
            content: Text(l10n.fileQuarantined),
            backgroundColor: theme.colorScheme.error,
            behavior: SnackBarBehavior.floating,
          ));
          return;
        }

        final downloadUrl = data['storage_url'] as String?;
        if (downloadUrl == null || downloadUrl.isEmpty) throw Exception();

        final fileName = fileKey.split('/').last;
        final file =
            await CacheFileUtils.downloadAndCacheFile(fileName, downloadUrl);

        if (file != null) {
          await CacheFileUtils.openCachedFile(file.path);
        } else {
          throw Exception();
        }
      } else {
        throw Exception();
      }
    } catch (e) {
      debugPrint('File open/download failed: $e');
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.fileCouldNotOpen),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    // Show upload FAB only on My Uploads tab (index 2)
    final showUploadFab = !_isGuest && _tabController.index == 2;

    return FeatureScreenScaffold(
      title: l10n.yourHealthTitle,
      icon: Icons.monitor_heart_outlined,
      color: _color,
      heroTag: 'yourHealth',
      floatingActionButton: showUploadFab
          ? FloatingActionButton.extended(
              onPressed: () => _myUploadsKey.currentState?.showUploadSheet(),
              icon: const Icon(Icons.upload_file),
              label: const Text('Upload Record'),
            )
          : null,
      child: _isGuest
          ? _buildGuestView(theme, cs, l10n)
          : Column(
              children: [
                TabBar(
                  controller: _tabController,
                  labelColor: cs.primary,
                  unselectedLabelColor: cs.onSurfaceVariant,
                  indicatorColor: cs.primary,
                  isScrollable: true,
                  onTap: (_) => setState(() {}), // Rebuild to toggle FAB
                  tabs: [
                    Tab(text: l10n.yourHealthTabRecords),
                    const Tab(text: 'Hospital Docs'),
                    const Tab(text: 'My Uploads'),
                    const Tab(text: 'Prescriptions'),
                    Tab(text: l10n.yourHealthTabConsultations),
                    Tab(text: l10n.yourHealthTabSummary),
                  ],
                ),
                Expanded(
                  child: TabBarView(
                    controller: _tabController,
                    children: [
                      _buildRecordsTab(theme, cs, l10n),
                      const HospitalDocumentsTab(),
                      MyUploadsTab(key: _myUploadsKey),
                      PrescriptionsTab(phone: widget.phone),
                      const ConsultationsTab(),
                      const HealthSummaryTab(),
                    ],
                  ),
                ),
              ],
            ),
    );
  }

  Widget _buildGuestView(
      ThemeData theme, ColorScheme cs, AppLocalizations l10n) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock_outline,
                size: 60, color: cs.onSurface.withAlpha(153)),
            const SizedBox(height: 16),
            Text(
              l10n.yourHealthLoginToView,
              style: theme.textTheme.titleMedium
                  ?.copyWith(color: cs.onSurfaceVariant),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              icon: const Icon(Icons.arrow_back_outlined),
              label: Text(l10n.backToDashboard),
              onPressed: () => context.pop(),
            ),
          ],
        ),
      ),
    );
  }

  // ─── Health Records Tab ───

  Widget _buildRecordsTab(
      ThemeData theme, ColorScheme cs, AppLocalizations l10n) {
    final dateFmt =
        DateFormat.yMMMd(Localizations.localeOf(context).toString());

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: DropdownButtonFormField<String>(
            initialValue: _selectedType,
            decoration:
                InputDecoration(labelText: l10n.yourHealthFilterByType),
            onChanged: _onTypeChanged,
            items: const ['All', 'Consultation', 'Investigation', 'Report']
                .map((type) => DropdownMenuItem(
                      value: type,
                      child: Text(
                        l10n.recordTypeLabel(type),
                        style: theme.textTheme.bodyLarge?.copyWith(
                          color: _selectedType == type
                              ? cs.primary
                              : cs.onSurface,
                        ),
                      ),
                    ))
                .toList(),
          ),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: Padding(
            padding: const EdgeInsets.only(right: 16.0),
            child: IconButton(
              tooltip: _newestFirst
                  ? l10n.yourHealthSortOldest
                  : l10n.yourHealthSortNewest,
              icon: Icon(
                _newestFirst
                    ? Icons.arrow_downward_outlined
                    : Icons.arrow_upward_outlined,
                color: cs.onSurface,
              ),
              onPressed: _toggleSort,
            ),
          ),
        ),
        Expanded(
          child: _isLoadingRecords
              ? Center(
                  child: CircularProgressIndicator(
                      valueColor: AlwaysStoppedAnimation(cs.primary)))
              : records.isEmpty
                  ? Center(child: Text(l10n.yourHealthNoRecords))
                  : ListView.builder(
                      itemCount: records.length,
                      itemBuilder: (_, i) {
                        final item = records[i];
                        final type = item['type']?.toString() ?? 'Record';
                        final fileKey = item['file_key']?.toString() ?? '';

                        DateTime? uploaded;
                        if (item['uploaded_at'] != null) {
                          try {
                            uploaded = DateTime.parse(item['uploaded_at'])
                                .toLocal();
                          } catch (e) {
                            debugPrint('Upload date parse failed: $e');
                          }
                        }

                        return Card(
                          child: ListTile(
                            leading:
                                Icon(_iconFor(type), color: cs.primary),
                            title: Text(l10n.recordTypeLabel(type)),
                            subtitle: Text(
                              '${l10n.yourHealthUploaded}: '
                              '${uploaded != null ? dateFmt.format(uploaded) : l10n.notAvailable}',
                            ),
                            trailing: IconButton(
                              icon: const Icon(
                                  Icons.download_for_offline_outlined),
                              onPressed: fileKey.isNotEmpty
                                  ? () => _downloadIfSafe(fileKey)
                                  : null,
                            ),
                          ),
                        );
                      },
                    ),
        ),
      ],
    );
  }

  IconData _iconFor(String t) {
    switch (t.toLowerCase()) {
      case 'consultation':
        return Icons.medical_services_outlined;
      case 'investigation':
        return Icons.biotech_outlined;
      case 'report':
        return Icons.assessment_outlined;
      default:
        return Icons.insert_drive_file_outlined;
    }
  }
}
