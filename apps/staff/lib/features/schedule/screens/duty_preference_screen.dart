import 'package:flutter/material.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class DutyPreferenceScreen extends StatefulWidget {
  const DutyPreferenceScreen({super.key});

  @override
  State<DutyPreferenceScreen> createState() => _DutyPreferenceScreenState();
}

class _DutyPreferenceScreenState extends State<DutyPreferenceScreen> {
  static const _departmentLabelKeys = <String, String>{
    'medical': 'role.roster_department.medical',
    'nursing': 'role.roster_department.nursing',
    'op_nursing': 'role.roster_department.op_nursing',
    'ot_nursing': 'role.roster_department.ot_nursing',
    'cath_lab': 'role.roster_department.cath_lab',
    'pharmacy': 'role.roster_department.pharmacy',
    'stores_purchase': 'role.roster_department.stores_purchase',
    'housekeeping': 'role.roster_department.housekeeping',
    'reception': 'role.roster_department.reception',
    'billing': 'role.roster_department.billing',
    'ambulance': 'role.roster_department.ambulance',
    'maintenance': 'role.roster_department.maintenance',
  };
  static const _periods = ['day', 'week', 'month'];
  static const _shifts = ['Morning', 'Afternoon', 'Night', 'Any'];

  bool _loading = true;
  bool _saving = false;
  StaffRole _role = StaffRole.general;
  String? _department;
  String _period = 'day';
  String _shift = 'Morning';
  DateTime _startDate = DateTime.now().add(const Duration(days: 1));
  DateTime _endDate = DateTime.now().add(const Duration(days: 1));
  final _reasonController = TextEditingController();
  List<Map<String, dynamic>> _requests = [];

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

  String _dateText(DateTime date) {
    final y = date.year.toString().padLeft(4, '0');
    final m = date.month.toString().padLeft(2, '0');
    final d = date.day.toString().padLeft(2, '0');
    return '$y-$m-$d';
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

  String _departmentLabel(AppStrings s) {
    final department = _department;
    if (department == null) {
      return s.lookup('role.roster_department.not_configured');
    }
    return s.lookup(
      _departmentLabelKeys[department] ??
          StaffRole.rosterDepartmentLabelKeyFor(department),
    );
  }

  String _requestDepartmentLabel(AppStrings s, dynamic value) {
    final department = _asText(value);
    final key = _departmentLabelKeys[department];
    return key == null ? department : s.lookup(key);
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final role = StaffRole.fromString(await ApiConfig.getRole());
    try {
      final rows = await HrApiService.getMyRosterPreferenceRequests();
      if (!mounted) return;
      setState(() {
        _role = role;
        _department = role.rosterDepartment;
        _requests = _asMapList(rows);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _role = role;
        _department = role.rosterDepartment;
        _requests = [];
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickDate({required bool end}) async {
    final picked = await showDatePicker(
      context: context,
      initialDate: end ? _endDate : _startDate,
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 180)),
    );
    if (picked == null) return;
    setState(() {
      if (end) {
        _endDate = picked.isBefore(_startDate) ? _startDate : picked;
      } else {
        _startDate = picked;
        if (_period == 'day' || _endDate.isBefore(_startDate)) {
          _endDate = _startDate;
        }
      }
    });
  }

  void _setPeriod(String period) {
    setState(() {
      _period = period;
      if (_period == 'day' || _endDate.isBefore(_startDate)) {
        _endDate = _startDate;
      }
    });
  }

  Future<void> _submit() async {
    final s = AppStrings.of(context);
    final department = _department;
    if (department == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            s.format('s4.dynamic.duty_preference.not_configured_for_role', {
              'role': s.lookup(_role.displayNameKey),
            }),
          ),
          backgroundColor: AppTheme.errorRed,
        ),
      );
      return;
    }
    setState(() => _saving = true);
    try {
      final endDate = _period == 'day' ? _startDate : _endDate;
      await HrApiService.createRosterPreferenceRequest(
        department: department,
        requestedStartDate: _dateText(_startDate),
        requestedEndDate: _dateText(endDate),
        periodType: _period,
        shiftLabel: _shift == 'Any' ? null : _shift,
        reason: _reasonController.text.trim(),
      );
      _reasonController.clear();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.duty_preference.duty_request_submitted'),
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

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: const AppText('s4.lib.duty_preference.duty_request'),
        actions: [
          IconButton(
            tooltip: AppStrings.of(context).lookup('action.refresh'),
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              color: AppTheme.cardSurface,
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AppText(
                      's4.lib.duty_preference.request_preferred_duty',
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 12),
                    InputDecorator(
                      decoration: InputDecoration(
                        labelText: AppStrings.of(
                          context,
                        ).lookup('profile.field.department'),
                        prefixIcon: const Icon(Icons.apartment_outlined),
                      ),
                      child: Text(
                        _departmentLabel(s),
                        style: TextStyle(
                          color: _department == null
                              ? AppTheme.errorRed
                              : AppTheme.textPrimary,
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 8,
                      children: _periods
                          .map(
                            (period) => ChoiceChip(
                              label: Text(period.toUpperCase()),
                              selected: _period == period,
                              onSelected: _saving
                                  ? null
                                  : (_) => _setPeriod(period),
                            ),
                          )
                          .toList(),
                    ),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 8,
                      children: _shifts
                          .map(
                            (shift) => ChoiceChip(
                              label: Text(shift),
                              selected: _shift == shift,
                              onSelected: _saving
                                  ? null
                                  : (_) => setState(() => _shift = shift),
                            ),
                          )
                          .toList(),
                    ),
                    const SizedBox(height: 12),
                    if (_period == 'day')
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          onPressed: _saving
                              ? null
                              : () => _pickDate(end: false),
                          icon: const Icon(Icons.event_outlined),
                          label: Text(
                            s.format('s4.dynamic.duty_preference.date_label', {
                              'date': _dateText(_startDate),
                            }),
                          ),
                        ),
                      )
                    else
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: _saving
                                  ? null
                                  : () => _pickDate(end: false),
                              icon: const Icon(Icons.event_outlined),
                              label: Text(
                                s.format(
                                  's4.dynamic.duty_preference.from_label',
                                  {'date': _dateText(_startDate)},
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: _saving
                                  ? null
                                  : () => _pickDate(end: true),
                              icon: const Icon(Icons.event_available_outlined),
                              label: Text(
                                s.format(
                                  's4.dynamic.duty_preference.to_label',
                                  {'date': _dateText(_endDate)},
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _reasonController,
                      maxLines: 3,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(
                          context,
                        ).lookup('drug_chart.stop_reason_label'),
                        prefixIcon: const Icon(Icons.notes_outlined),
                      ),
                    ),
                    const SizedBox(height: 14),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: _saving ? null : _submit,
                        icon: _saving
                            ? const SizedBox(
                                height: 18,
                                width: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.send_outlined),
                        label: const AppText(
                          's4.lib.duty_preference.submit_request',
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            AppText(
              's4.lib.duty_preference.my_requests',
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 8),
            if (_loading)
              const Center(child: CircularProgressIndicator())
            else if (_requests.isEmpty)
              Card(
                color: AppTheme.cardSurface,
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: AppText(
                    's4.lib.duty_preference.no_duty_requests_yet',
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                ),
              )
            else
              ..._requests.map(
                (request) => Card(
                  color: AppTheme.cardSurface,
                  child: ListTile(
                    leading: const Icon(
                      Icons.how_to_reg_outlined,
                      color: AppTheme.primaryBlue,
                    ),
                    title: Text(
                      s.format('s4.dynamic.duty_preference.request_row_title', {
                        'department': _requestDepartmentLabel(
                          s,
                          request['department'],
                        ),
                        'shift': _asText(
                          request['shift_label'],
                          fallback: s.lookup(
                            's4.lib.duty_preference.any_shift',
                          ),
                        ),
                      }),
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    subtitle: Text(
                      '${_asText(request['requested_start_date'])} to ${_asText(request['requested_end_date'])}',
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                    trailing: _StatusPill(
                      label: _asText(request['status']),
                      color: _asText(request['status']) == 'approved'
                          ? AppTheme.successOnSurface
                          : AppTheme.warningOnSurface,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusPill({required this.label, required this.color});

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
