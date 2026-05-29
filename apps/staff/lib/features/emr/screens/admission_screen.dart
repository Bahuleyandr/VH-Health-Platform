import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

/// EMR Admissions screen — list active admissions, admit patients, view details.
class AdmissionScreen extends StatefulWidget {
  const AdmissionScreen({super.key});

  @override
  State<AdmissionScreen> createState() => _AdmissionScreenState();
}

class _AdmissionScreenState extends State<AdmissionScreen> {
  List<Map<String, dynamic>> _admissions = [];
  bool _loading = true;
  String? _error;
  final int _page = 1;

  @override
  void initState() {
    super.initState();
    _loadAdmissions();
  }

  Future<void> _loadAdmissions() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getActiveAdmissions(page: _page);
      final list = _listFromAdmissions(data);
      setState(() {
        _admissions = list;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
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

  Widget _statusBadge(String? status) {
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
        status?.toUpperCase() ?? 'UNKNOWN',
        style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w600),
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
                            decoration: const InputDecoration(
                              labelText: 'Admitting doctor',
                              prefixIcon: Icon(Icons.medical_services_outlined),
                              border: OutlineInputBorder(),
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
                                ? 'Admitting doctor is required'
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
                                labelText: AppStrings.of(
                                  ctx,
                                ).admissionBedNumber,
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
        _loadAdmissions();
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
          : _admissions.isEmpty
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.bed, size: 64, color: AppTheme.divider),
                  const SizedBox(height: 12),
                  Text(
                    s.admissionNoActive,
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                ],
              ),
            )
          : RefreshIndicator(
              onRefresh: _loadAdmissions,
              child: ListView.builder(
                padding: const EdgeInsets.all(12),
                itemCount: _admissions.length,
                itemBuilder: (ctx, i) {
                  final a = _admissions[i];
                  return Card(
                    margin: const EdgeInsets.only(bottom: 10),
                    child: ListTile(
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      leading: CircleAvatar(
                        backgroundColor: _priorityColor(
                          a['priority'] as String?,
                        ).withValues(alpha: 0.15),
                        child: Icon(
                          Icons.local_hospital,
                          color: _priorityColor(a['priority'] as String?),
                        ),
                      ),
                      title: Text(
                        a['patient_name'] as String? ??
                            s.admissionPatientFallback,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      subtitle: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${a['ward'] ?? ''} ${a['bed'] != null ? '- Bed ${a['bed']}' : ''}',
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
                      trailing: _statusBadge(a['status'] as String?),
                      onTap: () => _showAdmissionDetail(a),
                    ),
                  );
                },
              ),
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
                    'Hospital ID',
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
                            context.go(
                              '/emr/vitals/$uid${name != null ? '?name=$name' : ''}',
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
                            context.go(
                              '/emr/notes/$uid${name != null ? '?name=$name' : ''}',
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
                            context.go(
                              '/emr/orders/$uid${name != null ? '?name=$name' : ''}',
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
                            context.go(
                              '/emr/timeline/$uid${name != null ? '?name=$name' : ''}',
                            );
                          }
                        },
                      ),
                      ActionChip(
                        avatar: const Icon(Icons.rule_folder, size: 18),
                        label: const Text('Discharge Hub'),
                        onPressed: () {
                          Navigator.pop(context);
                          final id = widget.admissionId;
                          final name = _detail?['patient_name'] as String?;
                          context.go(
                            '/emr/discharge-hub/$id${name != null ? '?name=${Uri.encodeQueryComponent(name)}' : ''}',
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
