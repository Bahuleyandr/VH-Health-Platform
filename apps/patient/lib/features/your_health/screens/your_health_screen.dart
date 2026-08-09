// Enhanced your_health_screen.dart — merged Records + Your Health into single hub
// Tab coordinator — delegates to self-contained tab widgets for Prescriptions,
// Consultations, Health Summary, Hospital Documents, and My Uploads.
// The Health Records tab (with offline caching) remains inline.
import 'package:go_router/go_router.dart';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/offline/record_cache_manager.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/features/your_health/models/patient_explainer.dart';
import 'package:vhhealth/features/your_health/services/patient_explainers_repository.dart';
import 'package:vhhealth/features/your_health/services/whats_next_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/l10n/app_localizations_ext.dart';

import 'package:vhhealth/features/your_health/widgets/prescriptions_tab.dart';
import 'package:vhhealth/features/your_health/widgets/consultation_notes_tab.dart';
import 'package:vhhealth/features/your_health/widgets/explanations_tab.dart';
import 'package:vhhealth/features/your_health/widgets/health_summary_tab.dart';
import 'package:vhhealth/features/your_health/widgets/health_timeline_tab.dart';
import 'package:vhhealth/features/your_health/widgets/hospital_documents_tab.dart';
import 'package:vhhealth/features/your_health/widgets/my_uploads_tab.dart';
import 'package:vhhealth/features/your_health/widgets/whats_next_section.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

class YourHealthScreen extends StatefulWidget {
  final int initialTab;
  final PatientExplainersRepository explainersRepository;
  final WhatsNextRepository whatsNextRepository;

  const YourHealthScreen({
    super.key,
    this.initialTab = 0,
    this.explainersRepository = const ApiPatientExplainersRepository(),
    this.whatsNextRepository = const ApiWhatsNextRepository(),
  });

  @override
  State<YourHealthScreen> createState() => _YourHealthScreenState();
}

class _YourHealthScreenState extends State<YourHealthScreen>
    with TickerProviderStateMixin {
  static const int _baseTabCount = 7;

  // Health Records tab state (kept here due to complex offline caching)
  List<dynamic> records = [];
  bool _isLoadingRecords = true;
  String _selectedType = 'All';
  bool _newestFirst = true;
  DateTime? _recordsCachedAt;

  late final bool _isGuest;
  late final String _phone;
  Color _color = FeatureScreenScaffold.featureColors['your-health']!;
  late TabController _tabController;
  bool _hasExplanationsTab = false;
  bool _didRequestExplainers = false;
  List<PatientExplainer> _explainers = [];

  /// GlobalKey for the My Uploads tab so we can call showUploadSheet from the FAB.
  final GlobalKey<MyUploadsTabState> _myUploadsKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    _phone = context.read<UserProvider>().phone;
    _tabController = TabController(
      length: _tabCount,
      vsync: this,
      initialIndex: _clampedTabIndex(widget.initialTab, _tabCount),
    );
    _isGuest = _phone.trim().isEmpty || _phone.toLowerCase() == 'guest';
  }

  int get _tabCount => _baseTabCount + (_hasExplanationsTab ? 1 : 0);

  int _clampedTabIndex(int index, int length) {
    if (index < 0) return 0;
    if (index >= length) return length - 1;
    return index;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final extra = GoRouterState.of(context).extra as Map<String, dynamic>?;
    _color =
        extra?['color'] ?? FeatureScreenScaffold.featureColors['your-health']!;

    if (extra?['defaultFilter'] == 'Investigation') {
      _selectedType = 'Investigation';
    }

    // Allow tab override from route extra
    final tabIndex = extra?['tab'] as int?;
    if (tabIndex != null && tabIndex >= 0 && tabIndex < _tabCount) {
      _tabController.index = tabIndex;
    }

    if (!_isGuest) {
      _fetchRecords();
      if (!_didRequestExplainers) {
        _didRequestExplainers = true;
        _fetchExplainersPreview();
      }
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
        '/records/health-records/$_phone',
        queryParameters: queryParams.isNotEmpty ? queryParams : null,
      );
      if (!mounted) return;

      if (response.isSuccess) {
        final rawData = response.data;
        final List<dynamic> data = rawData is List
            ? rawData
            : (rawData is Map ? (rawData['records'] ?? rawData ?? []) : [])
                  as List<dynamic>;
        final cachedAt = await RecordCacheManager.saveManifest(_phone, data);
        if (!mounted) return;
        setState(() {
          records = _newestFirst ? data : data.reversed.toList();
          _isLoadingRecords = false;
          _recordsCachedAt = cachedAt;
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
    final cached = await RecordCacheManager.loadManifest(_phone);
    if (!mounted) return;
    final l10n = AppLocalizations.of(context)!;

    if (!mounted) return;
    if (cached != null && cached.records.isNotEmpty) {
      setState(() {
        records = _newestFirst
            ? cached.records
            : cached.records.reversed.toList();
        _recordsCachedAt = cached.cachedAt;
        _isLoadingRecords = false;
      });
      messenger.showSnackBar(
        LiveRegionSnackBar.build(
          message: l10n.recordsShowingOffline,
          backgroundColor: theme.colorScheme.tertiary,
          behavior: SnackBarBehavior.floating,
        ),
      );
    } else {
      setState(() => _isLoadingRecords = false);
      messenger.showSnackBar(
        LiveRegionSnackBar.build(
          message: errorMsg,
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
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
      messenger.showSnackBar(
        LiveRegionSnackBar.build(
          message: l10n.downloadPermissionDenied,
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }

    try {
      final response = await ApiClient.get('/upload/by-key/$fileKey');
      if (!mounted) return;

      if (response.isSuccess) {
        final data = response.dataAsMap();
        if (data['quarantined'] == true) {
          messenger.showSnackBar(
            LiveRegionSnackBar.build(
              message: l10n.fileQuarantined,
              backgroundColor: theme.colorScheme.error,
              behavior: SnackBarBehavior.floating,
            ),
          );
          return;
        }

        final downloadUrl = data['storage_url'] as String?;
        if (downloadUrl == null || downloadUrl.isEmpty) throw Exception();

        final fileName = fileKey.split('/').last;
        final file = await CacheFileUtils.downloadAndCacheFile(
          fileName,
          downloadUrl,
        );

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
      messenger.showSnackBar(
        LiveRegionSnackBar.build(
          message: l10n.fileCouldNotOpen,
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  Future<void> _fetchExplainersPreview() async {
    try {
      final explainers = await widget.explainersRepository.listExplainers();
      if (!mounted) return;
      _updateExplainers(explainers);
    } catch (e) {
      debugPrint('Patient explainers fetch failed: $e');
      if (!mounted) return;
      _updateExplainers(const []);
    }
  }

  void _updateExplainers(List<PatientExplainer> explainers) {
    final shouldShowTab = explainers.isNotEmpty;
    if (shouldShowTab == _hasExplanationsTab) {
      setState(() {
        _explainers = explainers;
      });
      return;
    }

    final oldController = _tabController;
    final nextLength = _baseTabCount + (shouldShowTab ? 1 : 0);
    final nextIndex = _clampedTabIndex(oldController.index, nextLength);
    final nextController = TabController(
      length: nextLength,
      vsync: this,
      initialIndex: nextIndex,
    );

    setState(() {
      _explainers = explainers;
      _hasExplanationsTab = shouldShowTab;
      _tabController = nextController;
    });
    oldController.dispose();
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

    // Show upload FAB only on My Uploads tab (index 3)
    final showUploadFab = !_isGuest && _tabController.index == 3;

    if (_isGuest) {
      return Scaffold(
        appBar: AppBar(
          title: Text(l10n.yourHealthTitle),
          leading: BackButton(onPressed: () => context.go('/home')),
        ),
        body: _buildGuestView(theme, cs, l10n),
      );
    }

    // Tabbed view needs a bounded-height parent for TabBarView; wrap in
    // a regular Scaffold rather than FeatureScreenScaffold (the latter
    // wraps its child in SingleChildScrollView, which collapses the
    // TabBarView's Expanded to zero height — the screen rendered as
    // pure black before this fix).
    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      floatingActionButton: showUploadFab
          ? FloatingActionButton.extended(
              onPressed: () => _myUploadsKey.currentState?.showUploadSheet(),
              icon: const Icon(Icons.upload_file),
              label: Text(AppLocalizations.of(context)!.yourHealthUploadRecord),
            )
          : null,
      body: SafeArea(
        child: Column(
          children: [
            // Header row — keeps the spirit of FeatureScreenScaffold's
            // bar (icon + title) without the scroll wrapping that breaks
            // the tabbed body.
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 8, 16, 0),
              child: Row(
                children: [
                  BackButton(
                    color: _color,
                    onPressed: () => context.go('/home'),
                  ),
                  Hero(
                    tag: 'yourHealth',
                    child: Material(
                      color: Colors.transparent,
                      child: Icon(
                        Icons.monitor_heart_outlined,
                        size: 28,
                        color: _color,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      l10n.yourHealthTitle,
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            WhatsNextSection(repository: widget.whatsNextRepository),
            TabBar(
              controller: _tabController,
              labelColor: cs.primary,
              unselectedLabelColor: cs.onSurfaceVariant,
              indicatorColor: cs.primary,
              isScrollable: true,
              tabAlignment: TabAlignment.start,
              onTap: (_) => setState(() {}), // Rebuild to toggle FAB
              tabs: buildYourHealthTabs(
                l10n,
                includeExplanations: _hasExplanationsTab,
              ),
            ),
            Expanded(
              child: TabBarView(
                controller: _tabController,
                children: [
                  HealthTimelineTab(
                    onOpenTab: (index) {
                      setState(() => _tabController.index = index);
                    },
                    onUploadRecord: () {
                      setState(() => _tabController.index = 3);
                      WidgetsBinding.instance.addPostFrameCallback((_) {
                        _myUploadsKey.currentState?.showUploadSheet();
                      });
                    },
                  ),
                  _buildRecordsTab(theme, cs, l10n),
                  const HospitalDocumentsTab(),
                  MyUploadsTab(key: _myUploadsKey),
                  PrescriptionsTab(phone: _phone),
                  const ConsultationNotesTab(),
                  const HealthSummaryTab(),
                  if (_hasExplanationsTab)
                    ExplanationsTab(
                      explainers: _explainers,
                      repository: widget.explainersRepository,
                      onRefresh: _fetchExplainersPreview,
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildGuestView(
    ThemeData theme,
    ColorScheme cs,
    AppLocalizations l10n,
  ) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.lock_outline,
              size: 60,
              color: cs.onSurface.withAlpha(153),
            ),
            const SizedBox(height: 16),
            Text(
              l10n.yourHealthLoginToView,
              style: theme.textTheme.titleMedium?.copyWith(
                color: cs.onSurfaceVariant,
              ),
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
    ThemeData theme,
    ColorScheme cs,
    AppLocalizations l10n,
  ) {
    final dateFmt = DateFormat.yMMMd(
      Localizations.localeOf(context).toString(),
    );

    return Column(
      children: [
        OfflineBanner(cachedAt: _recordsCachedAt),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: DropdownButtonFormField<String>(
            initialValue: _selectedType,
            decoration: InputDecoration(labelText: l10n.yourHealthFilterByType),
            onChanged: _onTypeChanged,
            items: const ['All', 'Consultation', 'Investigation', 'Report']
                .map(
                  (type) => DropdownMenuItem(
                    value: type,
                    child: Text(
                      l10n.recordTypeLabel(type),
                      style: theme.textTheme.bodyLarge?.copyWith(
                        color: _selectedType == type
                            ? cs.primary
                            : cs.onSurface,
                      ),
                    ),
                  ),
                )
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
                    valueColor: AlwaysStoppedAnimation(cs.primary),
                  ),
                )
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
                        uploaded = DateTime.parse(
                          item['uploaded_at'],
                        ).toLocal();
                      } catch (e) {
                        debugPrint('Upload date parse failed: $e');
                      }
                    }

                    return Card(
                      child: ListTile(
                        leading: Icon(_iconFor(type), color: cs.primary),
                        title: Text(l10n.recordTypeLabel(type)),
                        subtitle: _RecordTimestamp(
                          uploadedLabel:
                              '${l10n.yourHealthUploaded}: '
                              '${uploaded != null ? dateFmt.format(uploaded) : l10n.notAvailable}',
                          fileKey: fileKey.split('/').last,
                        ),
                        trailing: IconButton(
                          icon: const Icon(Icons.download_for_offline_outlined),
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

class _RecordTimestamp extends StatelessWidget {
  const _RecordTimestamp({required this.uploadedLabel, required this.fileKey});

  final String uploadedLabel;
  final String fileKey;

  @override
  Widget build(BuildContext context) {
    if (fileKey.isEmpty) return Text(uploadedLabel);
    return FutureBuilder<DateTime?>(
      future: CacheFileUtils.cachedFileTimestamp(fileKey),
      builder: (context, snapshot) {
        final cachedAt = snapshot.data;
        if (cachedAt == null) return Text(uploadedLabel);
        final locale = Localizations.localeOf(context).toLanguageTag();
        final timestamp = DateFormat.yMMMd(
          locale,
        ).add_jm().format(cachedAt.toLocal());
        return Text(
          '$uploadedLabel\n${AppLocalizations.of(context)!.patientOutageDownloadedAt(timestamp)}',
        );
      },
    );
  }
}

@visibleForTesting
List<Tab> buildYourHealthTabs(
  AppLocalizations l10n, {
  required bool includeExplanations,
}) {
  return [
    Tab(text: l10n.yourHealthTabTimeline),
    Tab(text: l10n.yourHealthTabRecords),
    Tab(text: l10n.yourHealthHospitalRecordsTab),
    Tab(text: l10n.yourHealthTabMyUploads),
    Tab(text: l10n.yourHealthTabPrescriptions),
    Tab(text: l10n.yourHealthTabConsultationNotes),
    Tab(text: l10n.yourHealthTabSummary),
    if (includeExplanations) Tab(text: l10n.yourHealthTabExplanations),
  ];
}
