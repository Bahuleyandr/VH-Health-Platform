// Enhanced your_health_screen.dart — merged Records + Your Health into single hub
import 'package:go_router/go_router.dart';

import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/utils/cache_file_utils.dart';
import 'package:vhhealth/core/offline/record_cache_manager.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/l10n/app_localizations_ext.dart';

class YourHealthScreen extends StatefulWidget {
  final String phone;
  final int initialTab;
  const YourHealthScreen({super.key, required this.phone, this.initialTab = 0});

  @override
  State<YourHealthScreen> createState() => _YourHealthScreenState();
}

class _YourHealthScreenState extends State<YourHealthScreen>
    with SingleTickerProviderStateMixin {
  // Health Records tab state
  List<dynamic> records = [];
  bool _isLoadingRecords = true;
  String _selectedType = 'All';
  bool _newestFirst = true;

  // Hospital Documents tab state (from Records screen)
  List<Map<String, dynamic>> _hospitalRecords = [];
  bool _isLoadingHospitalRecords = true;

  // My Uploads tab state (from Records screen)
  List<Map<String, dynamic>> _myUploads = [];
  bool _isLoadingMyUploads = true;
  String? _recordsError;

  // Consultations tab state
  List<dynamic> _consultations = [];
  bool _isLoadingConsultations = true;
  String? _consultationsError;

  // Prescriptions tab state
  List<dynamic> _prescriptions = [];
  bool _isLoadingPrescriptions = true;
  String? _prescriptionsError;

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
    _tabController = TabController(length: 6, vsync: this, initialIndex: widget.initialTab);
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

    // Allow tab override from route extra
    final tabIndex = extra?['tab'] as int?;
    if (tabIndex != null && tabIndex >= 0 && tabIndex < 6) {
      _tabController.index = tabIndex;
    }

    if (!_isGuest) {
      _fetchRecords();
      _fetchConsultations();
      _fetchPatientRecords();
      _fetchPrescriptions();
    } else {
      setState(() {
        _isLoadingRecords = false;
        _isLoadingConsultations = false;
        _isLoadingSummary = false;
        _isLoadingHospitalRecords = false;
        _isLoadingMyUploads = false;
        _isLoadingPrescriptions = false;
      });
    }
  }

  Future<void> _loadPatientId() async {
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

  // ─── Health Records Tab (existing) ───

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
          await http.get(uri, headers: await ApiConfig.authenticatedAuthHeaders()).timeout(const Duration(seconds: 15));
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
          await http.get(url, headers: await ApiConfig.authenticatedAuthHeaders()).timeout(const Duration(seconds: 15));
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

  // ─── Hospital Documents + My Uploads (from Records screen) ───

  Future<void> _fetchPatientRecords() async {
    if (!mounted) return;
    setState(() {
      _isLoadingHospitalRecords = true;
      _isLoadingMyUploads = true;
      _recordsError = null;
    });

    try {
      final resp = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/appointments/patient/records/all'),
        headers: await ApiConfig.authenticatedAuthHeaders(),
      ).timeout(const Duration(seconds: 15));

      if (!mounted) return;

      if (resp.statusCode == 200) {
        final body = jsonDecode(resp.body);
        final data = body['data'] ?? body;
        final hospitalRaw = (data['hospital_records'] as List?) ?? [];
        final uploadsRaw = (data['my_uploads'] as List?) ?? [];

        setState(() {
          _hospitalRecords = hospitalRaw
              .map((j) => Map<String, dynamic>.from(j as Map))
              .toList();
          _myUploads = uploadsRaw
              .map((j) => Map<String, dynamic>.from(j as Map))
              .toList();
          _isLoadingHospitalRecords = false;
          _isLoadingMyUploads = false;
        });
      } else {
        setState(() {
          _recordsError = 'Failed to load records (${resp.statusCode})';
          _isLoadingHospitalRecords = false;
          _isLoadingMyUploads = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _recordsError = e.toString();
        _isLoadingHospitalRecords = false;
        _isLoadingMyUploads = false;
      });
    }
  }

  Future<void> _openDocument(Map<String, dynamic> record) async {
    final url = record['file_url']?.toString();
    if (url == null || url.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Document URL not available')),
      );
      return;
    }
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } else {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not open document')),
        );
      }
    }
  }

  Future<void> _deleteUploadedRecord(Map<String, dynamic> record) async {
    final id = record['id'];
    if (id == null) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Record?'),
        content: Text('Delete "${record['title'] ?? 'this record'}"? This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red, foregroundColor: Colors.white),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    try {
      final resp = await http.delete(
        Uri.parse('${ApiConfig.baseUrl}/appointments/patient/records/$id'),
        headers: await ApiConfig.authenticatedAuthHeaders(),
      ).timeout(const Duration(seconds: 15));
      if (resp.statusCode == 200) {
        if (mounted) {
          setState(() => _myUploads.removeWhere((r) => r['id'] == id));
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Record deleted'), backgroundColor: Colors.red),
          );
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Failed to delete record'), backgroundColor: Colors.red),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e'), backgroundColor: Colors.red),
        );
      }
    }
  }

  void _showUploadSheet() {
    final titleCtrl = TextEditingController();
    final hospitalCtrl = TextEditingController();
    String docType = 'other';
    DateTime? recordDate;
    String? pickedFilePath;
    String? pickedFileName;
    bool uploading = false;

    final docTypes = [
      ('prescription', 'Prescription'),
      ('lab_report', 'Lab Report'),
      ('radiology', 'X-Ray / Radiology'),
      ('vaccination', 'Vaccination'),
      ('insurance', 'Insurance'),
      ('discharge_summary', 'Discharge Summary'),
      ('other', 'Other'),
    ];

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) {
        Future<void> upload() async {
          if (pickedFilePath == null || titleCtrl.text.trim().isEmpty) {
            ScaffoldMessenger.of(ctx).showSnackBar(
              const SnackBar(content: Text('Please pick a file and enter a title')),
            );
            return;
          }
          setSheet(() => uploading = true);
          try {
            final headers = await ApiConfig.authenticatedAuthHeaders();
            final req = http.MultipartRequest(
              'POST',
              Uri.parse('${ApiConfig.baseUrl}/appointments/patient/records/upload'),
            )
              ..headers.addAll(headers)
              ..fields['title'] = titleCtrl.text.trim()
              ..fields['document_type'] = docType
              ..files.add(await http.MultipartFile.fromPath(
                'file', pickedFilePath!,
                filename: pickedFileName,
              ));
            if (hospitalCtrl.text.trim().isNotEmpty) {
              req.fields['source_hospital'] = hospitalCtrl.text.trim();
            }
            if (recordDate != null) {
              req.fields['record_date'] =
                  '${recordDate!.year}-${recordDate!.month.toString().padLeft(2, '0')}-${recordDate!.day.toString().padLeft(2, '0')}';
            }
            final streamed = await req.send().timeout(const Duration(seconds: 30));
            final resp = await http.Response.fromStream(streamed);
            if (resp.statusCode == 200 || resp.statusCode == 201) {
              if (ctx.mounted) Navigator.pop(ctx);
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Record uploaded ✓'), backgroundColor: Colors.green),
                );
                _fetchPatientRecords();
              }
            } else {
              final body = jsonDecode(resp.body);
              throw Exception(body['message'] ?? 'Upload failed');
            }
          } catch (e) {
            if (ctx.mounted) {
              ScaffoldMessenger.of(ctx).showSnackBar(
                SnackBar(content: Text('Upload failed: $e'), backgroundColor: Colors.red),
              );
            }
          } finally {
            if (ctx.mounted) setSheet(() => uploading = false);
          }
        }

        return Padding(
          padding: EdgeInsets.only(
            left: 20, right: 20, top: 20,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Upload Record',
                    style: Theme.of(ctx).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(height: 16),
                TextField(
                  controller: titleCtrl,
                  decoration: const InputDecoration(labelText: 'Title *', border: OutlineInputBorder()),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: docType,
                  decoration: const InputDecoration(labelText: 'Document Type', border: OutlineInputBorder()),
                  items: docTypes.map((t) => DropdownMenuItem(
                    value: t.$1,
                    child: Text(t.$2),
                  )).toList(),
                  onChanged: (v) => setSheet(() => docType = v ?? docType),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: hospitalCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Source Hospital (optional)',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  icon: const Icon(Icons.calendar_today, size: 16),
                  label: Text(recordDate == null
                      ? 'Document Date (optional)'
                      : '${recordDate!.day}/${recordDate!.month}/${recordDate!.year}'),
                  onPressed: () async {
                    final d = await showDatePicker(
                      context: ctx,
                      initialDate: DateTime.now(),
                      firstDate: DateTime(2000),
                      lastDate: DateTime.now(),
                    );
                    if (d != null) setSheet(() => recordDate = d);
                  },
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  icon: const Icon(Icons.attach_file),
                  label: Text(pickedFileName ?? 'Pick File *'),
                  onPressed: () async {
                    final result = await FilePicker.platform.pickFiles(
                      type: FileType.custom,
                      allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png'],
                    );
                    if (result != null && result.files.single.path != null) {
                      setSheet(() {
                        pickedFilePath = result.files.single.path;
                        pickedFileName = result.files.single.name;
                      });
                    }
                  },
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: uploading ? null : upload,
                    child: uploading
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Upload'),
                  ),
                ),
              ],
            ),
          ),
        );
      }),
    );
  }

  // ─── Prescriptions Tab ───

  Future<void> _fetchPrescriptions() async {
    if (!mounted) return;
    setState(() {
      _isLoadingPrescriptions = true;
      _prescriptionsError = null;
    });
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final resp = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/prescriptions/patient/my'),
        headers: headers,
      ).timeout(const Duration(seconds: 15));
      final data = jsonDecode(resp.body);
      if (data['success'] == true && mounted) {
        setState(() => _prescriptions = data['data'] ?? []);
      } else if (mounted) {
        setState(() => _prescriptionsError = data['message'] ?? 'Failed');
      }
    } catch (e) {
      if (mounted) setState(() => _prescriptionsError = e.toString());
    } finally {
      if (mounted) setState(() => _isLoadingPrescriptions = false);
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
          await http.get(uri, headers: await ApiConfig.authenticatedAuthHeaders()).timeout(const Duration(seconds: 15));
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
        ).timeout(const Duration(seconds: 15)),
        http.get(
          Uri.parse('${ApiConfig.baseUrl}/health/patient/$_patientId/allergies'),
          headers: headers,
        ).timeout(const Duration(seconds: 15)),
        http.get(
          Uri.parse('${ApiConfig.baseUrl}/health/patient/$_patientId/conditions'),
          headers: headers,
        ).timeout(const Duration(seconds: 15)),
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

      final streamedRes = await req.send().timeout(const Duration(seconds: 30));
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

    // Show upload FAB only on My Uploads tab (index 2)
    final showUploadFab = !_isGuest && _tabController.index == 2;

    return FeatureScreenScaffold(
      title: l10n.yourHealthTitle,
      icon: Icons.monitor_heart_outlined,
      color: _color,
      heroTag: 'yourHealth',
      floatingActionButton: showUploadFab
          ? FloatingActionButton.extended(
              onPressed: _showUploadSheet,
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
                      _buildHospitalDocumentsTab(theme, cs),
                      _buildMyUploadsTab(theme, cs),
                      _buildPrescriptionsTab(theme, cs),
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

  // ─── Hospital Documents Tab (merged from Records screen) ───

  Widget _buildHospitalDocumentsTab(ThemeData theme, ColorScheme cs) {
    if (_isLoadingHospitalRecords) {
      return Center(
        child: CircularProgressIndicator(
            valueColor: AlwaysStoppedAnimation(cs.primary)),
      );
    }

    if (_recordsError != null && _hospitalRecords.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_recordsError!, style: TextStyle(color: cs.error), textAlign: TextAlign.center),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _fetchPatientRecords, child: const Text('Retry')),
          ],
        ),
      );
    }

    if (_hospitalRecords.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.local_hospital_outlined, size: 64, color: Colors.grey),
              SizedBox(height: 12),
              Text(
                'Your prescriptions and reports from visits will appear here',
                style: TextStyle(color: Colors.grey),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchPatientRecords,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _hospitalRecords.length,
        itemBuilder: (_, i) => _buildRecordCard(_hospitalRecords[i], theme, cs),
      ),
    );
  }

  // ─── My Uploads Tab (merged from Records screen) ───

  Widget _buildMyUploadsTab(ThemeData theme, ColorScheme cs) {
    if (_isLoadingMyUploads) {
      return Center(
        child: CircularProgressIndicator(
            valueColor: AlwaysStoppedAnimation(cs.primary)),
      );
    }

    if (_recordsError != null && _myUploads.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_recordsError!, style: TextStyle(color: cs.error), textAlign: TextAlign.center),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _fetchPatientRecords, child: const Text('Retry')),
          ],
        ),
      );
    }

    if (_myUploads.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.folder_open, size: 64, color: Colors.grey),
              const SizedBox(height: 12),
              const Text(
                'Upload your previous prescriptions and reports to keep them in one place',
                style: TextStyle(color: Colors.grey),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 20),
              ElevatedButton.icon(
                onPressed: _showUploadSheet,
                icon: const Icon(Icons.upload_file),
                label: const Text('Upload a Record'),
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchPatientRecords,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _myUploads.length,
        itemBuilder: (_, i) {
          final record = _myUploads[i];
          return Dismissible(
            key: Key('upload_${record['id']}'),
            direction: DismissDirection.endToStart,
            background: Container(
              alignment: Alignment.centerRight,
              padding: const EdgeInsets.only(right: 20),
              color: Colors.red,
              child: const Icon(Icons.delete, color: Colors.white),
            ),
            confirmDismiss: (_) async {
              await _deleteUploadedRecord(record);
              return false;
            },
            child: _buildRecordCard(record, theme, cs, showSource: true),
          );
        },
      ),
    );
  }

  Widget _buildRecordCard(Map<String, dynamic> record, ThemeData theme, ColorScheme cs, {bool showSource = false}) {
    final docType = record['document_type']?.toString() ?? 'other';
    final title = record['title'] ?? docType.replaceAll('_', ' ').toUpperCase();
    final doctorName = record['doctor_name'];
    final department = record['doctor_department'] ?? record['department'];
    final fileUrl = record['file_url'];
    final sourceHospital = record['source_hospital'];
    final appointmentDate = record['appointment_date']?.toString().split('T').first;
    final createdAt = record['created_at']?.toString().split('T').first;
    final typeColor = _colorForDocType(docType);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        onTap: () => _openDocument(record),
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 44, height: 44,
                decoration: BoxDecoration(
                  color: typeColor.withOpacity(0.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(_iconForDocType(docType), color: typeColor, size: 24),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title.toString(),
                        style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold),
                        maxLines: 1, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 2),
                    if (doctorName != null)
                      Text(
                        '$doctorName${department != null ? ' • $department' : ''}',
                        style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey[600]),
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                      ),
                    if (sourceHospital != null)
                      Text(sourceHospital.toString(),
                          style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey[600]),
                          maxLines: 1, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: typeColor.withOpacity(0.12),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            docType.replaceAll('_', ' ').toUpperCase(),
                            style: TextStyle(color: typeColor, fontSize: 10, fontWeight: FontWeight.w600),
                          ),
                        ),
                        if (appointmentDate != null) ...[
                          const SizedBox(width: 8),
                          Text(appointmentDate,
                              style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey[500])),
                        ] else if (createdAt != null) ...[
                          const SizedBox(width: 8),
                          Text(createdAt,
                              style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey[500])),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(
                fileUrl != null ? Icons.open_in_new : Icons.lock,
                size: 18,
                color: fileUrl != null ? typeColor : Colors.grey,
              ),
            ],
          ),
        ),
      ),
    );
  }

  IconData _iconForDocType(String type) {
    switch (type) {
      case 'prescription': return Icons.medical_services;
      case 'lab_report': return Icons.science;
      case 'radiology': return Icons.image_search;
      case 'vaccination': return Icons.vaccines;
      case 'insurance': return Icons.shield;
      case 'discharge_summary': return Icons.assignment_returned;
      default: return Icons.description;
    }
  }

  Color _colorForDocType(String type) {
    switch (type) {
      case 'prescription': return Colors.blue;
      case 'lab_report': return Colors.purple;
      case 'radiology': return Colors.indigo;
      case 'vaccination': return Colors.green;
      case 'insurance': return Colors.teal;
      case 'discharge_summary': return Colors.orange;
      default: return Colors.blueGrey;
    }
  }

  // ─── Prescriptions Tab UI ───

  Widget _buildPrescriptionsTab(ThemeData theme, ColorScheme cs) {
    if (_isLoadingPrescriptions) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_prescriptionsError != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, size: 40, color: cs.error),
            const SizedBox(height: 8),
            Text(_prescriptionsError!, style: TextStyle(color: cs.onSurfaceVariant)),
            TextButton(onPressed: _fetchPrescriptions, child: const Text('Retry')),
          ],
        ),
      );
    }
    if (_prescriptions.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.medication_outlined, size: 56, color: cs.onSurfaceVariant),
            const SizedBox(height: 16),
            Text('No prescriptions yet',
                style: theme.textTheme.titleMedium?.copyWith(color: cs.onSurface)),
            const SizedBox(height: 8),
            Text('Your doctor prescriptions will appear here',
                style: TextStyle(color: cs.onSurfaceVariant)),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _fetchPrescriptions,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _prescriptions.length,
        itemBuilder: (_, i) {
          final rx = _prescriptions[i];
          final meds = rx['medications'] as List? ?? [];
          final createdAt = rx['created_at'] != null
              ? DateFormat('dd MMM yyyy').format(DateTime.parse(rx['created_at']).toLocal())
              : '';
          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => _showPrescriptionDetail(rx),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Row(
                  children: [
                    CircleAvatar(
                      backgroundColor: cs.primary.withOpacity(0.1),
                      child: Icon(Icons.medication, color: cs.primary, size: 22),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(rx['prescription_number'] ?? '',
                              style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
                          const SizedBox(height: 2),
                          Text('Dr. ${rx['doctor_name'] ?? ''} • ${rx['doctor_specialization'] ?? ''}',
                              style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
                          const SizedBox(height: 2),
                          Text('${meds.length} medicines • $createdAt',
                              style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
                        ],
                      ),
                    ),
                    if (rx['pharmacy_opted'] == true)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          color: Colors.green.shade50,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Text('Ordered', style: TextStyle(fontSize: 10, color: Colors.green)),
                      )
                    else
                      Icon(Icons.chevron_right, color: cs.onSurfaceVariant),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  void _showPrescriptionDetail(Map<String, dynamic> rx) {
    final meds = rx['medications'] as List? ?? [];
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.75,
        maxChildSize: 0.95,
        builder: (_, scrollCtrl) => ListView(
          controller: scrollCtrl,
          padding: const EdgeInsets.all(20),
          children: [
            Center(
              child: Container(
                  width: 40, height: 4,
                  decoration: BoxDecoration(color: Colors.grey[300], borderRadius: BorderRadius.circular(2))),
            ),
            const SizedBox(height: 16),
            Text(rx['prescription_number'] ?? '',
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text('Dr. ${rx['doctor_name'] ?? ''} • ${rx['doctor_specialization'] ?? ''}',
                style: TextStyle(color: Colors.grey[600])),
            if (rx['created_at'] != null)
              Text(DateFormat('dd MMM yyyy, hh:mm a').format(DateTime.parse(rx['created_at']).toLocal()),
                  style: TextStyle(fontSize: 12, color: Colors.grey[500])),
            const SizedBox(height: 16),

            if (rx['diagnosis'] != null && rx['diagnosis'].toString().isNotEmpty) ...[
              const Text('Diagnosis', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
              const SizedBox(height: 4),
              Text(rx['diagnosis']),
              const SizedBox(height: 16),
            ],

            const Text('Medications', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
            const SizedBox(height: 8),
            ...meds.asMap().entries.map((e) {
              final m = e.value;
              return Container(
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.grey[50],
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.grey.shade200),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 22, height: 22,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: const Color(0xFF00838F).withOpacity(0.1),
                            shape: BoxShape.circle,
                          ),
                          child: Text('${e.key + 1}',
                              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold,
                                  color: Color(0xFF00838F))),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(m['name'] ?? '',
                              style: const TextStyle(fontWeight: FontWeight.w600)),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text('${m['dosage'] ?? ''} • ${m['frequency'] ?? ''} • ${m['duration'] ?? ''} • ${m['route'] ?? 'Oral'}',
                        style: TextStyle(fontSize: 12, color: Colors.grey[600])),
                    if (m['instructions'] != null && m['instructions'].toString().isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text('📝 ${m['instructions']}',
                            style: const TextStyle(fontSize: 12, fontStyle: FontStyle.italic)),
                      ),
                  ],
                ),
              );
            }),

            if (rx['follow_up_date'] != null) ...[
              const SizedBox(height: 16),
              Row(
                children: [
                  const Icon(Icons.calendar_today, size: 16, color: Color(0xFF00838F)),
                  const SizedBox(width: 6),
                  Text('Follow-up: ${DateFormat('dd MMM yyyy').format(DateTime.parse(rx['follow_up_date']))}',
                      style: const TextStyle(fontWeight: FontWeight.w500)),
                ],
              ),
              if (rx['follow_up_notes'] != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4, left: 22),
                  child: Text(rx['follow_up_notes'], style: TextStyle(fontSize: 12, color: Colors.grey[600])),
                ),
            ],

            if (rx['clinical_notes'] != null && rx['clinical_notes'].toString().isNotEmpty) ...[
              const SizedBox(height: 16),
              const Text('Clinical Notes', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
              const SizedBox(height: 4),
              Text(rx['clinical_notes']),
            ],

            const SizedBox(height: 20),

            // PDF Download
            if (rx['pdf_url'] != null)
              OutlinedButton.icon(
                onPressed: () => launchUrl(Uri.parse(rx['pdf_url']), mode: LaunchMode.externalApplication),
                icon: const Icon(Icons.picture_as_pdf, size: 18),
                label: const Text('Download PDF'),
              ),

            const SizedBox(height: 10),

            // Order Medicines button
            if (rx['pharmacy_opted'] != true)
              ElevatedButton.icon(
                onPressed: () {
                  Navigator.pop(ctx);
                  _showOrderMedicinesSheet(rx);
                },
                icon: const Icon(Icons.shopping_cart, color: Colors.white, size: 18),
                label: const Text('Order Medicines'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF00838F),
                  padding: const EdgeInsets.symmetric(vertical: 12),
                ),
              )
            else
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.green.shade50,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.check_circle, color: Colors.green, size: 20),
                    const SizedBox(width: 8),
                    Expanded(child: Text('Medicines ordered via pharmacy (${rx['pharmacy_opt_type'] ?? ''})',
                        style: const TextStyle(color: Colors.green))),
                  ],
                ),
              ),

            const SizedBox(height: 30),
          ],
        ),
      ),
    );
  }

  void _showOrderMedicinesSheet(Map<String, dynamic> rx) {
    final meds = rx['medications'] as List? ?? [];
    String deliveryType = 'delivery';
    final addressCtrl = TextEditingController();
    final phoneCtrl = TextEditingController(text: widget.phone);
    bool ordering = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) {
        double totalEstimate = 0;
        for (final m in meds) {
          // Rough estimate — actual price comes from catalog
          totalEstimate += (m['quantity'] ?? 1) * 50.0;
        }

        return Padding(
          padding: EdgeInsets.only(
            left: 20, right: 20, top: 20,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Order Medicines',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                Text('From prescription ${rx['prescription_number']}',
                    style: TextStyle(color: Colors.grey[600], fontSize: 13)),
                const SizedBox(height: 16),

                // Medicine list
                ...meds.map((m) => Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(
                    children: [
                      const Icon(Icons.medication, size: 16, color: Color(0xFF00838F)),
                      const SizedBox(width: 8),
                      Expanded(child: Text(m['name'] ?? '', style: const TextStyle(fontSize: 13))),
                      Text('x${m['quantity'] ?? 1}', style: TextStyle(color: Colors.grey[600], fontSize: 12)),
                    ],
                  ),
                )),

                const SizedBox(height: 16),

                // Delivery type
                Row(
                  children: [
                    Expanded(
                      child: ChoiceChip(
                        label: const Text('🏠 Home Delivery'),
                        selected: deliveryType == 'delivery',
                        onSelected: (_) => setSheet(() => deliveryType = 'delivery'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: ChoiceChip(
                        label: const Text('🏥 Pickup'),
                        selected: deliveryType == 'pickup',
                        onSelected: (_) => setSheet(() => deliveryType = 'pickup'),
                      ),
                    ),
                  ],
                ),

                if (deliveryType == 'delivery') ...[
                  const SizedBox(height: 12),
                  TextField(
                    controller: addressCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Delivery Address',
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                    maxLines: 2,
                  ),
                ],

                const SizedBox(height: 12),
                TextField(
                  controller: phoneCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Contact Phone',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                  keyboardType: TextInputType.phone,
                ),

                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: ordering ? null : () async {
                      setSheet(() => ordering = true);
                      try {
                        final headers = await ApiConfig.authenticatedHeaders();
                        final resp = await http.post(
                          Uri.parse('${ApiConfig.baseUrl}/prescriptions/${rx['id']}/order-pharmacy'),
                          headers: headers,
                          body: jsonEncode({
                            'delivery_type': deliveryType,
                            if (deliveryType == 'delivery') 'delivery_address': addressCtrl.text.trim(),
                            'delivery_phone': phoneCtrl.text.trim(),
                          }),
                        ).timeout(const Duration(seconds: 15));
                        final data = jsonDecode(resp.body);
                        if (ctx.mounted) Navigator.pop(ctx);
                        if (data['success'] == true) {
                          final orderNum = data['data']?['order_number'] ?? '';
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text('✅ Order placed! $orderNum'),
                                backgroundColor: Colors.green,
                              ),
                            );
                            _fetchPrescriptions(); // refresh
                          }
                        } else {
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text(data['message'] ?? 'Failed to place order'),
                                backgroundColor: Colors.red,
                              ),
                            );
                          }
                        }
                      } catch (e) {
                        if (ctx.mounted) Navigator.pop(ctx);
                        if (mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text('Error: $e'), backgroundColor: Colors.red),
                          );
                        }
                      }
                    },
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF00838F),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    child: ordering
                        ? const SizedBox(width: 20, height: 20,
                            child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                        : const Text('Place Order', style: TextStyle(color: Colors.white)),
                  ),
                ),
              ],
            ),
          ),
        );
      }),
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
