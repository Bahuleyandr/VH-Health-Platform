import 'package:go_router/go_router.dart';

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/theme/theme_colors.dart';

class PharmacyScreen extends StatefulWidget {
  final String phone;
  const PharmacyScreen({super.key, required this.phone});

  @override
  State<PharmacyScreen> createState() => _PharmacyScreenState();
}

class _PharmacyScreenState extends State<PharmacyScreen> {
  final _formKey = GlobalKey<FormState>();
  final _addressController = TextEditingController();
  final _phoneController = TextEditingController();

  File? _file;
  String? _fileName;
  bool _isSubmitting = false;
  late final bool _isGuest;

  static const _pharmacyPhoneNumber = '+919999999999';

  @override
  void initState() {
    super.initState();
    _isGuest = widget.phone.toLowerCase() == 'guest' || widget.phone.trim().isEmpty;
    _phoneController.text = _isGuest ? '' : widget.phone;
  }

  @override
  void dispose() {
    _addressController.dispose();
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
        allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png'],
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
        content: Text(l10n.pharmacyFormAndFileRequired),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      return;
    }

    setState(() => _isSubmitting = true);
    String? fileKey;

    try {
      final req = http.MultipartRequest(
        'POST',
        Uri.parse('${ApiConfig.baseUrl}/uploads'),
      )
        ..headers['x-api-key'] = ApiConfig.apiKey
        ..files.add(await http.MultipartFile.fromPath('file', _file!.path, filename: _fileName));

      final res = await http.Response.fromStream(await req.send());
      if (res.statusCode == 200) {
        fileKey = jsonDecode(res.body)['key'];
        if (fileKey == null) throw Exception('key missing');
      } else {
        throw Exception('upload failed');
      }
    } catch (_) {
      messenger.showSnackBar(SnackBar(
        content: Text(l10n.pharmacyUploadFailed),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
      setState(() => _isSubmitting = false);
      return;
    }

    try {
      final apiRes = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/pharmacy'),
        headers: ApiConfig.jsonHeaders,
        body: jsonEncode({
          'phone': _phoneController.text.trim(),
          'order_note': _addressController.text.trim(),
          'file_key': fileKey,
        }),
      );

      if (apiRes.statusCode == 200) {
        messenger.showSnackBar(SnackBar(
          content: Text(l10n.pharmacyConfirmationNote),
          backgroundColor: theme.colorScheme.primary,
          behavior: SnackBarBehavior.floating,
        ));
        if (mounted) context.pop();
      } else {
        final msg = (jsonDecode(apiRes.body)['message'] ?? l10n.pharmacySubmissionFailed).toString();
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

  Future<void> _callPharmacy() async {
    final uri = Uri.parse('tel:$_pharmacyPhoneNumber');
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);

    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(l10n.pharmacyCallFailed),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ));
    }
  }

  Future<void> _triggerSOS() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(SnackBar(
      content: Text(l10n.authSosTriggered),
      backgroundColor: Theme.of(context).colorScheme.error,
      behavior: SnackBarBehavior.floating,
    ));
    await SOSService.triggerSOS();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final isDarkMode = theme.brightness == Brightness.dark;

    return FeatureScreenScaffold(
      title: l10n.pharmacyTitle,
      icon: Icons.local_pharmacy_outlined,
      color: FeatureScreenScaffold.featureColors['pharmacy']!,
      heroTag: 'pharmacy',
      floatingActionButton: FloatingActionButton(
        onPressed: _triggerSOS,
        tooltip: l10n.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.favorite_border_outlined),
      ),
      child: Form(
        key: _formKey,
        child: ListView(
          shrinkWrap: true,
          physics: const AlwaysScrollableScrollPhysics(), 
          children: [
            Container(
              padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
              decoration: BoxDecoration(
                color: cs.primaryContainer.withAlpha(
                  isDarkMode ? 102 : 178  // ✅ Fixed: Lower alpha in dark mode
                ),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                l10n.pharmacyInfoBanner,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: cs.onPrimaryContainer,
                  fontWeight: FontWeight.w500,
                ),
                textAlign: TextAlign.center,
              ),
            ),
            const SizedBox(height: 20),

            if (_isGuest) ...[
              TextFormField(
                controller: _phoneController,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(
                  labelText: l10n.pharmacyPhoneNumberLabel,
                  hintText: l10n.pharmacyPhoneNumberHint,
                  prefixIcon: Icon(Icons.phone_outlined, color: cs.primary),
                ),
                validator: (v) =>
                    v == null || v.trim().length != 10
                        ? l10n.pharmacyPhoneNumberValidationInvalid
                        : null,
              ),
              const SizedBox(height: 16),
            ],

            ElevatedButton.icon(
              onPressed: _isSubmitting ? null : _pickFile,
              icon: const Icon(Icons.upload_file_outlined),
              label: Text(
                _file == null
                    ? l10n.pharmacyUploadPrescriptionButton
                    : '${l10n.fileSelected}: $_fileName',
                overflow: TextOverflow.ellipsis,
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: cs.secondaryContainer,
                foregroundColor: cs.onSecondaryContainer,
              ),
            ),
            if (_fileName != null)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  icon: Icon(Icons.close, size: 16, color: cs.error),
                  label: Text(
                    l10n.fileClearSelection,
                    style: theme.textTheme.bodySmall?.copyWith(color: cs.error),
                  ),
                  onPressed: _isSubmitting
                      ? null
                      : () => setState(() {
                            _file = null;
                            _fileName = null;
                          }),
                ),
              ),
            const SizedBox(height: 16),

            TextFormField(
              controller: _addressController,
              minLines: 3,
              maxLines: 5,
              decoration: InputDecoration(
                labelText: l10n.pharmacyDeliveryAddressLabel,
                hintText: l10n.pharmacyDeliveryAddressHint,
                prefixIcon: Padding(
                  padding: const EdgeInsets.only(bottom: 40),
                  child: Icon(Icons.home_outlined, color: cs.primary),
                ),
                alignLabelWithHint: true,
              ),
              validator: (v) => v == null || v.trim().isEmpty
                  ? l10n.pharmacyDeliveryAddressValidationRequired
                  : null,
            ),
            const SizedBox(height: 24),

            ElevatedButton(
              onPressed: _isSubmitting ? null : _submit,
              child: _isSubmitting
                  ? const SizedBox(
                      height: 20,
                      width: 20,
                      child: CircularProgressIndicator(strokeWidth: 2.5),
                    )
                  : Text(l10n.pharmacySubmitOrderButton),
            ),
            const SizedBox(height: 16),

            Center(
              child: TextButton.icon(
                icon: Icon(Icons.call_outlined, color: cs.primary),
                label: Text(
                  l10n.pharmacyCallButton,
                  style: theme.textTheme.labelLarge?.copyWith(color: cs.primary),
                ),
                onPressed: _isSubmitting ? null : _callPharmacy,
              ),
            ),
          ],
        ),
      ),
    );
  }
}