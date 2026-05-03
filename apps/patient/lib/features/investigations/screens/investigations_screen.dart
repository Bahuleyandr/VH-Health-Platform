// Enhanced investigations_screen.dart with Upload + Results tabs
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:intl/intl.dart';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/investigations/screens/book_investigation_screen.dart';
import 'package:vhhealth/core/widgets/contact_banner.dart';
import 'package:vhhealth/features/investigations/screens/my_bookings_screen.dart';
import 'package:vhhealth/features/investigations/widgets/result_gauge_widget.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class InvestigationsScreen extends StatefulWidget {
  final String phone;
  const InvestigationsScreen({super.key, required this.phone});

  @override
  State<InvestigationsScreen> createState() => _InvestigationsScreenState();
}

class _InvestigationsScreenState extends State<InvestigationsScreen>
    with SingleTickerProviderStateMixin {
  // Upload tab state
  final _formKey = GlobalKey<FormState>();
  final _testNameController = TextEditingController();
  final _phoneController = TextEditingController();

  File? _file;
  String? _fileName;
  bool _isSubmitting = false;

  // Results tab state
  List<dynamic> _investigations = [];
  bool _isLoadingResults = true;
  String? _resultsError;

  // Expanded investigation file lists
  final Map<String, List<dynamic>> _fileCache = {};
  final Set<String> _expandedIds = {};
  final Set<String> _loadingFiles = {};

  // Auth-based patient ID
  String? _patientId;
  final _secureStorage = const FlutterSecureStorage();

  late final bool _isGuest;
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _isGuest =
        widget.phone.toLowerCase() == 'guest' || widget.phone.trim().isEmpty;
    _phoneController.text = _isGuest ? '' : widget.phone;
    _tabController = TabController(length: 3, vsync: this);
    if (!_isGuest) {
      _loadPatientIdAndFetch();
    } else {
      _isLoadingResults = false;
    }
  }

  Future<void> _loadPatientIdAndFetch() async {
    _patientId = await _secureStorage.read(key: 'user_id');
    _fetchInvestigations();
  }

  @override
  void dispose() {
    _testNameController.dispose();
    _phoneController.dispose();
    _tabController.dispose();
    super.dispose();
  }

  // ─── Upload Tab Logic (existing) ───

  Future<bool> _ensurePickerPermissions() async {
    const needs = [Permission.photos, Permission.storage];
    for (final p in needs) {
      if (!await PermissionsService.ensurePermission(context, p)) return false;
    }
    return true;
  }

  Future<void> _pickFile() async {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final messenger = ScaffoldMessenger.of(context);

    if (!await _ensurePickerPermissions()) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.pharmacyPermissionsRequired),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }

    try {
      final result = await FilePicker.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['pdf', 'doc', 'docx', 'jpg', 'png'],
      );
      if (result?.files.single.path != null) {
        final file = File(result!.files.single.path!);
        final sizeBytes = await file.length();
        const maxSizeBytes = 10 * 1024 * 1024; // 10 MB
        if (sizeBytes > maxSizeBytes) {
          if (mounted) {
            messenger.showSnackBar(
              SnackBar(
                content: Text(
                  AppLocalizations.of(context)!.investigationsFileTooLarge,
                ),
                backgroundColor: theme.colorScheme.error,
                behavior: SnackBarBehavior.floating,
              ),
            );
          }
          return;
        }
        setState(() {
          _file = file;
          _fileName = result.files.single.name;
        });
      }
    } catch (e) {
      debugPrint('Investigation file pick failed: $e');
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.pharmacyFilePickerError),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final messenger = ScaffoldMessenger.of(context);

    if (!_formKey.currentState!.validate() || _file == null) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.investigationsFormAndFileRequired),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }

    setState(() => _isSubmitting = true);
    String? fileKey;

    try {
      final uploadResponse = await ApiClient.multipart(
        '/upload',
        files: [
          await http.MultipartFile.fromPath(
            'file',
            _file!.path,
            filename: _fileName,
          ),
        ],
      );
      if (uploadResponse.isSuccess) {
        final data = uploadResponse.dataAsMap();
        fileKey = data['storageKey'] ?? uploadResponse.raw?['storageKey'];
        if (fileKey == null) throw Exception('Key missing');
      } else {
        throw Exception('Upload failed');
      }
    } catch (e) {
      debugPrint('Investigation file upload failed: $e');
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.investigationsUploadFailed),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
      if (mounted) setState(() => _isSubmitting = false);
      return;
    }

    try {
      final apiRes = await ApiClient.post(
        '/investigations',
        body: {
          'phone': _phoneController.text.trim(),
          'test_name': _testNameController.text.trim(),
          'file_key': fileKey,
        },
      );

      if (apiRes.isSuccess) {
        messenger.showSnackBar(
          SnackBar(
            content: Text(l10n.investigationsConfirmationNote),
            backgroundColor: theme.colorScheme.primary,
            behavior: SnackBarBehavior.floating,
          ),
        );
        // Switch to results tab and refresh
        _tabController.animateTo(1);
        _fetchInvestigations();
        // Reset form
        _testNameController.clear();
        setState(() {
          _file = null;
          _fileName = null;
        });
      } else {
        final msg = (apiRes.message ?? l10n.investigationsFailed).toString();
        messenger.showSnackBar(
          SnackBar(
            content: Text(msg),
            backgroundColor: theme.colorScheme.error,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      debugPrint('Investigation submit failed: $e');
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.networkError),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  // ─── Results Tab Logic ───

  Future<void> _fetchInvestigations() async {
    if (!mounted) return;
    setState(() {
      _isLoadingResults = true;
      _resultsError = null;
    });

    // Prefer patient_id-based fetch; fall back to phone-based
    final path = _patientId != null
        ? '/investigations/patient/$_patientId'
        : '/investigations/${widget.phone}';

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
        SnackBar(
          content: Text(l10n.investigationsDownloadFailed),
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
    final l10n = AppLocalizations.of(context)!;
    final cs = Theme.of(context).colorScheme;
    final color = FeatureScreenScaffold.featureColors['investigations']!;

    return FeatureScreenScaffold(
      title: l10n.investigationsTitle,
      icon: Icons.science_outlined,
      color: color,
      heroTag: 'investigations',
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            labelColor: cs.primary,
            unselectedLabelColor: cs.onSurfaceVariant,
            indicatorColor: cs.primary,
            tabs: [
              const Tab(
                icon: Icon(Icons.science_outlined, size: 18),
                text: 'My Bookings',
              ),
              Tab(
                icon: const Icon(Icons.upload_file_outlined, size: 18),
                text: l10n.investigationsTabUpload,
              ),
              Tab(
                icon: const Icon(Icons.list_alt_outlined, size: 18),
                text: l10n.investigationsTabResults,
              ),
            ],
          ),
          ContactBanner.homeSampleCollection(),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _buildBookingsTab(context),
                _buildUploadTab(context),
                _buildResultsTab(context),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBookingsTab(BuildContext context) {
    // ignore: unused_local_variable
    final theme = Theme.of(context);
    return Column(
      children: [
        // Book Investigation button
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: () async {
                await Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => const BookInvestigationScreen(),
                  ),
                );
              },
              icon: const Icon(Icons.add),
              label: Text(
                AppLocalizations.of(context)!.investigationsBookButton,
              ),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ),
        ),
        // My bookings list
        const Expanded(child: MyBookingsScreen()),
      ],
    );
  }

  Widget _buildUploadTab(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(16),
        shrinkWrap: true,
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          if (_isGuest) ...[
            TextFormField(
              controller: _phoneController,
              keyboardType: TextInputType.phone,
              decoration: InputDecoration(
                labelText: l10n.pharmacyPhoneNumberLabel,
                hintText: l10n.pharmacyPhoneNumberHint,
                prefixIcon: const Icon(Icons.phone_outlined),
              ),
              validator: (v) => v == null || v.trim().length != 10
                  ? l10n.pharmacyPhoneNumberValidationInvalid
                  : null,
            ),
            const SizedBox(height: 16),
          ],
          TextFormField(
            controller: _testNameController,
            textCapitalization: TextCapitalization.words,
            decoration: InputDecoration(
              labelText: l10n.investigationsTestNameLabel,
              hintText: l10n.investigationsTestNameHint,
              prefixIcon: const Icon(Icons.science_outlined),
            ),
            validator: (v) => v == null || v.trim().isEmpty
                ? l10n.investigationsTestNameValidationRequired
                : null,
          ),
          const SizedBox(height: 16),
          ElevatedButton.icon(
            onPressed: _isSubmitting ? null : _pickFile,
            icon: const Icon(Icons.upload_file_outlined),
            label: Text(
              _fileName?.isNotEmpty == true
                  ? '${l10n.fileSelected}: $_fileName'
                  : l10n.investigationsUploadFileButtonLabel,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (_fileName != null)
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                icon: const Icon(Icons.close, size: 16),
                label: Text(
                  l10n.fileClearSelection,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
                onPressed: _isSubmitting
                    ? null
                    : () => setState(() {
                        _file = null;
                        _fileName = null;
                      }),
              ),
            ),
          const SizedBox(height: 24),
          ElevatedButton(
            onPressed: _isSubmitting ? null : _submit,
            child: _isSubmitting
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2.5),
                  )
                : Text(l10n.investigationsSubmitRequestButton),
          ),
        ],
      ),
    );
  }

  Widget _buildResultsTab(BuildContext context) {
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
              child: const Text('Retry'),
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
