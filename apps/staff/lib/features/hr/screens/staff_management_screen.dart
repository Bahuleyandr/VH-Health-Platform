import 'package:flutter/material.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

/// Staff Management screen — HR/Admin can view and edit staff members.
class StaffManagementScreen extends StatefulWidget {
  const StaffManagementScreen({super.key});

  @override
  State<StaffManagementScreen> createState() => _StaffManagementScreenState();
}

class _StaffManagementScreenState extends State<StaffManagementScreen> {
  List<dynamic> _staff = [];
  Map<String, dynamic>? _deptSummary;
  bool _loading = true;
  String? _error;
  String _searchQuery = '';
  String? _selectedDept;
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

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Staff Management',
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _showAddStaffDialog(context),
        icon: const Icon(Icons.person_add),
        label: const Text('Add Staff'),
        backgroundColor: AppTheme.primaryBlue,
      ),
      body: Column(
        children: [
          // Search bar
          Container(
            color: Colors.white,
            padding: EdgeInsets.all(12),
            child: TextField(
              controller: _searchCtrl,
              decoration: InputDecoration(
                hintText: 'Search by name, department, role...',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _searchQuery.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear),
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

          // Department summary bar
          if (_deptSummary != null)
            Container(
              color: Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '${_selectedDept ?? 'Department'}: '
                      '${_deptSummary!['totalStaff'] ?? _deptSummary!['count'] ?? '—'} staff',
                      style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: AppTheme.primaryBlue,
                      ),
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () => setState(() {
                      _deptSummary = null;
                      _selectedDept = null;
                    }),
                  ),
                ],
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
                  : ListView.builder(
                      padding: const EdgeInsets.all(12),
                      itemCount: _filtered.length,
                      itemBuilder: (ctx, i) => _StaffCard(
                        staff: _filtered[i],
                        onEdit: () => _showEditDialog(context, _filtered[i]),
                      ),
                    ),
            ),
          ),
        ],
      ),
    );
  }

  // ignore: unused_element
  Future<void> _loadDeptSummary(String department) async {
    try {
      final data = await HrApiService.getDepartmentSummary(department);
      if (mounted) {
        setState(() {
          _deptSummary = data;
          _selectedDept = department;
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  void _showAddStaffDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (_) => const _StaffFormDialog(staff: null),
    ).then((_) => _load());
  }

  void _showEditDialog(BuildContext context, dynamic staff) {
    showDialog(
      context: context,
      builder: (_) => _StaffFormDialog(staff: staff),
    ).then((_) => _load());
  }
}

class _StaffCard extends StatelessWidget {
  final dynamic staff;
  final VoidCallback onEdit;

  const _StaffCard({required this.staff, required this.onEdit});

  @override
  Widget build(BuildContext context) {
    final name = staff['name'] ?? staff['fullName'] ?? 'Unknown';
    final role = staff['role'] ?? '—';
    final dept = staff['department'] ?? '—';
    final empId = staff['employeeId'] ?? staff['empId'] ?? '—';
    final isActive = staff['isActive'] != false;

    Color roleColor = switch (role) {
      String r when r.contains('DOCTOR') => AppTheme.primaryBlue,
      String r when r.contains('NURSING') => AppTheme.primaryTeal,
      String r when r.contains('HR') => const Color(0xFF6A1B9A),
      String r when r.contains('PHARMACY') => const Color(0xFFE65100),
      String r when r.contains('LAB') => AppTheme.accentCyan,
      String r when r.contains('ADMIN') => AppTheme.errorRed,
      _ => AppTheme.textSecondary,
    };

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            // Avatar
            CircleAvatar(
              backgroundColor: roleColor.withValues(alpha: 0.15),
              child: Text(
                name.isNotEmpty ? name[0].toUpperCase() : '?',
                style: TextStyle(color: roleColor, fontWeight: FontWeight.bold),
              ),
            ),
            const SizedBox(width: 12),
            // Info
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          name,
                          style: TextStyle(
                            fontWeight: FontWeight.bold,
                            color: AppTheme.textPrimary,
                          ),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 6,
                          vertical: 2,
                        ),
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
                            color: isActive
                                ? AppTheme.successGreen
                                : AppTheme.errorRed,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    role.replaceAll('_', ' '),
                    style: TextStyle(fontSize: 12, color: roleColor),
                  ),
                  Text(
                    '$dept • ID: $empId',
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
            IconButton(
              icon: Icon(
                Icons.edit_outlined,
                color: AppTheme.textSecondary,
              ),
              onPressed: onEdit,
            ),
          ],
        ),
      ),
    );
  }
}

class _StaffFormDialog extends StatefulWidget {
  final dynamic staff;
  const _StaffFormDialog({required this.staff});

  @override
  State<_StaffFormDialog> createState() => _StaffFormDialogState();
}

class _StaffFormDialogState extends State<_StaffFormDialog> {
  final _formKey = GlobalKey<FormState>();
  late TextEditingController _nameCtrl;
  late TextEditingController _deptCtrl;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _nameCtrl = TextEditingController(
      text: widget.staff?['name'] ?? widget.staff?['fullName'] ?? '',
    );
    _deptCtrl = TextEditingController(text: widget.staff?['department'] ?? '');
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _deptCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      final id = widget.staff?['_id'] ?? widget.staff?['id'];
      if (id != null) {
        await HrApiService.updateProfile(id.toString(), {
          'name': _nameCtrl.text.trim(),
          'department': _deptCtrl.text.trim(),
        });
      }
      // TODO: Add POST endpoint for creating new staff when available
      if (mounted) {
        Navigator.of(context).pop();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              id != null
                  ? '✅ Staff updated successfully'
                  : '✅ Staff added (backend API pending)',
            ),
            backgroundColor: AppTheme.successGreen,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isEdit = widget.staff != null;
    return AlertDialog(
      title: Text(isEdit ? 'Edit Staff' : 'Add Staff'),
      content: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextFormField(
              controller: _nameCtrl,
              decoration: const InputDecoration(labelText: 'Full Name'),
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? 'Name is required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _deptCtrl,
              decoration: const InputDecoration(labelText: 'Department'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        ElevatedButton(
          onPressed: _submitting ? null : _submit,
          child: Text(_submitting ? 'Saving...' : 'Save'),
        ),
      ],
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
          const SizedBox(height: 8),
          Text(
            'Staff list API may not be available yet.',
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
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
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.people_outline,
            size: 56,
            color: AppTheme.textSecondary,
          ),
          SizedBox(height: 16),
          Text(
            hasSearch ? 'No staff found' : 'No staff members',
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            hasSearch
                ? 'Try a different search term'
                : 'Staff data will appear here once the API is connected',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }
}
