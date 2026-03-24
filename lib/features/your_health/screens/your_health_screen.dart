// Enhanced your_health_screen.dart with Records, Consultations, and Summary tabs
import 'package:go_router/go_router.dart';

import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/offline/record_cache_manager.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/l10n/app_localizations_ext.dart';

class YourHealthScreen extends StatefulWidget {
  final String phone;
  const YourHealthScreen({super.key, required this.phone});

  @override
  State<YourHealthScreen> createState() => _YourHealthScreenState();
}

class _YourHealthScreenState extends State<YourHealthScreen>
    with SingleTickerProviderStateMixin {
  // Records tab state
  List<dynamic> records = [];
  bool _isLoadingRecords = true;
  String _selectedType = 'All';
  bool _newestFirst = true;

  // Consultations tab state
  List<dynamic> _consultations = [];
  bool _isLoadingConsultations = true;
  String? _consultationsError;

  // Summary tab state
  Map<String, dynamic>? _summary;
  List<dynamic> _allergies = [];
  List<dynamic> _conditions = [];
  bool _isLoadingSummary = true;
  String? _summaryError;

  late final bool _isGuest;
  late final Color _color;
  late TabController _tabController;

  String? _patientId;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _isGuest = widget.phone.trim().isEmpty ||
        widget.phone.toLowerCase() == 'guest';
    if (!_isGuest) {
      _loadPatientId();
    }
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

    if (!_isGuest) {
      _fetchRecords();
      _fetchConsultations();
    } else {
      setState(() {
        _isLoadingRecords = false;
        _isLoadingConsultations = false;
        _isLoadingSummary = false;
      });
    }
  }

  Future<void> _loadPatientId() async {
    // Try to get patient_id from secure storage (set during login)
    const storage = FlutterSecureStorage();
    final pid = await storage.read(key: 'patient_id');
    final uid = await storage.read(key: 'firebase_uid');
    if (mounted) {
      setState(() => _patientId = pid ?? uid);
      if (_patientId != null) {
        _fetchSummaryData();
      } else {
        setState(() {
          _isLoadingSummary = false;
          _summaryError = 'Patient ID not available';
        });
      }
    }
  }

  // ─── Records Tab ───

  Future<void> _fetchRecords() async {
    if (!mounted) return;
    setState(() => _isLoadingRecords = true);

    final uri = Uri.parse(
      '${ApiConfig.baseUrl}/records/health-records/${widget.phone}'
      '${_selectedType == 'All' ? '' : '?type=${_selectedType.toLowerCase()}'}',
    );

    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;

    try {
      final resp =
          await http.get(uri, headers: await ApiConfig.authenticatedAuthHeaders());
      if (!mounted) return;

      if (resp.statusCode == 200) {
        final body = jsonDecode(resp.body);
        final List<dynamic> data = body is List
            ? body
            : (body['data']?['records'] ?? body['data'] ?? []) as List<dynamic>;
        await RecordCacheManager.saveManifest(widget.phone, data);
        if (!mounted) return;
        setState(() {
          records = _newestFirst ? data : data.reversed.toList();
          _isLoadingRecords = false;
        });
      } else {
        _tryLoadFromCache(messenger, theme, l10n.recordsLoadFailed);
      }
    } catch (_) {
      _tryLoadFromCache(messenger, theme, l10n.networkError);
    }
  }

  Future<void> _tryLoadFromCache(
    ScaffoldMessengerState messenger,
    ThemeData theme,
    String errorMsg,
  ) async {
    final cached = await RecordCacheManager.loadManifest(widget.phone);
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

    final url = Uri.parse('${ApiConfig.baseUrl}/upload/by-key/$fileKey');

    try {
      final resp =
          await http.get(url, headers: await ApiConfig.authenticatedAuthHeaders());
      if (!mounted) return;

      if (resp.statusCode == 200) {
        final body = jsonDecode(resp.body);
        final data = body['data'] ?? body;
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
    } catch (_) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.fileCouldNotOpen),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  // ─── Consultations Tab ───

  Future<void> _fetchConsultations() async {
    if (!mounted) return;
    setState(() {
      _isLoadingConsultations = true;
      _consultationsError = null;
    });

    final uri = Uri.parse(
      '${ApiConfig.baseUrl}/records/consultations/${widget.phone}',
    );

    try {
      final resp =
          await http.get(uri, headers: await ApiConfig.authenticatedAuthHeaders());
      if (!mounted) return;

      if (resp.statusCode == 200) {
        final body = jsonDecode(resp.body);
        final List<dynamic> data = body is List
            ? body
            : (body['data']?['records'] ?? body['data'] ?? []) as List<dynamic>;
        setState(() {
          _consultations = data;
          _isLoadingConsultations = false;
        });
      } else {
        setState(() {
          _isLoadingConsultations = false;
          _consultationsError = 'Failed to load consultations';
        });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _isLoadingConsultations = false;
        _consultationsError = 'Network error';
      });
    }
  }

  // ─── Summary Tab ───

  Future<void> _fetchSummaryData() async {
    if (_patientId == null || !mounted) return;
    setState(() {
      _isLoadingSummary = true;
      _summaryError = null;
    });

    final headers = await ApiConfig.authenticatedAuthHeaders();

    try {
      final results = await Future.wait([
        http.get(
          Uri.parse('${ApiConfig.baseUrl}/health/patient/$_patientId/summary'),
          headers: headers,
        ),
        http.get(
          Uri.parse('${ApiConfig.baseUrl}/health/patient/$_patientId/allergies'),
          headers: headers,
        ),
        http.get(
          Uri.parse('${ApiConfig.baseUrl}/health/patient/$_patientId/conditions'),
          headers: headers,
        ),
      ]);

      if (!mounted) return;

      Map<String, dynamic>? summary;
      List<dynamic> allergies = [];
      List<dynamic> conditions = [];

      if (results[0].statusCode == 200) {
        final body = jsonDecode(results[0].body);
        summary = body['data'] ?? body;
      }
      if (results[1].statusCode == 200) {
        final body = jsonDecode(results[1].body);
        final d = body['data'] ?? body;
        allergies = d is List ? d : (d['allergies'] ?? []);
      }
      if (results[2].statusCode == 200) {
        final body = jsonDecode(results[2].body);
        final d = body['data'] ?? body;
        conditions = d is List ? d : (d['conditions'] ?? []);
      }

      setState(() {
        _summary = summary;
        _allergies = allergies;
        _conditions = conditions;
        _isLoadingSummary = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _isLoadingSummary = false;
        _summaryError = 'Failed to load health summary';
      });
    }
  }

  bool _isUploading = false;

  Future<void> _uploadDocument() async {
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);

    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png'],
      );
      if (result == null || result.files.single.path == null) return;

      final file = File(result.files.single.path!);
      final fileName = result.files.single.name;

      setState(() => _isUploading = true);

      final uploadHeaders = await ApiConfig.authenticatedAuthHeaders();
      final req = http.MultipartRequest(
        'POST',
        Uri.parse('${ApiConfig.baseUrl}/upload'),
      )
        ..headers.addAll(uploadHeaders)
        ..files.add(await http.MultipartFile.fromPath('file', file.path, filename: fileName));

      final streamedRes = await req.send();
      final res = await http.Response.fromStream(streamedRes);

      if (!mounted) return;

      if (res.statusCode == 200) {
        messenger.showSnackBar(SnackBar(
          content: Text('$fileName uploaded successfully'),
          backgroundColor: theme.colorScheme.primary,
          behavior: SnackBarBehavior.floating,
        ));
        _fetchRecords();
      } else {
        messenger.showSnackBar(SnackBar(
          content: const Text('Upload failed. Please try again.'),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ));
      }
    } catch (_) {
      if (mounted) {
        messenger.showSnackBar(SnackBar(
          content: const Text('Could not upload file.'),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ));
      }
    } finally {
      if (mounted) setState(() => _isUploading = false);
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

    return FeatureScreenScaffold(
      title: l10n.yourHealthTitle,
      icon: Icons.monitor_heart_outlined,
      color: _color,
      heroTag: 'yourHealth',
      floatingActionButton: _isGuest
          ? null
          : FloatingActionButton.extended(
              onPressed: _isUploading ? null : _uploadDocument,
              icon: _isUploading
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : const Icon(Icons.upload_file),
              label: Text(_isUploading ? 'Uploading...' : 'Upload Document'),
            ),
      child: _isGuest
          ? _buildGuestView(theme, cs, l10n)
          : Column(
              children: [
                TabBar(
                  controller: _tabController,
                  labelColor: cs.primary,
                  unselectedLabelColor: cs.onSurfaceVariant,
                  indicatorColor: cs.primary,
                  tabs: [
                    Tab(text: l10n.yourHealthTabRecords),
                    Tab(text: l10n.yourHealthTabConsultations),
                    Tab(text: l10n.yourHealthTabSummary),
                  ],
                ),
                Expanded(
                  child: TabBarView(
                    controller: _tabController,
                    children: [
                      _buildRecordsTab(theme, cs, l10n),
                      _buildConsultationsTab(theme, cs, l10n),
                      _buildSummaryTab(theme, cs, l10n),
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

  // ─── Records Tab ───

  Widget _buildRecordsTab(
      ThemeData theme, ColorScheme cs, AppLocalizations l10n) {
    final dateFmt =
        DateFormat.yMMMd(Localizations.localeOf(context).toString());

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: DropdownButtonFormField<String>(
            value: _selectedType,
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
                          } catch (_) {}
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

  // ─── Consultations Tab ───

  Widget _buildConsultationsTab(
      ThemeData theme, ColorScheme cs, AppLocalizations l10n) {
    final dateFmt =
        DateFormat.yMMMd(Localizations.localeOf(context).toString());

    if (_isLoadingConsultations) {
      return Center(
        child: CircularProgressIndicator(
            valueColor: AlwaysStoppedAnimation(cs.primary)),
      );
    }

    if (_consultationsError != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 48, color: cs.error),
            const SizedBox(height: 12),
            Text(_consultationsError!,
                style: theme.textTheme.bodyLarge
                    ?.copyWith(color: cs.onSurfaceVariant)),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: _fetchConsultations,
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    if (_consultations.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.medical_services_outlined,
                size: 48, color: cs.onSurface.withAlpha(100)),
            const SizedBox(height: 12),
            Text(l10n.consultationsEmpty,
                style: theme.textTheme.bodyLarge
                    ?.copyWith(color: cs.onSurfaceVariant)),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchConsultations,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _consultations.length,
        itemBuilder: (_, i) {
          final c = _consultations[i];
          final doctor = c['doctor_name'] ?? c['doctor'] ?? '';
          final diagnosis = c['diagnosis'] ?? '';
          final notes = c['notes'] ?? c['description'] ?? '';
          DateTime? date;
          final dateStr = c['date'] ?? c['consultation_date'] ?? c['created_at'];
          if (dateStr != null) {
            try {
              date = DateTime.parse(dateStr.toString()).toLocal();
            } catch (_) {}
          }

          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(Icons.medical_services_outlined,
                          color: cs.primary, size: 20),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          doctor.isNotEmpty ? doctor : 'Consultation',
                          style: theme.textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w600),
                        ),
                      ),
                      if (date != null)
                        Text(
                          dateFmt.format(date),
                          style: theme.textTheme.bodySmall
                              ?.copyWith(color: cs.onSurfaceVariant),
                        ),
                    ],
                  ),
                  if (diagnosis.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${l10n.consultationDiagnosis}: ',
                            style: theme.textTheme.bodySmall
                                ?.copyWith(fontWeight: FontWeight.w600)),
                        Expanded(
                          child: Text(diagnosis,
                              style: theme.textTheme.bodySmall),
                        ),
                      ],
                    ),
                  ],
                  if (notes.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(notes,
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: cs.onSurfaceVariant)),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  // ─── Summary Tab ───

  Widget _buildSummaryTab(
      ThemeData theme, ColorScheme cs, AppLocalizations l10n) {
    if (_isLoadingSummary) {
      return Center(
        child: CircularProgressIndicator(
            valueColor: AlwaysStoppedAnimation(cs.primary)),
      );
    }

    if (_summaryError != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.info_outline, size: 48, color: cs.onSurface.withAlpha(100)),
            const SizedBox(height: 12),
            Text(_summaryError!,
                style: theme.textTheme.bodyLarge
                    ?.copyWith(color: cs.onSurfaceVariant)),
            if (_patientId != null) ...[
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: _fetchSummaryData,
                child: const Text('Retry'),
              ),
            ],
          ],
        ),
      );
    }

    final hasSummary = _summary != null;
    final hasAllergies = _allergies.isNotEmpty;
    final hasConditions = _conditions.isNotEmpty;

    if (!hasSummary && !hasAllergies && !hasConditions) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.health_and_safety_outlined,
                size: 48, color: cs.onSurface.withAlpha(100)),
            const SizedBox(height: 12),
            Text(l10n.summaryNoData,
                style: theme.textTheme.bodyLarge
                    ?.copyWith(color: cs.onSurfaceVariant)),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchSummaryData,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          // Health Overview
          if (hasSummary) ...[
            _sectionHeader(l10n.summaryOverview, Icons.monitor_heart_outlined, cs),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (_summary!['total_records'] != null)
                      _summaryRow('Total Records',
                          _summary!['total_records'].toString(), theme),
                    if (_summary!['last_visit'] != null)
                      _summaryRow('Last Visit',
                          _formatDate(_summary!['last_visit']), theme),
                    if (_summary!['record_types'] != null)
                      ..._buildRecordTypeSummary(
                          _summary!['record_types'], theme),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
          ],

          // Allergies
          _sectionHeader(l10n.summaryAllergies, Icons.warning_amber_outlined, cs),
          if (!hasAllergies)
            Card(
              child: ListTile(
                leading: Icon(Icons.check_circle_outline, color: cs.tertiary),
                title: Text(l10n.summaryNoAllergies),
              ),
            )
          else
            ...(_allergies.map((a) => Card(
                  child: ListTile(
                    leading: Icon(Icons.warning_amber, color: cs.error),
                    title: Text(a['name'] ?? a['allergen'] ?? 'Unknown'),
                    subtitle: a['severity'] != null
                        ? Text('Severity: ${a['severity']}')
                        : null,
                  ),
                ))),
          const SizedBox(height: 16),

          // Conditions
          _sectionHeader(l10n.summaryConditions, Icons.local_hospital_outlined, cs),
          if (!hasConditions)
            Card(
              child: ListTile(
                leading: Icon(Icons.check_circle_outline, color: cs.tertiary),
                title: Text(l10n.summaryNoConditions),
              ),
            )
          else
            ...(_conditions.map((c) => Card(
                  child: ListTile(
                    leading: Icon(Icons.local_hospital_outlined,
                        color: (c['active'] == true || c['status'] == 'active')
                            ? cs.error
                            : cs.onSurfaceVariant),
                    title: Text(c['name'] ?? c['condition'] ?? 'Unknown'),
                    subtitle: c['diagnosed_date'] != null
                        ? Text('Since: ${_formatDate(c['diagnosed_date'])}')
                        : null,
                    trailing: (c['active'] == true || c['status'] == 'active')
                        ? Chip(
                            label: const Text('Active'),
                            backgroundColor: cs.errorContainer,
                            labelStyle: TextStyle(
                                color: cs.onErrorContainer, fontSize: 11),
                            visualDensity: VisualDensity.compact,
                          )
                        : null,
                  ),
                ))),
        ],
      ),
    );
  }

  Widget _sectionHeader(String title, IconData icon, ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8, top: 4),
      child: Row(
        children: [
          Icon(icon, size: 20, color: cs.primary),
          const SizedBox(width: 8),
          Text(title,
              style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: cs.onSurface)),
        ],
      ),
    );
  }

  Widget _summaryRow(String label, String value, ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: theme.textTheme.bodyMedium),
          Text(value,
              style: theme.textTheme.bodyMedium
                  ?.copyWith(fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }

  List<Widget> _buildRecordTypeSummary(dynamic types, ThemeData theme) {
    if (types is Map) {
      return types.entries
          .map((e) => _summaryRow(e.key.toString(), e.value.toString(), theme))
          .toList();
    }
    return [];
  }

  String _formatDate(dynamic dateVal) {
    try {
      final d = DateTime.parse(dateVal.toString()).toLocal();
      return DateFormat.yMMMd().format(d);
    } catch (_) {
      return dateVal.toString();
    }
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
