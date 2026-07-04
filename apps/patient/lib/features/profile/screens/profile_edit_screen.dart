// lib/features/profile/screens/profile_edit_screen.dart
import 'package:go_router/go_router.dart';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/offline/patient_cache_invalidation.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/input_sanitizer.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class ProfileEditScreen extends StatefulWidget {
  const ProfileEditScreen({super.key});

  @override
  State<ProfileEditScreen> createState() => _ProfileEditScreenState();
}

class _ProfileEditScreenState extends State<ProfileEditScreen> {
  final _formKey = GlobalKey<FormState>();

  late final String _phone;
  late final String _name;

  late final TextEditingController _nameController;
  final _emailController = TextEditingController();
  final _birthdayController = TextEditingController();
  final _addressController = TextEditingController();
  final _allergiesController = TextEditingController();
  final _emergencyContactController = TextEditingController();
  final _insuranceController = TextEditingController();
  final _preferredHospitalController = TextEditingController();

  DateTime? _selectedBirthday;
  String? _selectedGender;
  String? _selectedBloodGroup;
  bool _isSubmitting = false;
  bool _isLoading = true;

  static const _genderOptions = ['MALE', 'FEMALE', 'OTHER'];
  static const _bloodGroupOptions = [
    'A+',
    'A-',
    'B+',
    'B-',
    'O+',
    'O-',
    'AB+',
    'AB-',
  ];

  @override
  void initState() {
    super.initState();
    final user = context.read<UserProvider>();
    _phone = user.phone;
    _name = user.name;
    _nameController = TextEditingController(text: _name);
    _fetchProfile();
  }

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _birthdayController.dispose();
    _addressController.dispose();
    _allergiesController.dispose();
    _emergencyContactController.dispose();
    _insuranceController.dispose();
    _preferredHospitalController.dispose();
    super.dispose();
  }

  // ───────────────────────────── Fetch Profile ──────────────────────────────
  Future<void> _fetchProfile() async {
    try {
      final response = await ApiClient.get('/users/$_phone');

      if (!mounted) return;

      if (response.isSuccess) {
        final data = response.dataAsMap();
        final user = data['user'] as Map<String, dynamic>? ?? data;

        _nameController.text = user['name']?.toString() ?? _name;
        _emailController.text = user['email']?.toString() ?? '';
        _addressController.text = user['address']?.toString() ?? '';
        _allergiesController.text = user['allergies']?.toString() ?? '';
        _insuranceController.text = user['insurance_details']?.toString() ?? '';
        _preferredHospitalController.text =
            user['preferred_hospital']?.toString() ?? '';

        // Emergency contact can be a string or JSON object
        final ec = user['emergency_contact'];
        if (ec is Map) {
          final ecName = ec['name'] ?? '';
          final ecPhone = ec['phone'] ?? '';
          _emergencyContactController.text = ecName.isNotEmpty
              ? '$ecName: $ecPhone'
              : ecPhone.toString();
        } else if (ec != null) {
          _emergencyContactController.text = ec.toString();
        }

        // Gender
        final gender = user['gender']?.toString().toUpperCase();
        if (gender != null && _genderOptions.contains(gender)) {
          _selectedGender = gender;
        }

        // Blood group
        final bg = user['blood_group']?.toString();
        if (bg != null && _bloodGroupOptions.contains(bg)) {
          _selectedBloodGroup = bg;
        }

        // Birthday
        if (user['birthday'] != null) {
          try {
            _selectedBirthday = DateTime.parse(user['birthday'].toString());
            if (mounted) {
              _birthdayController.text = MaterialLocalizations.of(
                context,
              ).formatMediumDate(_selectedBirthday!);
            }
          } catch (e) {
            debugPrint('Birthday parse failed: $e');
          }
        }
      }
    } catch (e) {
      debugPrint('Error fetching profile: $e');
    }

    if (mounted) setState(() => _isLoading = false);
  }

  // ───────────────────────────────── Submit ─────────────────────────────────
  Future<void> _submit() async {
    if (_isSubmitting) return;

    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;

    if (!_formKey.currentState!.validate()) return;

    setState(() => _isSubmitting = true);
    bool success = false;
    String? errorMessage;

    try {
      // Build emergency_contact as string (backend accepts string or object)
      final ecText = _emergencyContactController.text.trim();

      final response = await ApiClient.put(
        '/users/$_phone',
        body: {
          'name': InputSanitizer.sanitizeName(_nameController.text.trim()),
          'email': _emailController.text.trim().isNotEmpty
              ? _emailController.text.trim()
              : null,
          'birthday': _selectedBirthday != null
              ? '${_selectedBirthday!.year.toString().padLeft(4, '0')}-${_selectedBirthday!.month.toString().padLeft(2, '0')}-${_selectedBirthday!.day.toString().padLeft(2, '0')}'
              : null,
          'gender': _selectedGender,
          'blood_group': _selectedBloodGroup,
          'address': _addressController.text.trim().isNotEmpty
              ? InputSanitizer.sanitize(_addressController.text.trim())
              : null,
          'allergies': _allergiesController.text.trim().isNotEmpty
              ? InputSanitizer.sanitize(_allergiesController.text.trim())
              : null,
          'emergency_contact': ecText.isNotEmpty
              ? InputSanitizer.sanitize(ecText)
              : null,
          'insurance_details': _insuranceController.text.trim().isNotEmpty
              ? InputSanitizer.sanitize(_insuranceController.text.trim())
              : null,
          'preferred_hospital':
              _preferredHospitalController.text.trim().isNotEmpty
              ? InputSanitizer.sanitize(
                  _preferredHospitalController.text.trim(),
                )
              : null,
        },
      );
      success = response.isSuccess;
      if (!success) {
        errorMessage =
            _profileUpdateErrorMessage(response) ?? l10n.networkError;
        debugPrint('API error: ${response.statusCode} – ${response.message}');
      }
    } catch (e) {
      errorMessage = l10n.networkError;
      debugPrint('Network error: $e');
    }

    if (!mounted) return;
    if (success) {
      await PatientCacheInvalidation.afterProfileMutation();
      if (!mounted) return;
    }

    messenger.showSnackBar(
      SnackBar(
        content: Text(
          success
              ? l10n.profileUpdatedSuccessfully
              : (errorMessage ?? l10n.networkError),
        ),
        backgroundColor: success
            ? theme.colorScheme.primary
            : theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );

    if (success) {
      context.pop(true);
      return;
    }
    setState(() => _isSubmitting = false);
  }

  String? _profileUpdateErrorMessage(ApiResponse response) {
    final raw = response.raw;
    if (raw is Map) {
      final errors = raw['errors'];
      if (errors is List && errors.isNotEmpty) {
        final messages = <String>[];
        for (final error in errors) {
          if (error is Map) {
            final message = error['msg']?.toString().trim();
            if (message != null && message.isNotEmpty) {
              messages.add(message);
            }
          }
        }
        if (messages.isNotEmpty) {
          return messages.take(2).join('\n');
        }
      }
    }

    final message = response.message?.trim();
    return message == null || message.isEmpty ? null : message;
  }

  // ─────────────────────────────── Birthday picker ──────────────────────────
  Future<void> _selectBirthday(BuildContext context) async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _selectedBirthday ?? DateTime.now(),
      firstDate: DateTime(1900),
      lastDate: DateTime.now(),
    );
    if (picked != null) {
      _selectedBirthday = picked;
      _birthdayController.text =
          // ignore: use_build_context_synchronously
          MaterialLocalizations.of(context).formatMediumDate(picked);
      setState(() {});
    }
  }

  // ────────────────────────────────── SOS ───────────────────────────────────
  void _triggerSOS() {
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;

    messenger.showSnackBar(
      SnackBar(
        content: Text(l10n.authSosTriggered),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );

    debugPrint('SOS Triggered for phone: $_phone');
  }

  // ─────────────────────────── Gender display label ─────────────────────────
  String _genderLabel(String value) {
    switch (value) {
      case 'MALE':
        return 'Male';
      case 'FEMALE':
        return 'Female';
      case 'OTHER':
        return 'Other';
      default:
        return value;
    }
  }

  // ────────────────────────────────── UI ────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final text = theme.textTheme;
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.profileEditScreenTitle)),
      body: LogoBackground(
        child: SafeArea(
          child: _isLoading
              ? Center(
                  child: CircularProgressIndicator(
                    valueColor: AlwaysStoppedAnimation(cs.primary),
                  ),
                )
              : Padding(
                  padding: const EdgeInsets.all(16),
                  child: Form(
                    key: _formKey,
                    child: ListView(
                      shrinkWrap: true,
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: [
                        // ── Name ──
                        TextFormField(
                          controller: _nameController,
                          textCapitalization: TextCapitalization.words,
                          decoration: InputDecoration(
                            labelText: l10n.profileNameLabel,
                            hintText: l10n.profileNameHint,
                            prefixIcon: Icon(
                              Icons.person_outline,
                              color: cs.primary,
                            ),
                          ),
                          validator: (v) => (v == null || v.trim().isEmpty)
                              ? l10n.profileNameValidationRequired
                              : null,
                          style: text.bodyLarge,
                        ),
                        const SizedBox(height: 16),

                        // ── Email ──
                        TextFormField(
                          controller: _emailController,
                          keyboardType: TextInputType.emailAddress,
                          decoration: InputDecoration(
                            labelText: l10n.profileEmailLabel,
                            hintText: l10n.profileEmailHint,
                            prefixIcon: Icon(
                              Icons.email_outlined,
                              color: cs.primary,
                            ),
                          ),
                          validator: (v) {
                            if (v == null || v.trim().isEmpty) return null;
                            final regex = RegExp(
                              r'^[\w\.-]+@([\w-]+\.)+[a-zA-Z]{2,}$',
                            );
                            return regex.hasMatch(v.trim())
                                ? null
                                : l10n.profileEmailValidationInvalid;
                          },
                          style: text.bodyLarge,
                        ),
                        const SizedBox(height: 16),

                        // ── Gender ──
                        DropdownButtonFormField<String>(
                          initialValue: _selectedGender,
                          decoration: InputDecoration(
                            labelText: 'Gender',
                            prefixIcon: Icon(
                              Icons.wc_outlined,
                              color: cs.primary,
                            ),
                          ),
                          items: _genderOptions
                              .map(
                                (g) => DropdownMenuItem(
                                  value: g,
                                  child: Text(_genderLabel(g)),
                                ),
                              )
                              .toList(),
                          onChanged: (v) => setState(() => _selectedGender = v),
                          style: text.bodyLarge,
                        ),
                        const SizedBox(height: 16),

                        // ── Birthday ──
                        TextFormField(
                          controller: _birthdayController,
                          readOnly: true,
                          decoration: InputDecoration(
                            labelText: l10n.profileBirthdayLabel,
                            hintText: l10n.profileBirthdayHint,
                            prefixIcon: Icon(
                              Icons.calendar_today_outlined,
                              color: cs.primary,
                            ),
                            suffixIcon: IconButton(
                              icon: Icon(
                                Icons.edit_calendar_outlined,
                                color: cs.primary,
                              ),
                              onPressed: () => _selectBirthday(context),
                            ),
                          ),
                          onTap: () => _selectBirthday(context),
                          style: text.bodyLarge,
                        ),
                        const SizedBox(height: 16),

                        // ── Blood Group ──
                        DropdownButtonFormField<String>(
                          initialValue: _selectedBloodGroup,
                          decoration: InputDecoration(
                            labelText: 'Blood Group',
                            prefixIcon: Icon(
                              Icons.bloodtype_outlined,
                              color: cs.primary,
                            ),
                          ),
                          items: _bloodGroupOptions
                              .map(
                                (bg) => DropdownMenuItem(
                                  value: bg,
                                  child: Text(bg),
                                ),
                              )
                              .toList(),
                          onChanged: (v) =>
                              setState(() => _selectedBloodGroup = v),
                          style: text.bodyLarge,
                        ),
                        const SizedBox(height: 16),

                        // ── Address ──
                        TextFormField(
                          controller: _addressController,
                          maxLines: 3,
                          minLines: 2,
                          textCapitalization: TextCapitalization.sentences,
                          decoration: InputDecoration(
                            labelText: 'Address',
                            hintText: 'Enter your address',
                            prefixIcon: Icon(
                              Icons.home_outlined,
                              color: cs.primary,
                            ),
                            alignLabelWithHint: true,
                          ),
                          style: text.bodyLarge,
                        ),
                        const SizedBox(height: 16),

                        // ── Allergies ──
                        TextFormField(
                          controller: _allergiesController,
                          textCapitalization: TextCapitalization.sentences,
                          decoration: InputDecoration(
                            labelText: 'Allergies',
                            hintText:
                                'e.g., Penicillin, Peanuts (comma-separated)',
                            prefixIcon: Icon(
                              Icons.warning_amber_outlined,
                              color: cs.primary,
                            ),
                          ),
                          style: text.bodyLarge,
                        ),
                        const SizedBox(height: 16),

                        // ── Emergency Contact ──
                        TextFormField(
                          controller: _emergencyContactController,
                          keyboardType: TextInputType.text,
                          decoration: InputDecoration(
                            labelText: 'Emergency Contact',
                            hintText: 'e.g., Spouse: 9876543210',
                            prefixIcon: Icon(
                              Icons.emergency_outlined,
                              color: cs.primary,
                            ),
                          ),
                          style: text.bodyLarge,
                        ),
                        const SizedBox(height: 16),

                        // ── Insurance Details ──
                        TextFormField(
                          controller: _insuranceController,
                          textCapitalization: TextCapitalization.sentences,
                          decoration: InputDecoration(
                            labelText: 'Insurance Details',
                            hintText: 'e.g., Policy number, provider',
                            prefixIcon: Icon(
                              Icons.shield_outlined,
                              color: cs.primary,
                            ),
                          ),
                          style: text.bodyLarge,
                        ),
                        const SizedBox(height: 16),

                        // ── Preferred Hospital ──
                        TextFormField(
                          controller: _preferredHospitalController,
                          textCapitalization: TextCapitalization.words,
                          decoration: InputDecoration(
                            labelText: 'Preferred Hospital',
                            hintText: 'e.g., VH Medical Center',
                            prefixIcon: Icon(
                              Icons.local_hospital_outlined,
                              color: cs.primary,
                            ),
                          ),
                          style: text.bodyLarge,
                        ),
                        const SizedBox(height: 24),

                        // ── Save ──
                        ElevatedButton(
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
                                    l10n.profileSaveChangesButton,
                                    style: text.labelLarge,
                                  ),
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
        tooltip: l10n.authSosTooltip,
        child: const Icon(Icons.sos_outlined),
      ),
    );
  }
}
