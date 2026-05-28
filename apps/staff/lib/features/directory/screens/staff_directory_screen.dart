import 'package:flutter/material.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

/// Staff Directory screen — Browse all staff members.
class StaffDirectoryScreen extends StatefulWidget {
  const StaffDirectoryScreen({super.key});

  @override
  State<StaffDirectoryScreen> createState() => _StaffDirectoryScreenState();
}

class _StaffDirectoryScreenState extends State<StaffDirectoryScreen> {
  List<dynamic> _staff = [];
  bool _loading = true;
  String? _error;
  String _searchQuery = '';
  final _searchCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final list = await HrApiService.getStaffList(suppressErrors: false);
      if (mounted) setState(() => _staff = list);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<dynamic> get _filtered {
    if (_searchQuery.isEmpty) return _staff;
    final q = _searchQuery.toLowerCase();
    return _staff.where((s) {
      final haystack = [
        _staffText(s, const ['name', 'fullName']),
        _staffText(s, const ['employee_id', 'employeeId', 'empId']),
        _staffText(s, const ['department']),
        _staffText(s, const ['role']),
        _staffText(s, const ['position']),
        _staffText(s, const ['shift']),
      ].join(' ').toLowerCase();
      return haystack.contains(q);
    }).toList();
  }

  Map<String, List<dynamic>> get _groupedByDept {
    final grouped = <String, List<dynamic>>{};
    for (final s in _filtered) {
      final dept = _staffText(s, const ['department'], fallback: 'Other');
      grouped.putIfAbsent(dept, () => []).add(s);
    }
    final sorted = Map.fromEntries(
      grouped.entries.toList()..sort((a, b) => a.key.compareTo(b.key)),
    );
    return sorted;
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.directoryTitle,
      body: Column(
        children: [
          // Search bar
          Container(
            color: AppTheme.surfaceWhite,
            padding: const EdgeInsets.all(12),
            child: TextField(
              controller: _searchCtrl,
              style: TextStyle(color: AppTheme.textPrimary),
              decoration: InputDecoration(
                hintText: s.directorySearchHint,
                prefixIcon: ExcludeSemantics(
                  child: Icon(Icons.search, color: AppTheme.textSecondary),
                ),
                suffixIcon: _searchQuery.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear),
                        tooltip: s.actionSearch,
                        onPressed: () {
                          _searchCtrl.clear();
                          setState(() => _searchQuery = '');
                        },
                      )
                    : null,
                filled: true,
                fillColor: AppTheme.backgroundGrey,
              ),
              onChanged: (v) => setState(() => _searchQuery = v),
            ),
          ),

          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                  ? _ErrorState(error: _error!, onRetry: _load)
                  : _filtered.isEmpty
                  ? _EmptyState(hasSearch: _searchQuery.isNotEmpty)
                  : _groupedByDept.isEmpty
                  ? _EmptyState(hasSearch: _searchQuery.isNotEmpty)
                  : ListView(
                      padding: const EdgeInsets.all(12),
                      children: _groupedByDept.entries
                          .map(
                            (entry) => _DeptSection(
                              dept: entry.key,
                              members: entry.value,
                            ),
                          )
                          .toList(),
                    ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DeptSection extends StatelessWidget {
  final String dept;
  final List<dynamic> members;

  const _DeptSection({required this.dept, required this.members});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text(
            dept,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.bold,
              color: AppTheme.textSecondary,
            ),
          ),
        ),
        ...members.map((s) => _StaffTile(staff: s)),
        const SizedBox(height: 8),
      ],
    );
  }
}

class _StaffTile extends StatelessWidget {
  final dynamic staff;
  const _StaffTile({required this.staff});

  @override
  Widget build(BuildContext context) {
    final name = _staffText(staff, const [
      'name',
      'fullName',
    ], fallback: 'Unknown');
    final rawRole = _staffText(staff, const ['role']);
    final role = rawRole.isEmpty ? '-' : rawRole.replaceAll('_', ' ');
    final dept = _staffText(staff, const ['department'], fallback: '-');
    final position = _staffText(staff, const ['position']);
    final shift = _staffText(staff, const ['shift']);
    final phone = _staffText(staff, const ['phone', 'contact']);
    final empId = _staffText(staff, const [
      'employee_id',
      'employeeId',
      'empId',
    ]);
    final isActive = _staffBool(staff, const [
      'is_active',
      'isActive',
    ], defaultValue: true);

    Color roleColor = switch (rawRole.toUpperCase()) {
      String r when r.contains('DOCTOR') => AppTheme.primaryBlue,
      String r when r.contains('NURSING') => AppTheme.primaryTeal,
      String r when r.contains('HR') => const Color(0xFF6A1B9A),
      String r when r.contains('PHARMACY') => const Color(0xFFE65100),
      String r when r.contains('LAB') => AppTheme.accentCyan,
      String r when r.contains('ADMIN') => AppTheme.errorRed,
      String r when r.contains('HOUSEKEEPING') => const Color(0xFF00897B),
      String r when r.contains('MAINTENANCE') => const Color(0xFF5D4037),
      String r when r.contains('RECEPTION') => const Color(0xFF3949AB),
      _ => AppTheme.textSecondary,
    };

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: roleColor.withValues(alpha: 0.15),
          child: Text(
            name.isNotEmpty ? name[0].toUpperCase() : '?',
            style: TextStyle(color: roleColor, fontWeight: FontWeight.bold),
          ),
        ),
        title: Text(
          name,
          style: TextStyle(
            fontWeight: FontWeight.w600,
            color: AppTheme.textPrimary,
          ),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(role, style: TextStyle(fontSize: 12, color: roleColor)),
            if (position.isNotEmpty)
              Text(
                position,
                style: TextStyle(fontSize: 11, color: AppTheme.textSecondary),
              ),
            if (empId.isNotEmpty)
              Text(
                'ID: $empId',
                style: TextStyle(fontSize: 11, color: AppTheme.textSecondary),
              ),
            if (shift.isNotEmpty)
              Text(
                'Shift: $shift',
                style: TextStyle(fontSize: 11, color: AppTheme.textSecondary),
              ),
          ],
        ),
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: isActive
                    ? AppTheme.successGreen.withValues(alpha: 0.1)
                    : AppTheme.errorRed.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                isActive ? 'Active' : 'Inactive',
                style: TextStyle(
                  fontSize: 10,
                  color: isActive ? AppTheme.successGreen : AppTheme.errorRed,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
            if (phone.isNotEmpty) ...[
              const SizedBox(height: 4),
              Icon(
                Icons.phone_outlined,
                size: 14,
                color: AppTheme.textSecondary,
              ),
            ],
          ],
        ),
        onTap: phone.isNotEmpty
            ? () => _showContact(context, name, phone, dept, role)
            : null,
      ),
    );
  }

  void _showContact(
    BuildContext context,
    String name,
    String phone,
    String dept,
    String role,
  ) {
    final s = AppStrings.of(context);
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(name),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _DialogRow(Icons.badge_outlined, role),
            _DialogRow(Icons.business_outlined, dept),
            if (phone.isNotEmpty) _DialogRow(Icons.phone_outlined, phone),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(s.actionClose),
          ),
        ],
      ),
    );
  }
}

class _DialogRow extends StatelessWidget {
  final IconData icon;
  final String text;
  const _DialogRow(this.icon, this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Icon(icon, size: 16, color: AppTheme.textSecondary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(color: AppTheme.textPrimary)),
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String error;
  final VoidCallback onRetry;
  const _ErrorState({required this.error, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, color: AppTheme.errorRed, size: 40),
          const SizedBox(height: 8),
          Text(
            error,
            style: TextStyle(color: AppTheme.textSecondary),
            textAlign: TextAlign.center,
          ),
          Text(
            AppStrings.of(context).directoryApiUnavailable,
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          ),
          TextButton(
            onPressed: onRetry,
            child: Text(AppStrings.of(context).actionRetry),
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final bool hasSearch;
  const _EmptyState({required this.hasSearch});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.people_outline, size: 56, color: AppTheme.textSecondary),
          const SizedBox(height: 16),
          Text(
            hasSearch ? s.directoryStaffEmptyBody : s.directoryEmpty,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            hasSearch ? s.directorySearchEmpty : s.directoryApiPending,
            textAlign: TextAlign.center,
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }
}

String _staffText(dynamic staff, List<String> keys, {String fallback = ''}) {
  if (staff is! Map) return fallback;
  for (final key in keys) {
    final value = staff[key];
    if (value == null) continue;
    final text = value.toString().trim();
    if (text.isNotEmpty) return text;
  }
  return fallback;
}

bool _staffBool(
  dynamic staff,
  List<String> keys, {
  required bool defaultValue,
}) {
  if (staff is! Map) return defaultValue;
  for (final key in keys) {
    final value = staff[key];
    if (value is bool) return value;
    if (value is String) {
      final lower = value.toLowerCase();
      if (lower == 'true') return true;
      if (lower == 'false') return false;
    }
  }
  return defaultValue;
}
