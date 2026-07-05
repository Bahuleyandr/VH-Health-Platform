import 'package:flutter/material.dart';

import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class HousekeepingCommandScreen extends StatefulWidget {
  const HousekeepingCommandScreen({super.key});

  @override
  State<HousekeepingCommandScreen> createState() =>
      _HousekeepingCommandScreenState();
}

class _HousekeepingCommandScreenState extends State<HousekeepingCommandScreen> {
  final _reasonController = TextEditingController();

  bool _loading = true;
  bool _saving = false;
  bool _reassignOpenRequests = true;
  String? _error;
  int? _selectedStaffId;
  int? _selectedZoneId;

  List<Map<String, dynamic>> _zones = [];
  List<Map<String, dynamic>> _staff = [];
  List<Map<String, dynamic>> _assignments = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  int? _asInt(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }

  String _asText(dynamic value, {String fallback = '-'}) {
    final text = value?.toString().trim();
    return text == null || text.isEmpty ? fallback : text;
  }

  List<Map<String, dynamic>> _asMapList(dynamic value) {
    if (value is! List) return [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }

    try {
      final data = await HrApiService.getHousekeepingDelegationOverview();
      final zones = _asMapList(data['zones']);
      final staff = _asMapList(data['staff']);
      if (!mounted) return;
      setState(() {
        _zones = zones;
        _staff = staff;
        _assignments = _asMapList(data['assignments']);
        _selectedZoneId ??= zones.isNotEmpty ? _asInt(zones.first['id']) : null;
        _selectedStaffId ??= staff.isNotEmpty
            ? _asInt(staff.first['id'])
            : null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _delegateStaff() async {
    if (_selectedStaffId == null || _selectedZoneId == null) return;
    setState(() => _saving = true);
    try {
      await HrApiService.delegateHousekeepingStaff(
        staffId: _selectedStaffId!,
        zoneId: _selectedZoneId,
        reason: _reasonController.text.trim().isEmpty
            ? null
            : _reasonController.text.trim(),
        isTemporary: true,
        closeExisting: true,
        reassignUnassignedRequests: _reassignOpenRequests,
      );
      _reasonController.clear();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.housekeeping_command.housekeeping_staff_delegated',
          ),
          backgroundColor: AppTheme.successGreen,
        ),
      );
      await _load();
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

  Future<void> _endAssignment(Map<String, dynamic> assignment) async {
    final id = _asInt(assignment['id']);
    if (id == null) return;

    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const AppText('s4.lib.housekeeping_command.end_assignment'),
        content: AppText(
          's4.dynamic.housekeeping_command.end_assignment_body',
          values: {
            'staff': _asText(
              assignment['staff_name'],
              fallback: AppStrings.of(
                context,
              ).lookup('s4.lib.housekeeping_command.this_staff_member'),
            ),
          },
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const AppText('action.cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const AppText('s4.lib.housekeeping_command.end'),
          ),
        ],
      ),
    );

    if (ok != true) return;
    setState(() => _saving = true);
    try {
      await HrApiService.endHousekeepingAssignment(
        assignmentId: id,
        reason: 'Ended from command console',
      );
      await _load();
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
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: const AppText(
          's4.lib.housekeeping_command.housekeeping_command',
        ),
        actions: [
          IconButton(
            tooltip: AppStrings.of(context).lookup('action.refresh'),
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading && _zones.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null) _ErrorBanner(error: _error!),
                  _DelegationPanel(
                    staff: _staff,
                    zones: _zones,
                    selectedStaffId: _selectedStaffId,
                    selectedZoneId: _selectedZoneId,
                    reasonController: _reasonController,
                    reassignOpenRequests: _reassignOpenRequests,
                    saving: _saving,
                    onStaffChanged: (id) => setState(() {
                      _selectedStaffId = id;
                    }),
                    onZoneChanged: (id) => setState(() {
                      _selectedZoneId = id;
                    }),
                    onReassignChanged: (value) => setState(() {
                      _reassignOpenRequests = value;
                    }),
                    onDelegate: _delegateStaff,
                    asInt: _asInt,
                    asText: _asText,
                  ),
                  const SizedBox(height: 16),
                  _SectionTitle(
                    icon: Icons.map_outlined,
                    title: AppStrings.of(
                      context,
                    ).lookup('s4.lib.housekeeping_command.zone_workload'),
                    count: _zones.length,
                  ),
                  const SizedBox(height: 8),
                  ..._zones.map(
                    (zone) => _ZoneWorkloadCard(
                      zone: zone,
                      asInt: _asInt,
                      asText: _asText,
                    ),
                  ),
                  const SizedBox(height: 16),
                  _SectionTitle(
                    icon: Icons.assignment_ind_outlined,
                    title: AppStrings.of(
                      context,
                    ).lookup('s4.lib.housekeeping_command.active_assignments'),
                    count: _assignments.length,
                  ),
                  const SizedBox(height: 8),
                  if (_assignments.isEmpty)
                    _EmptyCard(
                      icon: Icons.cleaning_services_outlined,
                      text: AppStrings.of(context).lookup(
                        's4.lib.housekeeping_command.no_active_floor_assignments_yet',
                      ),
                    )
                  else
                    ..._assignments.map(
                      (assignment) => _AssignmentCard(
                        assignment: assignment,
                        saving: _saving,
                        onEnd: () => _endAssignment(assignment),
                        asText: _asText,
                      ),
                    ),
                ],
              ),
            ),
    );
  }
}

class _DelegationPanel extends StatelessWidget {
  final List<Map<String, dynamic>> staff;
  final List<Map<String, dynamic>> zones;
  final int? selectedStaffId;
  final int? selectedZoneId;
  final TextEditingController reasonController;
  final bool reassignOpenRequests;
  final bool saving;
  final ValueChanged<int?> onStaffChanged;
  final ValueChanged<int?> onZoneChanged;
  final ValueChanged<bool> onReassignChanged;
  final VoidCallback onDelegate;
  final int? Function(dynamic value) asInt;
  final String Function(dynamic value, {String fallback}) asText;

  const _DelegationPanel({
    required this.staff,
    required this.zones,
    required this.selectedStaffId,
    required this.selectedZoneId,
    required this.reasonController,
    required this.reassignOpenRequests,
    required this.saving,
    required this.onStaffChanged,
    required this.onZoneChanged,
    required this.onReassignChanged,
    required this.onDelegate,
    required this.asInt,
    required this.asText,
  });

  @override
  Widget build(BuildContext context) {
    final canSubmit = selectedStaffId != null && selectedZoneId != null;
    final s = AppStrings.of(context);
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.supervisor_account,
                  color: AppTheme.primaryTeal,
                ),
                const SizedBox(width: 8),
                AppText(
                  's4.lib.housekeeping_command.redeploy_staff',
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int>(
              initialValue: selectedStaffId,
              decoration: InputDecoration(
                labelText: AppStrings.of(
                  context,
                ).lookup('s4.lib.housekeeping_command.staff_member'),
                prefixIcon: const Icon(Icons.person_search_outlined),
              ),
              items: staff
                  .map(
                    (row) => DropdownMenuItem<int>(
                      value: asInt(row['id']),
                      child: Text(
                        s.format('s4.dynamic.housekeeping.staff_employee_id', {
                          'name': asText(row['name']),
                          'employeeId': asText(
                            row['employee_id'],
                            fallback: s.lookup(
                              's4.lib.housekeeping_command.no_id',
                            ),
                          ),
                        }),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  )
                  .toList(),
              onChanged: saving ? null : onStaffChanged,
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int>(
              initialValue: selectedZoneId,
              decoration: InputDecoration(
                labelText: AppStrings.of(
                  context,
                ).lookup('s4.lib.housekeeping_command.floor_or_zone'),
                prefixIcon: const Icon(Icons.location_on_outlined),
              ),
              items: zones
                  .map(
                    (row) => DropdownMenuItem<int>(
                      value: asInt(row['id']),
                      child: Text(
                        s.format('s4.dynamic.housekeeping.zone_floor_label', {
                          'name': asText(row['name']),
                          'floor': asText(row['floor']),
                        }),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  )
                  .toList(),
              onChanged: saving ? null : onZoneChanged,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: reasonController,
              maxLines: 2,
              decoration: InputDecoration(
                labelText: AppStrings.of(
                  context,
                ).lookup('drug_chart.stop_reason_label'),
                prefixIcon: const Icon(Icons.edit_note_outlined),
              ),
            ),
            const SizedBox(height: 8),
            SwitchListTile.adaptive(
              value: reassignOpenRequests,
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: AppText(
                's4.lib.housekeeping_command.move_open_requests_in_this_zone',
                style: TextStyle(color: AppTheme.textPrimary),
              ),
              subtitle: AppText(
                's4.lib.housekeeping_command.useful_when_one_floor_has_more_work_than_another',
                style: TextStyle(color: AppTheme.textSecondary),
              ),
              onChanged: saving ? null : onReassignChanged,
            ),
            const SizedBox(height: 8),
            FilledButton.icon(
              onPressed: saving || !canSubmit ? null : onDelegate,
              icon: saving
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.swap_horiz),
              label: const AppText(
                's4.lib.housekeeping_command.delegate_staff',
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ZoneWorkloadCard extends StatelessWidget {
  final Map<String, dynamic> zone;
  final int? Function(dynamic value) asInt;
  final String Function(dynamic value, {String fallback}) asText;

  const _ZoneWorkloadCard({
    required this.zone,
    required this.asInt,
    required this.asText,
  });

  @override
  Widget build(BuildContext context) {
    final active = asInt(zone['active_requests']) ?? 0;
    final urgent = asInt(zone['urgent_requests']) ?? 0;
    final high = asInt(zone['high_requests']) ?? 0;
    final s = AppStrings.of(context);
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    asText(zone['name']),
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                _MetricPill(
                  label: s.format('s4.dynamic.housekeeping.open_count', {
                    'count': active,
                  }),
                  color: active > 0
                      ? AppTheme.primaryBlue
                      : AppTheme.textSecondary,
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              s.format('s4.dynamic.housekeeping.building_floor_label', {
                'building': asText(
                  zone['building'],
                  fallback: s.lookup(
                    's4.lib.housekeeping_command.building_not_set',
                  ),
                ),
                'floor': asText(zone['floor']),
              }),
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _MetricPill(
                  label: s.format('s4.dynamic.housekeeping.urgent_count', {
                    'count': urgent,
                  }),
                  color: AppTheme.errorOnSurface,
                ),
                _MetricPill(
                  label: s.format('s4.dynamic.housekeeping.high_count', {
                    'count': high,
                  }),
                  color: AppTheme.warningOnSurface,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _AssignmentCard extends StatelessWidget {
  final Map<String, dynamic> assignment;
  final bool saving;
  final VoidCallback onEnd;
  final String Function(dynamic value, {String fallback}) asText;

  const _AssignmentCard({
    required this.assignment,
    required this.saving,
    required this.onEnd,
    required this.asText,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              height: 42,
              width: 42,
              decoration: BoxDecoration(
                color: AppTheme.primaryTeal.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Icon(
                Icons.badge_outlined,
                color: AppTheme.primaryTeal,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    asText(assignment['staff_name']),
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    s.format('s4.dynamic.housekeeping.zone_floor_label', {
                      'name': asText(
                        assignment['current_zone_name'] ??
                            assignment['zone_name'],
                      ),
                      'floor': asText(assignment['floor']),
                    }),
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    s.format('s4.dynamic.housekeeping.shift_label', {
                      'shift': asText(
                        assignment['shift_label'],
                        fallback: s.lookup(
                          's4.lib.housekeeping_command.current_shift',
                        ),
                      ),
                    }),
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                ],
              ),
            ),
            TextButton.icon(
              onPressed: saving ? null : onEnd,
              icon: const Icon(Icons.close),
              label: const AppText('s4.lib.housekeeping_command.end'),
            ),
          ],
        ),
      ),
    );
  }
}

class _MetricPill extends StatelessWidget {
  final String label;
  final Color color;

  const _MetricPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        border: Border.all(color: color.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final IconData icon;
  final String title;
  final int count;

  const _SectionTitle({
    required this.icon,
    required this.title,
    required this.count,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: AppTheme.primaryBlue, size: 20),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            title,
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontSize: 18,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        _MetricPill(label: count.toString(), color: AppTheme.primaryBlue),
      ],
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String error;

  const _ErrorBanner({required this.error});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.errorOnSurface.withValues(alpha: 0.12),
        border: Border.all(
          color: AppTheme.errorOnSurface.withValues(alpha: 0.4),
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: AppTheme.errorOnSurface),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              error,
              style: TextStyle(color: AppTheme.errorOnSurface),
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyCard extends StatelessWidget {
  final IconData icon;
  final String text;

  const _EmptyCard({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Row(
          children: [
            Icon(icon, color: AppTheme.textSecondary),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                text,
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
