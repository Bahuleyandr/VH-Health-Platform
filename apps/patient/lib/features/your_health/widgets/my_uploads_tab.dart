// My Uploads tab — self-contained widget with its own state and data fetching
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/your_health/widgets/patient_record_extraction_sheet.dart';
import 'package:vhhealth/features/your_health/widgets/record_card.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

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

class MyUploadsTab extends StatefulWidget {
  /// Called when the upload sheet visibility changes, so the parent can
  /// expose the upload FAB appropriately.
  final VoidCallback? onDataChanged;

  const MyUploadsTab({super.key, this.onDataChanged});

  @override
  State<MyUploadsTab> createState() => MyUploadsTabState();
}

class MyUploadsTabState extends State<MyUploadsTab> {
  List<Map<String, dynamic>> _myUploads = [];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _fetchRecords();
  }

  Future<void> _fetchRecords() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final response = await ApiClient.get('/appointments/patient/records/all');
      if (!mounted) return;

      if (response.isSuccess) {
        final data = response.dataAsMap();
        final uploadsRaw = (data['my_uploads'] as List?) ?? [];
        setState(() {
          _myUploads = uploadsRaw
              .map((j) => Map<String, dynamic>.from(j as Map))
              .toList();
          _isLoading = false;
        });
      } else {
        setState(() {
          _error = response.failureMessage('Failed to load records');
          _isLoading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _isLoading = false;
      });
    }
  }

  Future<void> _deleteUploadedRecord(Map<String, dynamic> record) async {
    final l = AppLocalizations.of(context)!;
    final id = record['id'];
    if (id == null) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.recordsDeleteTitle),
        content: Text(
          '${l.recordsDeletePrefix}"${record['title'] ?? 'this record'}"? This cannot be undone.',
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
        '/appointments/patient/records/$id',
      );
      if (response.isSuccess) {
        if (mounted) {
          setState(() => _myUploads.removeWhere((r) => r['id'] == id));
          ScaffoldMessenger.of(context).showSnackBar(
            LiveRegionSnackBar.build(
              message: l.recordsDeleted,
              backgroundColor: Colors.red,
            ),
          );
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            LiveRegionSnackBar.build(
              message: response.failureMessage('Failed to delete record'),
              backgroundColor: Colors.red,
            ),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(
            message: 'Error: $e',
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  void _openExtractionReview(Map<String, dynamic> record) {
    showDialog<void>(
      context: context,
      builder: (_) => PatientRecordExtractionSheet(
        record: record,
        onRecordUpdated: (updated) {
          if (!mounted) return;
          final id = updated['id'];
          setState(() {
            final index = _myUploads.indexWhere((item) => item['id'] == id);
            if (index >= 0) {
              _myUploads[index] = {..._myUploads[index], ...updated};
            }
          });
        },
      ),
    );
  }

  /// Show the upload bottom sheet. Called externally from the parent FAB.
  void showUploadSheet() {
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
          Future<void> upload() async {
            final lInner = AppLocalizations.of(ctx)!;
            if (pickedFilePath == null) {
              ScaffoldMessenger.of(ctx).showSnackBar(
                LiveRegionSnackBar.build(message: lInner.recordsPickFile),
              );
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
                final uploadedRecord = response.dataAsMap();
                if (ctx.mounted) Navigator.pop(ctx);
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    LiveRegionSnackBar.build(
                      message: lInner.recordsUploaded,
                      backgroundColor: Colors.green,
                    ),
                  );
                  _fetchRecords();
                  if (uploadedRecord.isNotEmpty) {
                    _openExtractionReview(uploadedRecord);
                  }
                }
              } else {
                throw Exception(response.failureMessage('Upload failed'));
              }
            } catch (e) {
              if (ctx.mounted) {
                ScaffoldMessenger.of(ctx).showSnackBar(
                  LiveRegionSnackBar.build(
                    message: 'Upload failed: $e',
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

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;

    if (_isLoading) {
      return Center(
        child: CircularProgressIndicator(
          valueColor: AlwaysStoppedAnimation(cs.primary),
        ),
      );
    }

    if (_error != null && _myUploads.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _error!,
              style: TextStyle(color: cs.error),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: _fetchRecords,
              child: Text(AppLocalizations.of(context)!.commonRetry),
            ),
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
              Text(
                AppLocalizations.of(context)!.recordsUploadEmptyHint,
                style: const TextStyle(color: Colors.grey),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 20),
              ElevatedButton.icon(
                onPressed: showUploadSheet,
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
            child: RecordCard(
              record: record,
              showSource: true,
              onTap: () => _openExtractionReview(record),
            ),
          );
        },
      ),
    );
  }
}
