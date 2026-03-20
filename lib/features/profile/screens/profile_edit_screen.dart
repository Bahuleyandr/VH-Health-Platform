// lib/features/profile/screens/profile_edit_screen.dart
import 'package:go_router/go_router.dart';

import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class ProfileEditScreen extends StatefulWidget {
  final String phone;
  final String name;

  const ProfileEditScreen({
    super.key,
    required this.phone,
    required this.name,
  });

  @override
  State<ProfileEditScreen> createState() => _ProfileEditScreenState();
}

class _ProfileEditScreenState extends State<ProfileEditScreen> {
  final _formKey = GlobalKey<FormState>();

  late final TextEditingController _nameController;
  final _emailController    = TextEditingController();
  final _birthdayController = TextEditingController();

  bool _isSubmitting = false;

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController(text: widget.name);
  }

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _birthdayController.dispose();
    super.dispose();
  }

  // ───────────────────────────────── Submit ─────────────────────────────────
  Future<void> _submit() async {
    final messenger = ScaffoldMessenger.of(context);
    final theme     = Theme.of(context);
    final l10n      = AppLocalizations.of(context)!;

    if (!_formKey.currentState!.validate()) return;

    setState(() => _isSubmitting = true);
    bool success = false;

    try {
      final res = await http.put(
        Uri.parse('${ApiConfig.baseUrl}/users/${widget.phone}'),
        headers: ApiConfig.jsonHeaders,
        body: jsonEncode({
          'name'    : _nameController.text.trim(),
          'email'   : _emailController.text.trim().isNotEmpty
              ? _emailController.text.trim()
              : null,
          'birthday': _birthdayController.text.trim().isNotEmpty
              ? _birthdayController.text.trim()
              : null,
        }),
      );
      success = res.statusCode == 200 || res.statusCode == 204;
      if (!success) debugPrint('API error: ${res.statusCode} – ${res.body}');
    } catch (e) {
      debugPrint('Network error: $e');
    }

    if (!mounted) return;

    messenger.showSnackBar(
      SnackBar(
        content: Text(success
            ? l10n.profileUpdatedSuccessfully
            : l10n.networkError),
        backgroundColor: success
            ? theme.colorScheme.primary
            : theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );

    if (success) context.pop();
    setState(() => _isSubmitting = false);
  }

  // ─────────────────────────────── Birthday picker ──────────────────────────
  Future<void> _selectBirthday(BuildContext context) async {
    final picked = await showDatePicker(
      context    : context,
      initialDate: DateTime.now(),
      firstDate  : DateTime(1900),
      lastDate   : DateTime.now(),
    );
    if (picked != null) {
      _birthdayController.text =
          MaterialLocalizations.of(context).formatMediumDate(picked);
      setState(() {});
    }
  }

  // ────────────────────────────────── SOS ───────────────────────────────────
  void _triggerSOS() {
    final messenger = ScaffoldMessenger.of(context);
    final theme     = Theme.of(context);
    final l10n      = AppLocalizations.of(context)!;

    messenger.showSnackBar(
      SnackBar(
        content: Text(l10n.authSosTriggered),   // ← switched key
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );

    debugPrint('SOS Triggered for phone: ${widget.phone}');
  }

  // ────────────────────────────────── UI ────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final theme  = Theme.of(context);
    final cs     = theme.colorScheme;
    final text   = theme.textTheme;
    final l10n   = AppLocalizations.of(context)!;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.profileEditScreenTitle)),
      body: LogoBackground(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Form(
              key: _formKey,
              child: ListView(
                shrinkWrap: true,
                physics: const AlwaysScrollableScrollPhysics(), 
                children: [
                  // Name
                  TextFormField(
                    controller: _nameController,
                    textCapitalization: TextCapitalization.words,
                    decoration: InputDecoration(
                      labelText : l10n.profileNameLabel,
                      hintText  : l10n.profileNameHint,
                      prefixIcon: Icon(Icons.person_outline, color: cs.primary),
                    ),
                    validator: (v) => (v == null || v.trim().isEmpty)
                        ? l10n.profileNameValidationRequired
                        : null,
                    style: text.bodyLarge,
                  ),
                  const SizedBox(height: 16),

                  // Email
                  TextFormField(
                    controller: _emailController,
                    keyboardType: TextInputType.emailAddress,
                    decoration: InputDecoration(
                      labelText : l10n.profileEmailLabel,
                      hintText  : l10n.profileEmailHint,
                      prefixIcon: Icon(Icons.email_outlined, color: cs.primary),
                    ),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty) return null;
                      final regex =
                          RegExp(r'^[\w\.-]+@([\w-]+\.)+[a-zA-Z]{2,}$');
                      return regex.hasMatch(v.trim())
                          ? null
                          : l10n.profileEmailValidationInvalid;
                    },
                    style: text.bodyLarge,
                  ),
                  const SizedBox(height: 16),

                  // Birthday
                  TextFormField(
                    controller: _birthdayController,
                    readOnly: true,
                    decoration: InputDecoration(
                      labelText : l10n.profileBirthdayLabel,
                      hintText  : l10n.profileBirthdayHint,
                      prefixIcon: Icon(Icons.calendar_today_outlined,
                          color: cs.primary),
                      suffixIcon: IconButton(
                        icon: Icon(Icons.edit_calendar_outlined,
                            color: cs.primary),
                        onPressed: () => _selectBirthday(context),
                      ),
                    ),
                    onTap: () => _selectBirthday(context),
                    style: text.bodyLarge,
                  ),
                  const SizedBox(height: 24),

                  // Save
                  ElevatedButton(
                    onPressed: _isSubmitting ? null : _submit,
                    child: _isSubmitting
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2.5),
                          )
                        : Padding(
                            padding: const EdgeInsets.symmetric(vertical: 12),
                            child: Text(l10n.profileSaveChangesButton,
                                style: text.labelLarge),
                          ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _isSubmitting ? null : _triggerSOS,
        tooltip: l10n.authSosTooltip,           // ← switched key
        child: const Icon(Icons.sos_outlined),
      ),
    );
  }
}
