import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/navigation/ip_command_board_routes.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/ward_list_filter_bar.dart';
import '../../../l10n/app_strings.dart';

const String admissionAllWards = '';
const String admissionActiveStatus = 'active';
const String admissionDischargedStatus = 'discharged';

List<WardListFilterOption> admissionWardFilterOptions(
  List<Map<String, dynamic>> rows, {
  required String allWardsLabel,
}) {
  final byValue = <String, String>{};
  for (final row in rows) {
    final value = _admissionText(
      row['name'] ?? row['ward'] ?? row['ward_name'],
    );
    if (value.isEmpty) continue;
    final label = _admissionText(row['label']);
    byValue.putIfAbsent(value, () => label.isEmpty ? value : label);
  }
  final options = byValue.entries.toList()
    ..sort((a, b) => a.value.toLowerCase().compareTo(b.value.toLowerCase()));
  return [
    WardListFilterOption(value: admissionAllWards, label: allWardsLabel),
    for (final option in options)
      WardListFilterOption(value: option.key, label: option.value),
  ];
}

List<WardListFilterOption> admissionStatusFilterOptions({
  required String activeLabel,
  required String dischargedLabel,
}) {
  return [
    WardListFilterOption(value: admissionActiveStatus, label: activeLabel),
    WardListFilterOption(
      value: admissionDischargedStatus,
      label: dischargedLabel,
    ),
  ];
}

String? admissionStatusQueryValue(String statusValue) {
  return statusValue == admissionDischargedStatus
      ? admissionDischargedStatus
      : null;
}

List<Map<String, dynamic>> filterAdmissionRows(
  List<Map<String, dynamic>> rows, {
  String wardValue = admissionAllWards,
  String statusValue = admissionActiveStatus,
}) {
  final ward = wardValue.trim().toLowerCase();
  final status = statusValue.trim().toLowerCase();
  return rows.where((row) {
    if (ward.isNotEmpty && _admissionText(row['ward']).toLowerCase() != ward) {
      return false;
    }
    if (status == admissionDischargedStatus) {
      return _admissionText(row['status']).toLowerCase() ==
          admissionDischargedStatus;
    }
    return _admissionText(row['status']).toLowerCase() !=
        admissionDischargedStatus;
  }).toList();
}

String _admissionText(Object? value) => (value ?? '').toString().trim();

/// EMR Admissions screen — list active admissions, admit patients, view details.
class AdmissionScreen extends StatefulWidget {
  const AdmissionScreen({super.key});

  @override
  State<AdmissionScreen> createState() => _AdmissionScreenState();
}

class _AdmissionScreenState extends State<AdmissionScreen> {
  List<Map<String, dynamic>> _admissions = [];
  bool _loading = true;
  bool _loadingMore = false;
  String? _error;
  int _page = 1;
  int _totalAdmissions = 0;
  Map<String, dynamic> _scope = const {};
  String _selectedWardValue = admissionAllWards;
  String _selectedAdmissionStatus = admissionActiveStatus;
  List<WardListFilterOption> _wardOptions = const [];
  static const int _pageSize = 100;

  @override
  void initState() {
    super.initState();
    _loadWardOptions();
    _loadAdmissions();
  }

  Future<void> _loadWardOptions() async {
    try {
      final rows = await MedicalApiService.getAdmissionWardOptions();
      if (!mounted) return;
      final s = AppStrings.of(context);
      setState(
        () => _wardOptions = admissionWardFilterOptions(
          rows,
          allWardsLabel: _allWardsLabel(s),
        ),
      );
    } catch (_) {
      // The admission list itself still carries ward names; fall back to them.
    }
  }

  Future<void> _loadAdmissions({bool append = false}) async {
    setState(() {
      if (append) {
        _loadingMore = true;
      } else {
        _loading = true;
        _page = 1;
      }
      _error = null;
    });
    try {
      final pageToLoad = append ? _page + 1 : 1;
      final data = await MedicalApiService.getActiveAdmissions(
        page: pageToLoad,
        limit: _pageSize,
        ward: _selectedWardValue == admissionAllWards
            ? null
            : _selectedWardValue,
        status: admissionStatusQueryValue(_selectedAdmissionStatus),
      );
      final list = _listFromAdmissions(data);
      final total =
          _paginationTotal(data) ?? (append ? _totalAdmissions : list.length);
      setState(() {
        _page = pageToLoad;
        _admissions = append ? [..._admissions, ...list] : list;
        _totalAdmissions = total;
        _scope = _mapFrom(data['scope']);
        if (_wardOptions.length <= 1 &&
            _selectedWardValue == admissionAllWards) {
          _wardOptions = admissionWardFilterOptions(
            list,
            allWardsLabel: _allWardsLabel(AppStrings.of(context)),
          );
        }
        _loading = false;
        _loadingMore = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
        _loadingMore = false;
      });
    }
  }

  List<Map<String, dynamic>> _listFromAdmissions(Map<String, dynamic> data) {
    dynamic value = data['admissions'] ?? data['data'] ?? data['items'];
    if (value is Map) {
      value = value['admissions'] ?? value['items'] ?? value['data'];
    }
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  int? _paginationTotal(Map<String, dynamic> data) {
    final pagination = data['pagination'];
    if (pagination is! Map) return null;
    final total = pagination['total'] ?? pagination['totalItems'];
    if (total is int) return total;
    return int.tryParse('$total');
  }

  bool get _hasMoreAdmissions =>
      _totalAdmissions > 0 && _admissions.length < _totalAdmissions;

  bool get _hasActiveAdmissionFilters =>
      _selectedWardValue != admissionAllWards ||
      _selectedAdmissionStatus != admissionActiveStatus;

  String _allWardsLabel(AppStrings s) => s.lookup('s4.lib.admission.all_wards');

  List<WardListFilterOption> _localizedWardOptions(AppStrings s) {
    final allWardsLabel = _allWardsLabel(s);
    if (_wardOptions.isEmpty) {
      return [
        WardListFilterOption(value: admissionAllWards, label: allWardsLabel),
      ];
    }
    return [
      for (final option in _wardOptions)
        option.value == admissionAllWards
            ? WardListFilterOption(
                value: admissionAllWards,
                label: allWardsLabel,
              )
            : option,
    ];
  }

  List<WardListFilterOption> _localizedStatusOptions(AppStrings s) {
    return admissionStatusFilterOptions(
      activeLabel: s.lookup('s4.lib.admission.status_active'),
      dischargedLabel: s.lookup('s4.lib.admission.status_discharged'),
    );
  }

  Map<String, dynamic> _mapFrom(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return <String, dynamic>{};
  }

  String _text(dynamic value, [String fallback = '']) {
    final text = (value ?? '').toString().trim();
    return text.isEmpty ? fallback : text;
  }

  String get _scopeLabel {
    final s = AppStrings.of(context);
    final type = _text(_scope['type']);
    switch (type) {
      case 'full':
        return s.lookup('s4.lib.admission.scope_all_active_inpatients');
      case 'own_patients':
        return s.lookup('s4.lib.admission.scope_assigned_to_you');
      case 'duty_doctor':
        return s.lookup('s4.lib.admission.scope_duty_floor');
      case 'ward_nursing':
        return s.lookup('s4.lib.admission.scope_nursing_floor');
      case 'housekeeping':
        return s.lookup('s4.lib.admission.scope_housekeeping_area');
      default:
        return s.lookup('s4.lib.admission.scope_role_based');
    }
  }

  String get _scopeDetail {
    final s = AppStrings.of(context);
    final wards = _scope['wards'];
    if (wards is List && wards.isNotEmpty) {
      return wards
          .map((ward) => _text(ward))
          .where((ward) => ward.isNotEmpty)
          .join(', ');
    }
    final floors = _scope['floors'];
    if (floors is List && floors.isNotEmpty) {
      return s.format('s4.dynamic.admission.floors', {
        'floors': floors.join(', '),
      });
    }
    return _text(_scope['source']).replaceAll('_', ' ');
  }

  Color _priorityColor(String? priority) {
    switch (priority?.toLowerCase()) {
      case 'critical':
      case 'emergency':
        return AppTheme.errorRed;
      case 'urgent':
        return AppTheme.warningAmber;
      case 'routine':
        return AppTheme.successGreen;
      default:
        return AppTheme.textSecondary;
    }
  }

  Widget _statusBadge(String? status, AppStrings s) {
    Color bg;
    Color fg;
    switch (status?.toLowerCase()) {
      case 'admitted':
        bg = AppTheme.primaryBlue.withValues(alpha: 0.12);
        fg = AppTheme.primaryBlue;
        break;
      case 'discharged':
        bg = AppTheme.successGreen.withValues(alpha: 0.12);
        fg = AppTheme.successGreen;
        break;
      case 'transferred':
        bg = AppTheme.warningAmber.withValues(alpha: 0.12);
        fg = AppTheme.warningAmber;
        break;
      default:
        bg = AppTheme.textSecondary.withValues(alpha: 0.12);
        fg = AppTheme.textSecondary;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        status?.toUpperCase() ?? s.lookup('s4.lib.admission.status_unknown'),
        style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w600),
      ),
    );
  }

  Widget _buildScopeSummary(ThemeData theme, AppStrings s) {
    final showing = _admissions.length;
    final total = _totalAdmissions > 0 ? _totalAdmissions : showing;
    final detail = _scopeDetail;
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: AppTheme.primaryBlue.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Icon(
                Icons.security_outlined,
                color: AppTheme.primaryBlue,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.format('s4.dynamic.admission.showing_inpatients', {
                      'showing': showing,
                      'total': total,
                    }),
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    detail.isEmpty
                        ? _scopeLabel
                        : s.format('s4.dynamic.admission.scope_with_detail', {
                            'scope': _scopeLabel,
                            'detail': detail,
                          }),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showAdmitPatientSheet() {
    final formKey = GlobalKey<FormState>();
    final patientSearch = TextEditingController();
    final chiefComplaint = TextEditingController();
    final diagnosis = TextEditingController();
    final ward = TextEditingController();
    final bed = TextEditingController();
    final doctorsFuture = ScheduleApiService.getAppointmentDoctors();
    String priority = 'Routine';
    String codeStatus = 'Full Code';
    String? selectedDoctorUid;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          final theme = Theme.of(ctx);
          return Container(
            padding: EdgeInsets.only(
              bottom: MediaQuery.of(ctx).viewInsets.bottom,
            ),
            decoration: BoxDecoration(
              color: theme.colorScheme.surface,
              borderRadius: const BorderRadius.vertical(
                top: Radius.circular(20),
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Form(
                key: formKey,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Center(
                        child: Container(
                          width: 40,
                          height: 4,
                          decoration: BoxDecoration(
                            color: AppTheme.divider,
                            borderRadius: BorderRadius.circular(2),
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(
                        AppStrings.of(ctx).admissionAdmitPatient,
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w600,
                          color: theme.colorScheme.onSurface,
                        ),
                      ),
                      const SizedBox(height: 20),
                      TextFormField(
                        controller: patientSearch,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(ctx).admissionPatientLabel,
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.search),
                          ),
                          border: const OutlineInputBorder(),
                        ),
                        validator: (v) => (v == null || v.isEmpty)
                            ? AppStrings.of(ctx).admissionRequired
                            : null,
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: chiefComplaint,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(ctx).admissionChiefComplaint,
                          border: const OutlineInputBorder(),
                        ),
                        maxLines: 2,
                        validator: (v) => (v == null || v.isEmpty)
                            ? AppStrings.of(ctx).admissionRequired
                            : null,
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: diagnosis,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(ctx).admissionDiagnosis,
                          border: const OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      FutureBuilder<List<Map<String, dynamic>>>(
                        future: doctorsFuture,
                        builder: (ctx, snapshot) {
                          final doctors = snapshot.data ?? const [];
                          return DropdownButtonFormField<String>(
                            initialValue: selectedDoctorUid,
                            decoration: InputDecoration(
                              labelText: AppStrings.of(context)
                                  .lookup('s4.lib.admission.admitting_doctor'),
                              prefixIcon: const Icon(
                                Icons.medical_services_outlined,
                              ),
                              border: const OutlineInputBorder(),
                            ),
                            items: doctors
                                .where(
                                  (doctor) => (doctor['uid']?.toString() ?? '')
                                      .isNotEmpty,
                                )
                                .map(
                                  (doctor) => DropdownMenuItem<String>(
                                    value: doctor['uid'].toString(),
                                    child: Text(
                                      [doctor['name'], doctor['department']]
                                          .where(
                                            (value) => (value?.toString() ?? '')
                                                .isNotEmpty,
                                          )
                                          .join(' - '),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                )
                                .toList(),
                            onChanged: (v) =>
                                setSheetState(() => selectedDoctorUid = v),
                            validator: (v) => (v == null || v.isEmpty)
                                ? AppStrings.of(ctx).lookup(
                                    's4.lib.admission.admitting_doctor_required',
                                  )
                                : null,
                          );
                        },
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              controller: ward,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(ctx).admissionWard,
                                border: const OutlineInputBorder(),
                              ),
                              validator: (v) => (v == null || v.isEmpty)
                                  ? AppStrings.of(ctx).admissionRequired
                                  : null,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              controller: bed,
                              decoration: InputDecoration(
                                labelText: AppStrings.of(ctx)
                                    .admissionBedNumber,
                                border: const OutlineInputBorder(),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: priority,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(ctx).admissionPriorityLabel,
                          border: const OutlineInputBorder(),
                        ),
                        items: [
                          DropdownMenuItem(
                            value: 'Routine',
                            child: Text(
                              AppStrings.of(ctx).admissionPriorityRoutine,
                            ),
                          ),
                          DropdownMenuItem(
                            value: 'Urgent',
                            child: Text(
                              AppStrings.of(ctx).admissionPriorityUrgent,
                            ),
                          ),
                          DropdownMenuItem(
                            value: 'Emergency',
                            child: Text(
                              AppStrings.of(ctx).admissionPriorityEmergency,
                            ),
                          ),
                          DropdownMenuItem(
                            value: 'Critical',
                            child: Text(
                              AppStrings.of(ctx).admissionPriorityCritical,
                            ),
                          ),
                        ],
                        onChanged: (v) =>
                            setSheetState(() => priority = v ?? priority),
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: codeStatus,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(ctx).admissionCodeStatus,
                          border: const OutlineInputBorder(),
                        ),
                        items: [
                          DropdownMenuItem(
                            value: 'Full Code',
                            child: Text(AppStrings.of(ctx).admissionCodeFull),
                          ),
                          DropdownMenuItem(
                            value: 'DNR',
                            child: Text(AppStrings.of(ctx).admissionCodeDnr),
                          ),
                          DropdownMenuItem(
                            value: 'DNR/DNI',
                            child: Text(AppStrings.of(ctx).admissionCodeDnrDni),
                          ),
                          DropdownMenuItem(
                            value: 'Comfort Care',
                            child: Text(
                              AppStrings.of(ctx).admissionCodeComfort,
                            ),
                          ),
                        ],
                        onChanged: (v) =>
                            setSheetState(() => codeStatus = v ?? codeStatus),
                      ),
                      const SizedBox(height: 20),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          onPressed: () => _submitAdmission(
                            formKey: formKey,
                            patientSearch: patientSearch.text,
                            admittingDoctorUid: selectedDoctorUid,
                            chiefComplaint: chiefComplaint.text,
                            diagnosis: diagnosis.text,
                            ward: ward.text,
                            bed: bed.text,
                            priority: priority,
                            codeStatus: codeStatus,
                          ),
                          icon: const Icon(Icons.local_hospital),
                          label: Text(AppStrings.of(ctx).admissionAdmitPatient),
                        ),
                      ),
                      const SizedBox(height: 12),
                    ],
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  String _apiPriority(String priority) {
    switch (priority.toLowerCase()) {
      case 'emergency':
      case 'critical':
        return 'emergent';
      case 'urgent':
        return 'urgent';
      default:
        return 'routine';
    }
  }

  String _apiCodeStatus(String codeStatus) {
    switch (codeStatus.toLowerCase()) {
      case 'dnr':
        return 'dnr';
      case 'dnr/dni':
        return 'dni';
      case 'comfort care':
        return 'comfort_care';
      default:
        return 'full_code';
    }
  }

  Future<void> _submitAdmission({
    required GlobalKey<FormState> formKey,
    required String patientSearch,
    required String? admittingDoctorUid,
    required String chiefComplaint,
    required String diagnosis,
    required String ward,
    required String bed,
    required String priority,
    required String codeStatus,
  }) async {
    if (!formKey.currentState!.validate()) return;
    Navigator.of(context).pop();

    try {
      await MedicalApiService.admitPatient({
        'patient_query': patientSearch,
        'admitting_doctor': admittingDoctorUid,
        'chief_complaint': chiefComplaint,
        'provisional_diagnosis': diagnosis,
        'ward': ward,
        'bed': bed,
        'priority': _apiPriority(priority),
        'code_status': _apiCodeStatus(codeStatus),
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).admissionAdmittedSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        unawaited(_loadAdmissions());
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(AppStrings.of(context).admissionFailed(e.toString())),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  void _showAdmissionDetail(Map<String, dynamic> admission) {
    final id = admission['id'];
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _AdmissionDetailSheet(admissionId: id is int ? id : 0),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.admissionTitle,
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showAdmitPatientSheet,
        backgroundColor: AppTheme.primaryBlue,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.person_add),
        label: Text(s.admissionAdmit),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.error_outline,
                    size: 48,
                    color: AppTheme.errorRed,
                  ),
                  const SizedBox(height: 12),
                  Text(_error!, textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: _loadAdmissions,
                    child: Text(s.admissionRetry),
                  ),
                ],
              ),
            )
          : Column(
              children: [
                WardListFilterBar(
                  keyPrefix: 'admissions',
                  wardOptions: _localizedWardOptions(s),
                  selectedWardValue: _selectedWardValue,
                  onWardChanged: (value) {
                    setState(() => _selectedWardValue = value);
                    _loadAdmissions();
                  },
                  filterLabel: s.lookup('s4.lib.admission.status_filter'),
                  filterOptions: _localizedStatusOptions(s),
                  selectedFilterValue: _selectedAdmissionStatus,
                  onFilterChanged: (value) {
                    setState(() => _selectedAdmissionStatus = value);
                    _loadAdmissions();
                  },
                  hasActiveFilters: _hasActiveAdmissionFilters,
                  onClear: () {
                    setState(() {
                      _selectedWardValue = admissionAllWards;
                      _selectedAdmissionStatus = admissionActiveStatus;
                    });
                    _loadAdmissions();
                  },
                ),
                Expanded(child: _buildAdmissionsBody(s)),
              ],
            ),
    );
  }

  Widget _buildAdmissionsBody(AppStrings s) {
    if (_admissions.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.bed, size: 64, color: AppTheme.divider),
            const SizedBox(height: 12),
            Text(
              _selectedAdmissionStatus == admissionDischargedStatus
                  ? s.lookup('s4.lib.admission.no_discharged')
                  : s.admissionNoActive,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadAdmissions,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _admissions.length + 1 + (_hasMoreAdmissions ? 1 : 0),
        itemBuilder: (ctx, i) {
          if (i == 0) return _buildScopeSummary(Theme.of(context), s);
          final admissionIndex = i - 1;
          if (admissionIndex >= _admissions.length) {
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Center(
                child: OutlinedButton.icon(
                  onPressed: _loadingMore
                      ? null
                      : () => _loadAdmissions(append: true),
                  icon: _loadingMore
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.expand_more),
                  label: Text(
                    _loadingMore
                        ? s.lookup('s4.lib.admission.loading_patients')
                        : s.lookup('s4.lib.admission.load_more_patients'),
                  ),
                ),
              ),
            );
          }
          final a = _admissions[admissionIndex];
          final bedNumber = a['bed_number'] ?? a['bed'];
          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: ListTile(
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 8,
              ),
              leading: CircleAvatar(
                backgroundColor: _priorityColor(a['priority'] as String?)
                    .withValues(alpha: 0.15),
                child: Icon(
                  Icons.local_hospital,
                  color: _priorityColor(a['priority'] as String?),
                ),
              ),
              title: Text(
                a['patient_name'] as String? ?? s.admissionPatientFallback,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${a['ward'] ?? ''} ${bedNumber != null ? s.format('s4.dynamic.admission.bed_inline', {'bed': bedNumber}) : ''}',
                    style: const TextStyle(fontSize: 13),
                  ),
                  if (a['chief_complaint'] != null)
                    Text(
                      a['chief_complaint'] as String,
                      style: TextStyle(
                        fontSize: 12,
                        color: AppTheme.textSecondary,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                ],
              ),
              trailing: _statusBadge(a['status'] as String?, s),
              onTap: () => _showAdmissionDetail(a),
            ),
          );
        },
      ),
    );
  }
}

// ─── Admission Detail Sheet ─────────────────────────────────────────────────

class _AdmissionDetailSheet extends StatefulWidget {
  final int admissionId;

  const _AdmissionDetailSheet({required this.admissionId});

  @override
  State<_AdmissionDetailSheet> createState() => _AdmissionDetailSheetState();
}

class _AdmissionDetailSheetState extends State<_AdmissionDetailSheet> {
  Map<String, dynamic>? _detail;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadDetail();
  }

  Future<void> _loadDetail() async {
    try {
      final data = await MedicalApiService.getAdmissionDetail(
        widget.admissionId,
      );
      setState(() {
        _detail = data;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Widget _infoRow(String label, String? value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
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
            child: Text(
              value ?? '-',
              style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  String? _firstText(List<dynamic> values) {
    for (final value in values) {
      if (value == null) continue;
      if (value is List) {
        if (value.isEmpty) continue;
        return value.map((item) => item.toString()).join(', ');
      }
      final text = value.toString().trim();
      if (text.isNotEmpty) return text;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.85,
      ),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: _loading
          ? const Center(
              child: Padding(
                padding: EdgeInsets.all(40),
                child: CircularProgressIndicator(),
              ),
            )
          : _error != null
          ? Padding(
              padding: const EdgeInsets.all(40),
              child: Center(child: Text(_error!)),
            )
          : SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(
                        color: AppTheme.divider,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    _firstText([_detail?['patient_name']]) ??
                        AppStrings.of(context).admissionPatientFallback,
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    AppStrings.of(context).admissionNumber(widget.admissionId),
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 13,
                    ),
                  ),
                  const Divider(height: 24),

                  // Patient Info
                  Text(
                    AppStrings.of(context).admissionPatientInformation,
                    style: const TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 8),
                  _infoRow(
                    AppStrings.of(context)
                        .lookup('s4.lib.admission.hospital_id'),
                    _firstText([
                      _detail?['patient_hospital_number'],
                      _detail?['hospital_number'],
                    ]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionUid,
                    _firstText([_detail?['patient_uid']]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionAgeGender,
                    _firstText([
                      _detail?['age_gender'],
                      [
                        _detail?['patient_age'],
                        _detail?['patient_gender'],
                      ].where((v) => _firstText([v]) != null).join(' / '),
                    ]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionBloodGroup,
                    _firstText([_detail?['blood_group']]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionAllergies,
                    _firstText([_detail?['allergies']]),
                  ),

                  const SizedBox(height: 16),
                  Text(
                    AppStrings.of(context).admissionDetails,
                    style: const TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 8),
                  _infoRow(
                    AppStrings.of(context).admissionWardField,
                    _firstText([
                      _detail?['ward'],
                      _detail?['bed_ward_name'],
                      _detail?['ward_name'],
                    ]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionBedField,
                    _firstText([
                      _detail?['bed_number'],
                      _detail?['bed'],
                      _detail?['bed_id'],
                    ]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionAdmittedOn,
                    _firstText([_detail?['admitted_at']]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionChiefComplaint,
                    _firstText([_detail?['chief_complaint']]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionDiagnosisField,
                    _firstText([
                      _detail?['provisional_diagnosis'],
                      _detail?['admitting_diagnosis'],
                    ]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionPriorityField,
                    _firstText([_detail?['priority']]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionCodeStatus,
                    _firstText([_detail?['code_status']]),
                  ),
                  _infoRow(
                    AppStrings.of(context).admissionAttending,
                    _firstText([
                      _detail?['attending_doctor_name'],
                      _detail?['admitting_doctor_name'],
                      _detail?['attending_doctor'],
                      _detail?['admitting_doctor'],
                    ]),
                  ),

                  const SizedBox(height: 16),
                  // Quick action buttons
                  Text(
                    AppStrings.of(context).admissionQuickActions,
                    style: const TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      ActionChip(
                        avatar: const Icon(Icons.monitor_heart, size: 18),
                        label: Text(
                          AppStrings.of(context).admissionActionVitals,
                        ),
                        onPressed: () {
                          Navigator.pop(context);
                          final uid = _detail?['patient_uid'] as String?;
                          final name = _detail?['patient_name'] as String?;
                          if (uid != null) {
                            context.push(
                              ipCommandBoardRoute(
                                patientUid: uid,
                                admissionId: widget.admissionId,
                                patientName: name,
                                action: 'vitals',
                              ),
                            );
                          }
                        },
                      ),
                      ActionChip(
                        avatar: const Icon(Icons.note_add, size: 18),
                        label: Text(
                          AppStrings.of(context).admissionActionNotes,
                        ),
                        onPressed: () {
                          Navigator.pop(context);
                          final uid = _detail?['patient_uid'] as String?;
                          final name = _detail?['patient_name'] as String?;
                          if (uid != null) {
                            context.push(
                              ipCommandBoardRoute(
                                patientUid: uid,
                                admissionId: widget.admissionId,
                                patientName: name,
                                action: 'notes',
                              ),
                            );
                          }
                        },
                      ),
                      ActionChip(
                        avatar: const Icon(Icons.receipt_long, size: 18),
                        label: Text(
                          AppStrings.of(context).admissionActionOrders,
                        ),
                        onPressed: () {
                          Navigator.pop(context);
                          final uid = _detail?['patient_uid'] as String?;
                          final name = _detail?['patient_name'] as String?;
                          if (uid != null) {
                            context.push(
                              ipCommandBoardRoute(
                                patientUid: uid,
                                admissionId: widget.admissionId,
                                patientName: name,
                                action: 'orders',
                              ),
                            );
                          }
                        },
                      ),
                      ActionChip(
                        avatar: const Icon(Icons.timeline, size: 18),
                        label: Text(
                          AppStrings.of(context).admissionActionTimeline,
                        ),
                        onPressed: () {
                          Navigator.pop(context);
                          final uid = _detail?['patient_uid'] as String?;
                          final name = _detail?['patient_name'] as String?;
                          if (uid != null) {
                            context.push(
                              ipCommandBoardRoute(
                                patientUid: uid,
                                admissionId: widget.admissionId,
                                patientName: name,
                              ),
                            );
                          }
                        },
                      ),
                      ActionChip(
                        avatar: const Icon(Icons.rule_folder, size: 18),
                        label: const AppText('bed_board.discharge_hub'),
                        onPressed: () {
                          Navigator.pop(context);
                          final id = widget.admissionId;
                          final name = _detail?['patient_name'] as String?;
                          context.push(
                            ipCommandBoardRoute(
                              patientUid: _detail?['patient_uid'] as String?,
                              admissionId: id,
                              patientName: name,
                              action: 'discharge',
                            ),
                          );
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                ],
              ),
            ),
    );
  }
}
