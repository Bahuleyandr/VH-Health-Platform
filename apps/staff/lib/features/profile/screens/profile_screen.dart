import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  Map<String, dynamic>? _profile;
  bool _loading = true;
  bool _editing = false;
  bool _saving = false;
  String? _error;

  // Edit controllers
  final _nameCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadProfile();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadProfile() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await _loadAuthenticatedProfile();
      final staff = _normalizeProfilePayload(data);
      if (staff.isEmpty) throw Exception('Profile details not found');

      if (mounted) {
        setState(() => _profile = staff);
        _nameCtrl.text = _profileValue(staff, ['name', 'staffName']);
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<Map<String, dynamic>> _loadAuthenticatedProfile() async {
    try {
      return await HrApiService.getAuthProfile();
    } catch (_) {
      final identifier =
          await ApiConfig.getEmployeeId() ?? await ApiConfig.getStaffId();
      if (identifier == null) throw Exception('No identifier found');
      return HrApiService.getProfile(identifier);
    }
  }

  Future<void> _saveProfile() async {
    setState(() => _saving = true);
    try {
      final name = _nameCtrl.text.trim().replaceAll(RegExp(r'\s+'), ' ');
      if (name.length < 2) {
        throw Exception('Name must be at least 2 characters');
      }
      await HrApiService.updateOwnProfile(name: name);

      if (mounted) {
        final s = AppStrings.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.profileUpdatedSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        setState(() => _editing = false);
        unawaited(_loadProfile());
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.profileTitle,
      showBottomNav: false,
      actions: [
        if (!_loading && _profile != null)
          IconButton(
            icon: Icon(_editing ? Icons.close : Icons.edit_outlined),
            onPressed: () => setState(() => _editing = !_editing),
            tooltip: _editing ? s.profileCancelTooltip : s.profileEditTooltip,
          ),
      ],
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.error_outline,
                    color: AppTheme.errorRed,
                    size: 40,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _error!,
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                  TextButton(
                    onPressed: _loadProfile,
                    child: Text(s.actionRetry),
                  ),
                ],
              ),
            )
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  _buildAvatarSection(),
                  const SizedBox(height: 20),
                  _buildInfoCard(),
                  const SizedBox(height: 16),
                  if (_editing) _buildEditCard(),
                ],
              ),
            ),
    );
  }

  Widget _buildAvatarSection() {
    final s = AppStrings.of(context);
    final name = _profileValue(_profile, [
      'name',
      'staffName',
    ], fallback: s.profileFallbackName);
    final role = _profileValue(_profile, ['role']);
    final dept = _profileValue(_profile, ['department']);
    final empId = _profileValue(_profile, ['employeeId', 'employee_id']);

    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [AppTheme.primaryBlue, AppTheme.accentCyan],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        children: [
          CircleAvatar(
            radius: 44,
            backgroundColor: Theme.of(context).colorScheme.onPrimary
                .withValues(alpha: 0.25),
            child: Text(
              name.isNotEmpty ? name[0].toUpperCase() : 'S',
              style: const TextStyle(
                fontSize: 36,
                fontWeight: FontWeight.bold,
                color: Colors.white,
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            name,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 20,
              fontWeight: FontWeight.bold,
            ),
          ),
          if (empId.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                '${s.profileEmpIdPrefix} $empId',
                style: const TextStyle(color: Colors.white70, fontSize: 13),
              ),
            ),
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (role.isNotEmpty) _ProfileChip(role.replaceAll('_', ' ')),
              if (dept.isNotEmpty) ...[
                const SizedBox(width: 8),
                _ProfileChip(dept),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildInfoCard() {
    final s = AppStrings.of(context);
    final role = _profileValue(_profile, [
      'role',
    ], fallback: '—').replaceAll('_', ' ');
    final phone = _profileValue(_profile, [
      'phone',
      'phoneNumber',
    ], fallback: '—');

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.profileInfoTitle,
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 15,
                color: AppTheme.textPrimary,
              ),
            ),
            const Divider(height: 20),
            _FieldRow(
              label: s.profileFieldEmployeeId,
              value: _profileValue(_profile, [
                'employeeId',
                'employee_id',
              ], fallback: '—'),
            ),
            _FieldRow(
              label: s.profileFieldRole,
              value: role,
              note: s.profileHrManagedHint,
            ),
            _FieldRow(
              label: s.profileFieldDepartment,
              value: _profileValue(_profile, ['department'], fallback: '—'),
            ),
            _FieldRow(
              label: s.profileFieldPhone,
              value: phone,
              note: s.profileHrManagedHint,
            ),
            _FieldRow(
              label: s.profileFieldEmail,
              value: _profileValue(_profile, ['email'], fallback: '—'),
            ),
            _FieldRow(
              label: s.profileFieldShift,
              value: _profileValue(_profile, ['shift'], fallback: '—'),
            ),
            _FieldRow(
              label: s.profileFieldJoiningDate,
              value: _profileValue(_profile, [
                'joiningDate',
                'joining_date',
                'hireDate',
                'hire_date',
                'createdAt',
                'created_at',
                'registeredAt',
                'registered_at',
              ], fallback: '—'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEditCard() {
    final s = AppStrings.of(context);
    final role = _profileValue(_profile, [
      'role',
    ], fallback: '—').replaceAll('_', ' ');
    final phone = _profileValue(_profile, [
      'phone',
      'phoneNumber',
    ], fallback: '—');

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.profileEditTitle,
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 15,
                color: AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _nameCtrl,
              decoration: InputDecoration(
                labelText: s.profileFieldName,
                prefixIcon: const ExcludeSemantics(
                  child: Icon(Icons.badge_outlined),
                ),
              ),
            ),
            const SizedBox(height: 12),
            _ManagedField(
              icon: Icons.phone_outlined,
              label: s.profileFieldPhone,
              value: phone,
              note: s.profileHrManagedHint,
            ),
            const SizedBox(height: 8),
            _ManagedField(
              icon: Icons.admin_panel_settings_outlined,
              label: s.profileFieldRole,
              value: role,
              note: s.profileHrManagedHint,
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _saving ? null : _saveProfile,
              icon: _saving
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        color: Colors.white,
                        strokeWidth: 2,
                      ),
                    )
                  : const Icon(Icons.save, color: Colors.white),
              label: Text(
                _saving ? s.profileSavingButton : s.profileSaveChanges,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Map<String, dynamic> _normalizeProfilePayload(Map<String, dynamic> payload) {
  final profile = <String, dynamic>{};

  void merge(Object? value, {bool overwrite = false}) {
    if (value is! Map) return;
    value.forEach((key, rawValue) {
      final normalizedKey = key.toString();
      if (rawValue == null) return;
      if (overwrite ||
          !profile.containsKey(normalizedKey) ||
          profile[normalizedKey].toString().trim().isEmpty) {
        profile[normalizedKey] = rawValue;
      }
    });
  }

  merge(payload['profile']);
  merge(payload['staff']);
  if (profile.isEmpty) merge(payload);
  merge(payload['userInfo']);

  void alias(String camel, String snake) {
    profile[camel] ??= profile[snake];
    profile[snake] ??= profile[camel];
  }

  alias('employeeId', 'employee_id');
  alias('phoneNumber', 'phone_number');
  alias('joiningDate', 'joining_date');
  alias('hireDate', 'hire_date');
  alias('createdAt', 'created_at');
  alias('registeredAt', 'registered_at');
  alias('staffId', 'staff_id');
  profile['staffName'] ??= profile['name'];

  return profile;
}

String _profileValue(
  Map<String, dynamic>? profile,
  List<String> keys, {
  String fallback = '',
}) {
  if (profile == null) return fallback;
  for (final key in keys) {
    final value = profile[key];
    if (value == null) continue;
    final text = value.toString().trim();
    if (text.isNotEmpty) return text;
  }
  return fallback;
}

class _ProfileChip extends StatelessWidget {
  final String label;
  const _ProfileChip(this.label);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.2),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Text(
        label,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 12,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

class _FieldRow extends StatelessWidget {
  final String label;
  final String value;
  final String? note;
  const _FieldRow({required this.label, required this.value, this.note});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 13),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value,
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                if (note != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    note!,
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 11,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ManagedField extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final String note;

  const _ManagedField({
    required this.icon,
    required this.label,
    required this.value,
    required this.note,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.06),
        border: Border.all(color: Theme.of(context).dividerColor),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(icon, color: AppTheme.textSecondary, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                ),
                const SizedBox(height: 2),
                Text(
                  value,
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  note,
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 11),
                ),
              ],
            ),
          ),
          Icon(
            Icons.lock_outline,
            color: AppTheme.textSecondary.withValues(alpha: 0.8),
            size: 18,
          ),
        ],
      ),
    );
  }
}
