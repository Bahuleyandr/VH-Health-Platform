import 'package:go_router/go_router.dart';

import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class InvestigationsScreen extends StatefulWidget {
  final String phone;
  const InvestigationsScreen({super.key, required this.phone});

  @override
  State<InvestigationsScreen> createState() => _InvestigationsScreenState();
}

class _InvestigationsScreenState extends State<InvestigationsScreen> {
  final _formKey = GlobalKey<FormState>();
  final _testNameController = TextEditingController();
  final _phoneController = TextEditingController();

  File? _file;
  String? _fileName;
  bool _isSubmitting = false;
  late final bool _isGuest;

  @override
  void initState() {
    super.initState();
    _isGuest = widget.phone.toLowerCase() == 'guest' || widget.phone.trim().isEmpty;
    _phoneController.text = _isGuest ? '' : widget.phone;
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
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.pharmacyPermissionsRequired),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }

    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['pdf', 'doc', 'docx', 'jpg', 'png'],
      );
      if (result?.files.single.path != null) {
        setState(() {
          _file = File(result!.files.single.path!);
          _fileName = result.files.single.name;
        });
      }
    } catch (_) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.pharmacyFilePickerError),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final messenger = ScaffoldMessenger.of(context);

    if (!_formKey.currentState!.validate() || _file == null) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.investigationsFormAndFileRequired),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }

    setState(() => _isSubmitting = true);
    String? fileKey;

    try {
      final uploadHeaders = await ApiConfig.authenticatedAuthHeaders();
      final req = http.MultipartRequest(
        'POST',
        Uri.parse('${ApiConfig.baseUrl}/upload'),
      )
        ..headers.addAll(uploadHeaders)
        ..files.add(await http.MultipartFile.fromPath('file', _file!.path, filename: _fileName));

      final res = await http.Response.fromStream(await req.send());
      if (res.statusCode == 200) {
        final decoded = jsonDecode(res.body);
        fileKey = decoded['data']?['storageKey'] ?? decoded['storageKey'];
        if (fileKey == null) throw Exception('Key missing');
      } else {
        throw Exception('Upload failed');
      }
    } catch (_) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.investigationsUploadFailed),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      setState(() => _isSubmitting = false);
      return;
    }

    try {
      final apiRes = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/investigations'),
        headers: await ApiConfig.authenticatedHeaders(),
        body: jsonEncode({
          'phone': _phoneController.text.trim(),
          'test_name': _testNameController.text.trim(),
          'file_key': fileKey,
        }),
      );

      if (apiRes.statusCode == 200) {
        messenger.showSnackBar(SnackBar(
          content: Text(l10n.investigationsConfirmationNote),
          backgroundColor: theme.colorScheme.primary,
          behavior: SnackBarBehavior.floating,
        ));
        if (mounted) context.pop();
      } else {
        final msg = (jsonDecode(apiRes.body)['message'] ?? l10n.investigationsFailed).toString();
        messenger.showSnackBar(SnackBar(
          content: Text(msg),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ));
      }
    } catch (_) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.networkError),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  void _viewReports() {
    context.push('/health', extra: {
  'defaultFilter': 'Investigation',
});
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final color = FeatureScreenScaffold.featureColors['investigations']!;
    return FeatureScreenScaffold(
      title: l10n.investigationsTitle,
      icon: Icons.science_outlined,
      color: color,
      heroTag: 'investigations',
      child: Form(
        key: _formKey,
        child: ListView(
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
                validator: (v) =>
                    v == null || v.trim().length != 10
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
              validator: (v) =>
                  v == null || v.trim().isEmpty
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
            const SizedBox(height: 16),
            if (!_isGuest)
              Center(
                child: TextButton(
                  onPressed: _isSubmitting ? null : _viewReports,
                  child: Text(
                    l10n.investigationsViewReportsButton,
                    style: Theme.of(context).textTheme.labelLarge?.copyWith(
                          color: Theme.of(context).colorScheme.primary,
                        ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
