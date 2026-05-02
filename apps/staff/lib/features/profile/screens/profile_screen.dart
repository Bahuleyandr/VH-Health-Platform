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
  final _phoneCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _addressCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadProfile();
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _emailCtrl.dispose();
    _addressCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadProfile() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final identifier =
          await ApiConfig.getEmployeeId() ?? await ApiConfig.getStaffId();
      if (identifier == null) throw Exception('No identifier found');

      final data = await HrApiService.getProfile(identifier);
      final staff = Map<String, dynamic>.from(data['staff'] ?? data);

      // Merge auth profile data as supplementary source
      try {
        final authData = await HrApiService.getAuthProfile();
        final authProfile = authData['staff'] ?? authData;
        if (authProfile is Map) {
          authProfile.forEach((k, v) {
            if (v != null &&
                (staff[k] == null || staff[k].toString().isEmpty)) {
              staff[k] = v;
            }
          });
        }
      } catch (e) {
        // Auth profile is supplementary — don't fail if unavailable
      }

      if (mounted) {
        setState(() => _profile = staff);
        _phoneCtrl.text =
            staff['phone']?.toString() ??
            staff['phoneNumber']?.toString() ??
            '';
        _emailCtrl.text = staff['email']?.toString() ?? '';
        _addressCtrl.text = staff['address']?.toString() ?? '';
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _saveProfile() async {
    setState(() => _saving = true);
    try {
      final id = _profile?['_id']?.toString() ?? _profile?['id']?.toString();
      if (id == null) throw Exception('Profile ID not found');

      await HrApiService.updateProfile(id, {
        if (_phoneCtrl.text.isNotEmpty) 'phone': _phoneCtrl.text.trim(),
        if (_emailCtrl.text.isNotEmpty) 'email': _emailCtrl.text.trim(),
        if (_addressCtrl.text.isNotEmpty) 'address': _addressCtrl.text.trim(),
      });

      if (mounted) {
        final s = AppStrings.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.profileUpdatedSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        setState(() => _editing = false);
        _loadProfile();
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
          ? Center(child: CircularProgressIndicator())
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
    final name = _profile?['name']?.toString() ?? s.profileFallbackName;
    final role = _profile?['role']?.toString() ?? '';
    final dept = _profile?['department']?.toString() ?? '';
    final empId = _profile?['employeeId']?.toString() ?? '';

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
            backgroundColor: Colors.white.withValues(alpha: 0.25),
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
    final fields = <String, String>{
      s.profileFieldEmployeeId: _profile?['employeeId']?.toString() ?? '—',
      s.profileFieldRole: (_profile?['role']?.toString() ?? '—').replaceAll('_', ' '),
      s.profileFieldDepartment: _profile?['department']?.toString() ?? '—',
      s.profileFieldPhone:
          _profile?['phone']?.toString() ??
          _profile?['phoneNumber']?.toString() ??
          '—',
      s.profileFieldEmail: _profile?['email']?.toString() ?? '—',
      s.profileFieldShift: _profile?['shift']?.toString() ?? '—',
      s.profileFieldJoiningDate:
          _profile?['joiningDate']?.toString() ??
          _profile?['createdAt']?.toString() ??
          '—',
    };

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
            ...fields.entries.map(
              (e) => _FieldRow(label: e.key, value: e.value),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEditCard() {
    final s = AppStrings.of(context);
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
              controller: _phoneCtrl,
              decoration: InputDecoration(
                labelText: s.profileFieldPhone,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.phone_outlined)),
              ),
              keyboardType: TextInputType.phone,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _emailCtrl,
              decoration: InputDecoration(
                labelText: s.profileFieldEmail,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.email_outlined)),
              ),
              keyboardType: TextInputType.emailAddress,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _addressCtrl,
              decoration: InputDecoration(
                labelText: s.profileFieldAddress,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.home_outlined)),
                alignLabelWithHint: true,
              ),
              maxLines: 2,
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
              label: Text(_saving ? s.profileSavingButton : s.profileSaveChanges),
            ),
          ],
        ),
      ),
    );
  }
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
  const _FieldRow({required this.label, required this.value});

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
              style: TextStyle(
                color: AppTheme.textSecondary,
                fontSize: 13,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontSize: 13,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
