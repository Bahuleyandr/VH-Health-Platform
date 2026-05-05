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
      // TODO: Use GET /staff or GET /staff/directory when endpoint is available.
      final data = await HrApiService.getHRDashboard();
      final list = data['staff'] as List? ?? data['staffList'] as List? ?? [];
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
      final name = (s['name'] ?? s['fullName'] ?? '').toString().toLowerCase();
      final dept = (s['department'] ?? '').toString().toLowerCase();
      final role = (s['role'] ?? '').toString().toLowerCase();
      return name.contains(q) || dept.contains(q) || role.contains(q);
    }).toList();
  }

  Map<String, List<dynamic>> get _groupedByDept {
    final grouped = <String, List<dynamic>>{};
    for (final s in _filtered) {
      final dept = s['department']?.toString() ?? 'Other';
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
            color: Colors.white,
            padding: const EdgeInsets.all(12),
            child: TextField(
              controller: _searchCtrl,
              decoration: InputDecoration(
                hintText: s.directorySearchHint,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
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
    final name = staff['name'] ?? staff['fullName'] ?? 'Unknown';
    final role = staff['role']?.toString().replaceAll('_', ' ') ?? '—';
    final dept = staff['department'] ?? '—';
    final phone = staff['phone'] ?? staff['contact'] ?? '';
    final empId = staff['employeeId'] ?? staff['empId'] ?? '';
    final isActive = staff['isActive'] != false;

    Color roleColor = switch (staff['role']?.toString() ?? '') {
      String r when r.contains('DOCTOR') => AppTheme.primaryBlue,
      String r when r.contains('NURSING') => AppTheme.primaryTeal,
      String r when r.contains('HR') => const Color(0xFF6A1B9A),
      String r when r.contains('PHARMACY') => const Color(0xFFE65100),
      String r when r.contains('LAB') => AppTheme.accentCyan,
      String r when r.contains('ADMIN') => AppTheme.errorRed,
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
            if (empId.isNotEmpty)
              Text(
                'ID: $empId',
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
            _DialogRow(Icons.phone_outlined, phone),
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
