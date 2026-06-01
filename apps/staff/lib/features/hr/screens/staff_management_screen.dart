import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/material.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

@visibleForTesting
const staffDefaultDepartmentOptions = <String>[
  'Admissions',
  'Billing',
  'Emergency',
  'General',
  'Housekeeping',
  'ICU',
  'Insurance',
  'Laboratory',
  'Maintenance',
  'Nursing',
  'OPD',
  'Pharmacy',
  'Radiology',
  'Reception',
  'Security',
];

@visibleForTesting
List<String> uniqueSortedStaffDepartments(Iterable<Object?> values) {
  final seen = <String, String>{};
  for (final value in values) {
    final department = value?.toString().trim() ?? '';
    if (department.isEmpty) continue;
    seen.putIfAbsent(department.toLowerCase(), () => department);
  }
  return seen.values.toList()
    ..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
}

@visibleForTesting
List<String> buildStaffDepartmentOptions({
  Iterable<Object?> existingDepartments = const [],
  String? currentValue,
}) {
  return uniqueSortedStaffDepartments([
    ...staffDefaultDepartmentOptions,
    ...existingDepartments,
    currentValue,
  ]);
}

@visibleForTesting
List<String> filterStaffDepartmentOptions({
  required Iterable<String> options,
  required String query,
  bool showAllOptions = false,
}) {
  final normalizedQuery = query.trim().toLowerCase();
  if (showAllOptions || normalizedQuery.isEmpty) {
    return options.toList(growable: false);
  }
  return options
      .where((department) => department.toLowerCase().contains(normalizedQuery))
      .toList(growable: false);
}

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

  List<String> get _departmentOptions => buildStaffDepartmentOptions(
    existingDepartments: _staff.map((row) => row['department']),
  );

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
      final name = (s['name'] ?? s['fullName'] ?? '').toString().toLowerCase();
      final dept = (s['department'] ?? '').toString().toLowerCase();
      final role = (s['role'] ?? '').toString().toLowerCase();
      return name.contains(q) || dept.contains(q) || role.contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.staffMgmtTitle,
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _showEditDialog(context, null),
        icon: const Icon(Icons.person_add),
        label: Text(s.staffMgmtAddStaff),
        backgroundColor: AppTheme.primaryBlue,
      ),
      body: Column(
        children: [
          // Search bar
          Container(
            color: Colors.white,
            padding: const EdgeInsets.all(12),
            child: TextField(
              controller: _searchCtrl,
              decoration: InputDecoration(
                hintText: s.staffMgmtSearchHint,
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
                    tooltip: 'Remove filter',
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

  void _showEditDialog(BuildContext context, dynamic staff) {
    showDialog(
      context: context,
      builder: (_) =>
          _StaffFormDialog(staff: staff, departmentOptions: _departmentOptions),
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
    final empId =
        staff['employee_id'] ?? staff['employeeId'] ?? staff['empId'] ?? '—';
    final isActive = (staff['is_active'] ?? staff['isActive']) != false;

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
              icon: Icon(Icons.edit_outlined, color: AppTheme.textSecondary),
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
  final List<String> departmentOptions;
  const _StaffFormDialog({
    required this.staff,
    required this.departmentOptions,
  });

  @override
  State<_StaffFormDialog> createState() => _StaffFormDialogState();
}

class _StaffFormDialogState extends State<_StaffFormDialog> {
  final _formKey = GlobalKey<FormState>();
  late TextEditingController _nameCtrl;
  late TextEditingController _phoneCtrl;
  late TextEditingController _emailCtrl;
  late TextEditingController _employeeIdCtrl;
  late TextEditingController _deptCtrl;
  late TextEditingController _positionCtrl;
  late TextEditingController _passwordCtrl;
  late FocusNode _deptFocusNode;
  String _role = 'NURSING_STAFF';
  String _shift = 'FULL_DAY';
  bool _submitting = false;
  bool _showAllDepartments = false;

  static const _roleOptions = <_StaffRoleOption>[
    _StaffRoleOption('DOCTOR', 'Doctor'),
    _StaffRoleOption('DUTY_DOCTOR', 'Duty Doctor'),
    _StaffRoleOption('MEDICAL_SUPERINTENDENT', 'Medical Superintendent'),
    _StaffRoleOption('CNO', 'Nursing Superintendent'),
    _StaffRoleOption('NURSING_STAFF', 'Nursing Staff'),
    _StaffRoleOption('NURSING_INCHARGE', 'Nursing Incharge'),
    _StaffRoleOption('OP_STAFF_NURSE', 'OP Staff Nurse'),
    _StaffRoleOption('OP_INCHARGE', 'OP Incharge'),
    _StaffRoleOption('RECEPTIONIST', 'Receptionist'),
    _StaffRoleOption('RECEPTION_INCHARGE', 'Reception Incharge'),
    _StaffRoleOption('HR_STAFF', 'HR Staff'),
    _StaffRoleOption('HOUSEKEEPING_STAFF', 'Housekeeping Staff'),
    _StaffRoleOption('HOUSEKEEPING_INCHARGE', 'Housekeeping Incharge'),
    _StaffRoleOption('PHARMACY_STAFF', 'Pharmacy Staff'),
    _StaffRoleOption('LAB_STAFF', 'Lab Staff'),
    _StaffRoleOption('DRIVER', 'Driver'),
    _StaffRoleOption('MAINTENANCE', 'Maintenance'),
    _StaffRoleOption('GENERAL_STAFF', 'General Staff'),
  ];

  static const _shiftOptions = [
    'FULL_DAY',
    'MORNING',
    'AFTERNOON',
    'NIGHT',
    'ON_CALL',
  ];

  @override
  void initState() {
    super.initState();
    _nameCtrl = TextEditingController(
      text: widget.staff?['name'] ?? widget.staff?['fullName'] ?? '',
    );
    _phoneCtrl = TextEditingController(text: widget.staff?['phone'] ?? '');
    _emailCtrl = TextEditingController(text: widget.staff?['email'] ?? '');
    _employeeIdCtrl = TextEditingController(
      text: widget.staff?['employee_id'] ?? widget.staff?['employeeId'] ?? '',
    );
    _deptCtrl = TextEditingController(text: widget.staff?['department'] ?? '');
    _deptFocusNode = FocusNode()
      ..addListener(() {
        if (!_deptFocusNode.hasFocus && _showAllDepartments && mounted) {
          setState(() => _showAllDepartments = false);
        }
      });
    _positionCtrl = TextEditingController(
      text: widget.staff?['position'] ?? widget.staff?['designation'] ?? '',
    );
    _passwordCtrl = TextEditingController();
    final role = widget.staff?['role']?.toString().toUpperCase();
    if (role != null && _roleOptions.any((option) => option.value == role)) {
      _role = role;
    }
    final shift = widget.staff?['shift']?.toString().toUpperCase();
    if (shift != null && _shiftOptions.contains(shift)) {
      _shift = shift;
    }
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    _emailCtrl.dispose();
    _employeeIdCtrl.dispose();
    _deptCtrl.dispose();
    _deptFocusNode.dispose();
    _positionCtrl.dispose();
    _passwordCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      final id =
          widget.staff?['uid'] ??
          widget.staff?['employee_id'] ??
          widget.staff?['id'] ??
          widget.staff?['user_id'] ??
          widget.staff?['_id'];
      if (id != null) {
        await HrApiService.updateProfile(id.toString(), {
          'department': _deptCtrl.text.trim(),
          'position': _positionCtrl.text.trim(),
          'shift': _shift,
        });
      } else {
        await HrApiService.createStaffProfile({
          'name': _nameCtrl.text.trim(),
          'phone': _phoneCtrl.text.trim(),
          if (_emailCtrl.text.trim().isNotEmpty)
            'email': _emailCtrl.text.trim(),
          if (_employeeIdCtrl.text.trim().isNotEmpty)
            'employee_id': _employeeIdCtrl.text.trim(),
          'role': _role,
          'department': _deptCtrl.text.trim(),
          'position': _positionCtrl.text.trim(),
          'shift': _shift,
          'temporary_password': _passwordCtrl.text.trim(),
        });
      }
      if (mounted) {
        Navigator.of(context).pop();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              id != null
                  ? 'Staff updated successfully'
                  : 'Staff account created with onboarding checklist',
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
    final s = AppStrings.of(context);
    final isEdit = widget.staff != null;
    return AlertDialog(
      title: Text(isEdit ? s.staffMgmtEditStaff : s.staffMgmtAddStaff),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Form(
            key: _formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextFormField(
                  controller: _nameCtrl,
                  enabled: !isEdit,
                  decoration: InputDecoration(labelText: s.staffMgmtFullName),
                  validator: (v) => (v == null || v.trim().isEmpty)
                      ? s.staffMgmtNameRequired
                      : null,
                ),
                const SizedBox(height: 12),
                if (!isEdit) ...[
                  TextFormField(
                    controller: _phoneCtrl,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(labelText: 'Phone'),
                    validator: (v) => (v == null || v.trim().isEmpty)
                        ? 'Phone is required'
                        : null,
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _emailCtrl,
                    keyboardType: TextInputType.emailAddress,
                    decoration: const InputDecoration(labelText: 'Email'),
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _employeeIdCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Employee ID',
                      helperText: 'Leave blank to auto-generate',
                    ),
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: _role,
                    decoration: const InputDecoration(labelText: 'Role'),
                    items: [
                      for (final option in _roleOptions)
                        DropdownMenuItem(
                          value: option.value,
                          child: Text(option.label),
                        ),
                    ],
                    onChanged: (value) {
                      if (value != null) setState(() => _role = value);
                    },
                  ),
                  const SizedBox(height: 12),
                ],
                _DepartmentAutocompleteField(
                  controller: _deptCtrl,
                  focusNode: _deptFocusNode,
                  label: s.staffMgmtDepartment,
                  showAllOptions: _showAllDepartments,
                  options: buildStaffDepartmentOptions(
                    existingDepartments: widget.departmentOptions,
                    currentValue: _deptCtrl.text,
                  ),
                  onChanged: (_) {
                    if (_showAllDepartments) {
                      setState(() => _showAllDepartments = false);
                    }
                  },
                  onShowAll: () {
                    setState(() => _showAllDepartments = true);
                    _deptFocusNode.requestFocus();
                  },
                  validator: (v) => (v == null || v.trim().isEmpty)
                      ? 'Department is required'
                      : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _positionCtrl,
                  decoration: const InputDecoration(labelText: 'Position'),
                  validator: (v) => (v == null || v.trim().isEmpty)
                      ? 'Position is required'
                      : null,
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _shift,
                  decoration: const InputDecoration(labelText: 'Default shift'),
                  items: [
                    for (final shift in _shiftOptions)
                      DropdownMenuItem(
                        value: shift,
                        child: Text(shift.replaceAll('_', ' ')),
                      ),
                  ],
                  onChanged: (value) {
                    if (value != null) setState(() => _shift = value);
                  },
                ),
                if (!isEdit) ...[
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _passwordCtrl,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'Temporary password',
                    ),
                    validator: (v) => (v == null || v.trim().length < 6)
                        ? 'Use at least 6 characters'
                        : null,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(s.actionCancel),
        ),
        ElevatedButton(
          onPressed: _submitting ? null : _submit,
          child: Text(_submitting ? s.profileSavingButton : s.actionSave),
        ),
      ],
    );
  }
}

class _DepartmentAutocompleteField extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final String label;
  final List<String> options;
  final bool showAllOptions;
  final ValueChanged<String> onChanged;
  final VoidCallback onShowAll;
  final FormFieldValidator<String>? validator;

  const _DepartmentAutocompleteField({
    required this.controller,
    required this.focusNode,
    required this.label,
    required this.options,
    required this.showAllOptions,
    required this.onChanged,
    required this.onShowAll,
    this.validator,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return RawAutocomplete<String>(
          textEditingController: controller,
          focusNode: focusNode,
          displayStringForOption: (option) => option,
          optionsBuilder: (textEditingValue) {
            return filterStaffDepartmentOptions(
              options: options,
              query: textEditingValue.text,
              showAllOptions: showAllOptions,
            );
          },
          onSelected: (selection) {
            controller.text = selection;
            onChanged(selection);
          },
          fieldViewBuilder:
              (context, textController, fieldFocusNode, onFieldSubmitted) {
                return TextFormField(
                  controller: textController,
                  focusNode: fieldFocusNode,
                  decoration: InputDecoration(
                    labelText: label,
                    suffixIcon: IconButton(
                      tooltip: 'Show department options',
                      icon: const Icon(Icons.arrow_drop_down),
                      onPressed: onShowAll,
                    ),
                  ),
                  onChanged: onChanged,
                  validator: validator,
                );
              },
          optionsViewBuilder: (context, onSelected, availableOptions) {
            final optionList = availableOptions.toList(growable: false);
            return Align(
              alignment: Alignment.topLeft,
              child: Material(
                elevation: 6,
                borderRadius: BorderRadius.circular(8),
                clipBehavior: Clip.antiAlias,
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: 260,
                    maxWidth: constraints.maxWidth,
                    minWidth: constraints.maxWidth,
                  ),
                  child: ListView.separated(
                    padding: EdgeInsets.zero,
                    shrinkWrap: true,
                    itemCount: optionList.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final option = optionList[index];
                      final highlighted =
                          AutocompleteHighlightedOption.of(context) == index;
                      final selected = controller.text == option;
                      return InkWell(
                        onTap: () => onSelected(option),
                        child: Container(
                          color: highlighted
                              ? AppTheme.primaryBlue.withValues(alpha: 0.08)
                              : null,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 14,
                            vertical: 12,
                          ),
                          child: Row(
                            children: [
                              Expanded(child: Text(option)),
                              if (selected)
                                const Icon(
                                  Icons.check,
                                  size: 18,
                                  color: AppTheme.primaryBlue,
                                ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }
}

class _StaffRoleOption {
  final String value;
  final String label;
  const _StaffRoleOption(this.value, this.label);
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
            AppStrings.of(context).staffMgmtListApiUnavailable,
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
            hasSearch ? s.staffMgmtNoStaffFound : s.staffMgmtNoStaffMembers,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            hasSearch ? s.staffMgmtSearchEmpty : s.staffMgmtApiPending,
            textAlign: TextAlign.center,
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }
}
