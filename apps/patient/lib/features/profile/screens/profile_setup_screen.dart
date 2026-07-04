import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import 'dart:io';
import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:image_picker/image_picker.dart';
import 'package:vhhealth/core/offline/patient_cache_invalidation.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/services/backend_api_service.dart';
import 'package:vhhealth/core/services/push_notification_service.dart';
import 'package:vhhealth/core/utils/input_sanitizer.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class ProfileSetupScreen extends StatefulWidget {
  final String phone;

  const ProfileSetupScreen({super.key, required this.phone});

  @override
  State<ProfileSetupScreen> createState() => _ProfileSetupScreenState();
}

class _ProfileSetupScreenState extends State<ProfileSetupScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _emailController = TextEditingController();

  String? _gender;
  DateTime? _birthday;
  DateTime? _anniversary;
  File? _photo;
  bool _isSubmitting = false;

  final _picker = ImagePicker();

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    super.dispose();
  }

  Future<void> _pickDate({required bool isBirthday}) async {
    final picked = await showDatePicker(
      context: context,
      initialDate: isBirthday
          ? (_birthday ?? DateTime(1990))
          : (_anniversary ??
                DateTime.now().subtract(const Duration(days: 365))),
      firstDate: isBirthday ? DateTime(1900) : DateTime(1950),
      lastDate: DateTime.now(),
    );
    if (picked != null && mounted) {
      setState(() => isBirthday ? _birthday = picked : _anniversary = picked);
    }
  }

  Future<void> _pickPhoto() async {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);

    try {
      final picked = await _picker.pickImage(
        source: ImageSource.gallery,
        imageQuality: 80,
        maxWidth: 1200,
        maxHeight: 1200,
      );
      if (picked != null && mounted) setState(() => _photo = File(picked.path));
    } catch (e) {
      debugPrint('Photo pick failed: $e');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(l10n.filesPickerError),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);

    if (!_formKey.currentState!.validate()) return;
    setState(() => _isSubmitting = true);

    final data = {
      'name': InputSanitizer.sanitizeName(_nameController.text.trim()),
      'gender': _gender,
      'email': _emailController.text.trim().isNotEmpty
          ? _emailController.text.trim()
          : null,
      'birthday': _birthday?.toIso8601String().split('T').first,
      'anniversary': _anniversary?.toIso8601String().split('T').first,
      'phone': widget.phone,
    };

    bool success = false;
    try {
      success = await BackendApiService.saveUserProfile(data);
    } catch (e) {
      debugPrint('Error saving profile: $e');
    }

    if (!mounted) return;
    if (success) {
      await PatientCacheInvalidation.afterProfileMutation();
      if (!mounted) return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          success ? l10n.profileSetupSaved : l10n.profileSetupSaveFailed,
        ),
        backgroundColor: success
            ? theme.colorScheme.primary
            : theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );

    if (success) {
      final storage = VHSecureStorage.instance;
      await storage.write(key: 'user_name', value: _nameController.text.trim());
      await storage.write(key: 'isNewUser', value: 'false');
      final hospitalNumber = await storage.read(key: 'hospital_number') ?? '';
      if (mounted) {
        await context.read<UserProvider>().setUser(
          widget.phone,
          _nameController.text.trim(),
          hospitalNumber: hospitalNumber.isEmpty ? null : hospitalNumber,
        );
        if (!mounted) return;
        await PushNotificationService.syncForSignedInUser(
          phone: widget.phone,
          notificationProvider: context.read<NotificationProvider>(),
        );
        if (!mounted) return;
        context.go('/home');
      }
    }
    if (mounted) setState(() => _isSubmitting = false);
  }

  Future<void> _skip() async {
    final storage = VHSecureStorage.instance;
    final hospitalNumber = await storage.read(key: 'hospital_number') ?? '';
    if (!mounted) return;
    await context.read<UserProvider>().setUser(
      widget.phone,
      'User',
      hospitalNumber: hospitalNumber.isEmpty ? null : hospitalNumber,
    );
    if (!mounted) return;
    await PushNotificationService.syncForSignedInUser(
      phone: widget.phone,
      notificationProvider: context.read<NotificationProvider>(),
    );
    if (!mounted) return;
    context.go('/home');
  }

  String _formatDate(DateTime? date) => date == null
      ? ''
      : MaterialLocalizations.of(context).formatFullDate(date);

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.profileSetupTitle)),
      body: LogoBackground(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16.0),
            child: SingleChildScrollView(
              child: Form(
                key: _formKey,
                child: Column(
                  children: [
                    // Avatar
                    GestureDetector(
                      onTap: _isSubmitting ? null : _pickPhoto,
                      child: CircleAvatar(
                        radius: 60,
                        backgroundColor: colorScheme.surfaceContainerHighest,
                        backgroundImage: _photo != null
                            ? FileImage(_photo!)
                            : null,
                        child: _photo == null
                            ? Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Icon(
                                    Icons.camera_alt_outlined,
                                    size: 40,
                                    color: colorScheme.onSurfaceVariant,
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    l10n.profileUploadProfilePic,
                                    style: textTheme.bodySmall?.copyWith(
                                      color: colorScheme.onSurfaceVariant,
                                    ),
                                  ),
                                ],
                              )
                            : null,
                      ),
                    ),
                    const SizedBox(height: 24),

                    // Name
                    TextFormField(
                      controller: _nameController,
                      textCapitalization: TextCapitalization.words,
                      decoration: InputDecoration(
                        labelText: l10n.profileNameLabel,
                        hintText: l10n.profileNameHint,
                        prefixIcon: Icon(
                          Icons.person_outline,
                          color: colorScheme.primary,
                        ),
                      ),
                      validator: (v) => v == null || v.trim().isEmpty
                          ? l10n.profileNameValidationRequired
                          : null,
                      style: textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 16),

                    // Gender
                    DropdownButtonFormField<String>(
                      initialValue: _gender,
                      items: [
                        DropdownMenuItem(
                          value: 'MALE',
                          child: Text(l10n.profileGenderMale),
                        ),
                        DropdownMenuItem(
                          value: 'FEMALE',
                          child: Text(l10n.profileGenderFemale),
                        ),
                        DropdownMenuItem(
                          value: 'OTHER',
                          child: Text(l10n.profileGenderOther),
                        ),
                      ],
                      onChanged: _isSubmitting
                          ? null
                          : (val) => setState(() => _gender = val),
                      decoration: InputDecoration(
                        labelText: l10n.profileGenderLabel,
                        prefixIcon: Icon(
                          Icons.wc_outlined,
                          color: colorScheme.primary,
                        ),
                      ),
                      validator: (v) => v == null
                          ? l10n.profileGenderValidationRequired
                          : null,
                      style: textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 16),

                    // Email
                    TextFormField(
                      controller: _emailController,
                      keyboardType: TextInputType.emailAddress,
                      decoration: InputDecoration(
                        labelText: l10n.profileEmailLabel,
                        hintText: l10n.profileEmailHintOptional,
                        prefixIcon: Icon(
                          Icons.email_outlined,
                          color: colorScheme.primary,
                        ),
                      ),
                      validator: (v) {
                        if (v == null || v.trim().isEmpty) return null;
                        final pattern = r'^[\w\.-]+@([\w-]+\.)+[a-zA-Z]{2,}$';
                        return RegExp(pattern).hasMatch(v.trim())
                            ? null
                            : l10n.profileEmailValidationInvalid;
                      },
                      style: textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 16),

                    // Birthday picker
                    _DateTile(
                      label: _birthday == null
                          ? l10n.profileBirthdaySelectLabel
                          : '${l10n.profileBirthdayLabelShort}: ${_formatDate(_birthday)}',
                      icon: Icons.calendar_today_outlined,
                      onTap: _isSubmitting
                          ? null
                          : () => _pickDate(isBirthday: true),
                    ),
                    const SizedBox(height: 12),

                    // Anniversary picker
                    _DateTile(
                      label: _anniversary == null
                          ? l10n.profileAnniversarySelectLabel
                          : '${l10n.profileAnniversaryLabelShort}: ${_formatDate(_anniversary)}',
                      icon: Icons.cake_outlined,
                      onTap: _isSubmitting
                          ? null
                          : () => _pickDate(isBirthday: false),
                    ),
                    const SizedBox(height: 32),

                    // Buttons
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            onPressed: _isSubmitting ? null : _skip,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              child: Text(
                                l10n.commonSkipButton,
                                style: textTheme.labelLarge,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: ElevatedButton(
                            onPressed: _isSubmitting ? null : _submit,
                            child: _isSubmitting
                                ? const SizedBox(
                                    width: 20,
                                    height: 20,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2.5,
                                    ),
                                  )
                                : Padding(
                                    padding: const EdgeInsets.symmetric(
                                      vertical: 12,
                                    ),
                                    child: Text(
                                      l10n.commonSubmitButton,
                                      style: textTheme.labelLarge,
                                    ),
                                  ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Small helper widget for the two date pickers.
class _DateTile extends StatelessWidget {
  final String label;
  final IconData icon;
  final VoidCallback? onTap;

  const _DateTile({required this.label, required this.icon, this.onTap});

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon, color: colorScheme.primary),
      title: Text(label, style: textTheme.bodyLarge),
      trailing: Icon(Icons.arrow_drop_down, color: colorScheme.primary),
      onTap: onTap,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(
          color: colorScheme.outline.withAlpha((255 * 0.5).round()),
        ), // Corrected line
      ),
      tileColor: colorScheme.surface.withAlpha(
        (255 * 0.5).round(),
      ), // Corrected line
    );
  }
}
