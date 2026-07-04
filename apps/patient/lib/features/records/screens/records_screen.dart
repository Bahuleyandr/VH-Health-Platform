import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/document_opener.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

MediaType? _mediaTypeForFileName(String? fileName) {
  final ext = fileName?.split('.').last.toLowerCase();
  final mime = switch (ext) {
    'jpg' || 'jpeg' => 'image/jpeg',
    'png' => 'image/png',
    'pdf' => 'application/pdf',
    _ => null,
  };
  if (mime == null) return null;
  final parts = mime.split('/');
  return MediaType(parts.first, parts.last);
}

// ─── Model ───────────────────────────────────────────────────────────────────

class _RecordItem {
  final int id;
  final String source; // 'appointment' | 'patient_upload'
  final String documentType;
  final String title;
  final String? doctorName;
  final String? department;
  final String? fileUrl;
  final String? fileName;
  final String? appointmentDate;
  final String? sourceHospital;
  final String? createdAt;

  const _RecordItem({
    required this.id,
    required this.source,
    required this.documentType,
    required this.title,
    this.doctorName,
    this.department,
    this.fileUrl,
    this.fileName,
    this.appointmentDate,
    this.sourceHospital,
    this.createdAt,
  });

  factory _RecordItem.fromJson(Map<String, dynamic> j, String source) {
    return _RecordItem(
      id: j['id'] ?? 0,
      source: source,
      documentType: j['document_type'] ?? 'other',
      title:
          j['title'] ??
          j['document_type']?.toString().replaceAll('_', ' ').toUpperCase() ??
          'Document',
      doctorName: j['doctor_name'],
      department: j['doctor_department'] ?? j['department'],
      fileUrl: j['file_url'],
      fileName: j['file_name'],
      appointmentDate: j['appointment_date']?.toString().split('T').first,
      sourceHospital: j['source_hospital'],
      createdAt: j['created_at']?.toString().split('T').first,
    );
  }
}

// ─── Screen ──────────────────────────────────────────────────────────────────

class RecordsScreen extends StatefulWidget {
  const RecordsScreen({super.key});

  @override
  State<RecordsScreen> createState() => _RecordsScreenState();
}

class _RecordsScreenState extends State<RecordsScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  // ignore: unused_field
  static final _storage = VHSecureStorage.instance;

  List<_RecordItem> _hospitalRecords = [];
  List<_RecordItem> _myUploads = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _fetchRecords();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _fetchRecords() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/appointments/patient/records/all');
      if (!mounted) return;
      if (response.isSuccess) {
        final data = response.dataAsMap();
        final hospitalRaw = (data['hospital_records'] as List?) ?? [];
        final uploadsRaw = (data['my_uploads'] as List?) ?? [];
        setState(() {
          _hospitalRecords = hospitalRaw
              .map(
                (j) => _RecordItem.fromJson(
                  j as Map<String, dynamic>,
                  'appointment',
                ),
              )
              .toList();
          _myUploads = uploadsRaw
              .map(
                (j) => _RecordItem.fromJson(
                  j as Map<String, dynamic>,
                  'patient_upload',
                ),
              )
              .toList();
        });
      } else {
        setState(() => _error = response.message ?? 'Failed to load records');
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openDocument(_RecordItem record) async {
    final l = AppLocalizations.of(context)!;
    final url = record.fileUrl;
    if (url == null || url.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l.recordsDocumentUrlMissing)));
      return;
    }
    await DocumentOpener.openFromUrl(
      context,
      url,
      filename: record.fileName ?? 'document',
    );
  }

  Future<void> _deleteRecord(_RecordItem record) async {
    final l = AppLocalizations.of(context)!;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.recordsDeleteTitle),
        content: Text(
          '${l.recordsDeletePrefix}"${record.title}"? This cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l.commonCancelButton),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red,
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      final response = await ApiClient.delete(
        '/appointments/patient/records/${record.id}',
      );
      if (response.isSuccess) {
        if (mounted) {
          setState(() => _myUploads.removeWhere((r) => r.id == record.id));
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(l.recordsDeleted),
              backgroundColor: Colors.red,
            ),
          );
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(response.message ?? 'Failed to delete record'),
              backgroundColor: Colors.red,
            ),
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
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) {
          final lInner = AppLocalizations.of(ctx)!;

          Future<void> upload() async {
            if (pickedFilePath == null) {
              ScaffoldMessenger.of(
                ctx,
              ).showSnackBar(SnackBar(content: Text(lInner.recordsPickFile)));
              return;
            }
            setSheet(() => uploading = true);
            try {
              final fields = <String, String>{'document_type': docType};
              final title = titleCtrl.text.trim();
              if (title.isNotEmpty) fields['title'] = title;
              if (hospitalCtrl.text.trim().isNotEmpty) {
                fields['source_hospital'] = hospitalCtrl.text.trim();
              }
              if (recordDate != null) {
                fields['record_date'] =
                    '${recordDate!.year}-${recordDate!.month.toString().padLeft(2, '0')}-${recordDate!.day.toString().padLeft(2, '0')}';
              }
              final response = await ApiClient.multipart(
                '/appointments/patient/records/upload',
                fields: fields,
                files: [
                  await http.MultipartFile.fromPath(
                    'file',
                    pickedFilePath!,
                    filename: pickedFileName,
                    contentType: _mediaTypeForFileName(pickedFileName),
                  ),
                ],
              );
              if (response.isSuccess) {
                if (ctx.mounted) Navigator.pop(ctx);
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(lInner.recordsUploaded),
                      backgroundColor: Colors.green,
                    ),
                  );
                  _fetchRecords();
                }
              } else {
                throw Exception(response.message ?? 'Upload failed');
              }
            } catch (e) {
              if (ctx.mounted) {
                ScaffoldMessenger.of(ctx).showSnackBar(
                  SnackBar(
                    content: Text('Upload failed: $e'),
                    backgroundColor: Colors.red,
                  ),
                );
              }
            } finally {
              if (ctx.mounted) setSheet(() => uploading = false);
            }
          }

          return Padding(
            padding: EdgeInsets.only(
              left: 20,
              right: 20,
              top: 20,
              bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
            ),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    AppLocalizations.of(ctx)!.recordsUploadButton,
                    style: Theme.of(ctx).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: titleCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Title (optional)',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: docType,
                    decoration: const InputDecoration(
                      labelText: 'Document Type',
                      border: OutlineInputBorder(),
                    ),
                    items: docTypes
                        .map(
                          (t) =>
                              DropdownMenuItem(value: t.$1, child: Text(t.$2)),
                        )
                        .toList(),
                    onChanged: (v) => setSheet(() => docType = v ?? docType),
                  ),
                  if (docType == 'discharge_summary') ...[
                    const SizedBox(height: 10),
                    Card(
                      child: ListTile(
                        leading: const Icon(Icons.assignment_returned_outlined),
                        title: Text(lInner.dischargeSummariesTitle),
                        subtitle: Text(lInner.dischargeSummariesOfficialHint),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () {
                          Navigator.pop(ctx);
                          context.push('/portal/discharge-summaries');
                        },
                      ),
                    ),
                  ],
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
                    label: Text(
                      recordDate == null
                          ? 'Document Date (optional)'
                          : '${recordDate!.day}/${recordDate!.month}/${recordDate!.year}',
                    ),
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
                      final result = await FilePicker.pickFiles(
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
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('Upload'),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    ).whenComplete(() {
      titleCtrl.dispose();
      hospitalCtrl.dispose();
    });
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: 'My Records',
      icon: Icons.folder_outlined,
      color: colors.primary,
      heroTag: 'records',
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showUploadSheet,
        icon: const Icon(Icons.upload_file),
        label: const Text('Upload'),
      ),
      child: DataStateBuilder<_RecordItem>(
        isLoading: _loading,
        error: _error,
        data: [..._hospitalRecords, ..._myUploads],
        onRetry: _fetchRecords,
        emptyIcon: Icons.folder_outlined,
        emptyTitle: 'No records yet',
        emptySubtitle: 'Your hospital records and uploads will appear here',
        builder: (context, _) => Column(
          children: [
            TabBar(
              controller: _tabController,
              tabs: [
                Tab(text: 'Hospital Records (${_hospitalRecords.length})'),
                Tab(text: 'My Uploads (${_myUploads.length})'),
              ],
            ),
            Expanded(
              child: TabBarView(
                controller: _tabController,
                children: [_buildHospitalRecords(), _buildMyUploads()],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHospitalRecords() {
    final theme = Theme.of(context);
    if (_hospitalRecords.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                Icons.local_hospital_outlined,
                size: 64,
                color: theme.colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: 12),
              Text(
                AppLocalizations.of(context)!.recordsHospitalEmpty,
                style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _fetchRecords,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _hospitalRecords.length,
        itemBuilder: (ctx, i) => _RecordCard(
          record: _hospitalRecords[i],
          onTap: () => _openDocument(_hospitalRecords[i]),
        ),
      ),
    );
  }

  Widget _buildMyUploads() {
    final theme = Theme.of(context);
    if (_myUploads.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                Icons.folder_open,
                size: 64,
                color: theme.colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: 12),
              Text(
                AppLocalizations.of(context)!.recordsUploadEmptyHint,
                style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 20),
              ElevatedButton.icon(
                onPressed: _showUploadSheet,
                icon: const Icon(Icons.upload_file),
                label: Text(
                  AppLocalizations.of(context)!.recordsUploadSheetTitle,
                ),
              ),
            ],
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _fetchRecords,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _myUploads.length,
        itemBuilder: (ctx, i) {
          final record = _myUploads[i];
          return Dismissible(
            key: Key('record_${record.id}'),
            direction: DismissDirection.endToStart,
            background: Container(
              alignment: Alignment.centerRight,
              padding: const EdgeInsets.only(right: 20),
              color: Colors.red,
              child: const Icon(Icons.delete, color: Colors.white),
            ),
            confirmDismiss: (_) async {
              await _deleteRecord(record);
              return false; // We manually update state
            },
            child: _RecordCard(
              record: record,
              onTap: () => _openDocument(record),
              showSource: true,
            ),
          );
        },
      ),
    );
  }
}

// ─── Record Card ─────────────────────────────────────────────────────────────

class _RecordCard extends StatelessWidget {
  final _RecordItem record;
  final VoidCallback onTap;
  final bool showSource;

  const _RecordCard({
    required this.record,
    required this.onTap,
    this.showSource = false,
  });

  IconData _iconForType(String type) {
    switch (type) {
      case 'prescription':
        return Icons.medical_services;
      case 'lab_report':
        return Icons.science;
      case 'radiology':
        return Icons.image_search;
      case 'vaccination':
        return Icons.vaccines;
      case 'insurance':
        return Icons.shield;
      case 'discharge_summary':
        return Icons.assignment_returned;
      default:
        return Icons.description;
    }
  }

  Color _colorForType(String type) {
    switch (type) {
      case 'prescription':
        return Colors.blue;
      case 'lab_report':
        return Colors.purple;
      case 'radiology':
        return Colors.indigo;
      case 'vaccination':
        return Colors.green;
      case 'insurance':
        return Colors.teal;
      case 'discharge_summary':
        return Colors.orange;
      default:
        return Colors.blueGrey;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final typeColor = _colorForType(record.documentType);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: typeColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(
                  _iconForType(record.documentType),
                  color: typeColor,
                  size: 24,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      record.title,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    if (record.doctorName != null)
                      Text(
                        '${record.doctorName}${record.department != null ? ' • ${record.department}' : ''}',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    if (record.sourceHospital != null)
                      Text(
                        record.sourceHospital!,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: typeColor.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            record.documentType
                                .replaceAll('_', ' ')
                                .toUpperCase(),
                            style: TextStyle(
                              color: typeColor,
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        if (record.appointmentDate != null) ...[
                          const SizedBox(width: 8),
                          Text(
                            record.appointmentDate!,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ] else if (record.createdAt != null) ...[
                          const SizedBox(width: 8),
                          Text(
                            record.createdAt!,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(
                record.fileUrl != null ? Icons.open_in_new : Icons.lock,
                size: 18,
                color: record.fileUrl != null
                    ? typeColor
                    : theme.colorScheme.onSurfaceVariant,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
