// "Upload" tab of InvestigationsScreen — pick a report file and submit an
// investigation record. Extracted as its own StatefulWidget; on a
// successful upload it calls [onUploaded] so the screen can refresh the
// results tab.
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class InvestigationUploadTab extends StatefulWidget {
  /// Invoked after a successful upload so the parent can refresh the
  /// results tab.
  final VoidCallback onUploaded;

  const InvestigationUploadTab({super.key, required this.onUploaded});

  @override
  State<InvestigationUploadTab> createState() => _InvestigationUploadTabState();
}

class _InvestigationUploadTabState extends State<InvestigationUploadTab> {
  final _formKey = GlobalKey<FormState>();
  final _testNameController = TextEditingController();
  final _phoneController = TextEditingController();

  File? _file;
  String? _fileName;
  bool _isSubmitting = false;

  late final bool _isGuest;

  MediaType? _contentTypeForUpload(String path, String? fileName) {
    final name = (fileName?.isNotEmpty == true ? fileName! : path)
        .toLowerCase();
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
      return MediaType('image', 'jpeg');
    }
    if (name.endsWith('.png')) return MediaType('image', 'png');
    if (name.endsWith('.pdf')) return MediaType('application', 'pdf');
    if (name.endsWith('.doc')) return MediaType('application', 'msword');
    if (name.endsWith('.docx')) {
      return MediaType(
        'application',
        'vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    }
    return null;
  }

  @override
  void initState() {
    super.initState();
    final phone = context.read<UserProvider>().phone;
    _isGuest = phone.toLowerCase() == 'guest' || phone.trim().isEmpty;
    _phoneController.text = _isGuest ? '' : phone;
  }

  @override
  void dispose() {
    _testNameController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

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
            contentType: _contentTypeForUpload(_file!.path, _fileName),
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
        // Hand back to the parent so it can refresh the results tab.
        widget.onUploaded();
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

  @override
  Widget build(BuildContext context) {
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
}
