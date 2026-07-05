import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

class InvestigationsScreen extends StatefulWidget {
  final String? contextMode;
  final String? initialPatientUid;
  final String? initialPatientId;
  final String? initialPatientPhone;
  final String? initialPatientName;
  final String? initialHospitalNumber;
  final String? initialAppointmentId;
  final String? initialDoctorId;
  final String? initialDoctorName;
  final String? initialDepartment;
  final String? initialAppointmentDate;
  final String? initialAppointmentTime;

  const InvestigationsScreen({
    super.key,
    this.contextMode,
    this.initialPatientUid,
    this.initialPatientId,
    this.initialPatientPhone,
    this.initialPatientName,
    this.initialHospitalNumber,
    this.initialAppointmentId,
    this.initialDoctorId,
    this.initialDoctorName,
    this.initialDepartment,
    this.initialAppointmentDate,
    this.initialAppointmentTime,
  });

  @override
  State<InvestigationsScreen> createState() => _InvestigationsScreenState();
}

@visibleForTesting
bool investigationsCanUploadResultsForRole(StaffRole role) {
  return role != StaffRole.doctor &&
      role != StaffRole.dutyDoctor &&
      role != StaffRole.anaesthetist;
}

@visibleForTesting
bool investigationsCanManagePendingStatusForRole(StaffRole role) {
  return role == StaffRole.lab ||
      role == StaffRole.radiologyStaff ||
      role == StaffRole.admin ||
      role == StaffRole.superAdmin;
}

@visibleForTesting
bool investigationPhoneMatches(String? candidate, String? expected) {
  final candidateDigits = candidate?.replaceAll(RegExp(r'\D'), '') ?? '';
  final expectedDigits = expected?.replaceAll(RegExp(r'\D'), '') ?? '';
  if (candidateDigits.isEmpty || expectedDigits.isEmpty) return false;
  if (candidateDigits == expectedDigits) return true;
  if (candidateDigits.length == 12 &&
      candidateDigits.startsWith('91') &&
      expectedDigits.length == 10) {
    return candidateDigits.substring(2) == expectedDigits;
  }
  if (expectedDigits.length == 12 &&
      expectedDigits.startsWith('91') &&
      candidateDigits.length == 10) {
    return expectedDigits.substring(2) == candidateDigits;
  }
  return false;
}

String _textValue(dynamic value) {
  final text = value?.toString().trim() ?? '';
  if (text.isEmpty || text.toLowerCase() == 'null') return '';
  return text;
}

String _firstText(List<dynamic> values) {
  for (final value in values) {
    final text = _textValue(value);
    if (text.isNotEmpty) return text;
  }
  return '';
}

Map<String, dynamic>? _mapValue(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return value.map((key, value) => MapEntry(key.toString(), value));
  }
  return null;
}

@visibleForTesting
String investigationStatus(Map<String, dynamic> investigation) {
  return _firstText([investigation['status']]).toUpperCase();
}

String _investigationPriorityLabel(AppStrings s, String value) {
  switch (value.toUpperCase()) {
    case 'NORMAL':
      return s.lookup('s4.lib.investigations.priority.normal');
    case 'HIGH':
      return s.lookup('s4.lib.investigations.priority.high');
    case 'URGENT':
      return s.lookup('s4.lib.investigations.priority.urgent');
    case 'LOW':
      return s.lookup('s4.lib.investigations.priority.low');
    default:
      return value;
  }
}

@visibleForTesting
bool investigationIsPending(Map<String, dynamic> investigation) {
  final status = investigationStatus(investigation);
  return status == 'REQUESTED' || status == 'PENDING';
}

@visibleForTesting
bool investigationIsResultReady(Map<String, dynamic> investigation) {
  final status = investigationStatus(investigation);
  return status == 'COMPLETED' ||
      status == 'RESULT_READY' ||
      _textValue(investigation['result_summary']).isNotEmpty ||
      _textValue(investigation['interpretation']).isNotEmpty ||
      investigation['results'] != null ||
      investigation['result'] != null ||
      _textValue(investigation['file_url']).isNotEmpty ||
      _textValue(investigation['report_url']).isNotEmpty;
}

@visibleForTesting
bool investigationBelongsInRecent(Map<String, dynamic> investigation) {
  final status = investigationStatus(investigation);
  if (status == 'CANCELLED') return false;
  return !investigationIsPending(investigation) ||
      investigationIsResultReady(investigation);
}

@visibleForTesting
String investigationTestTitle(Map<String, dynamic> investigation) {
  final name = _firstText([
    investigation['test_name'],
    investigation['testName'],
    investigation['investigation_name'],
    investigation['investigationName'],
    investigation['name'],
  ]);
  if (name.isNotEmpty) return name;
  final type = _investigationType(investigation);
  return type.isNotEmpty ? type : 'Investigation';
}

@visibleForTesting
String investigationPatientLabel(
  Map<String, dynamic> investigation, {
  String? fallbackName,
  String? fallbackPhone,
}) {
  final patient = _mapValue(investigation['patient']);
  return _firstText([
    investigation['patient_name'],
    investigation['patientName'],
    patient?['name'],
    fallbackName,
    investigation['hospital_number'],
    investigation['hospitalNumber'],
    investigation['patient_phone'],
    investigation['phone'],
    patient?['phone'],
    fallbackPhone,
  ]);
}

String _investigationType(Map<String, dynamic> investigation) {
  return _firstText([
    investigation['test_type'],
    investigation['testType'],
    investigation['type'],
  ]);
}

String _formatInvestigationDate(dynamic value) {
  final raw = _textValue(value);
  if (raw.isEmpty) return '';
  final parsed = DateTime.tryParse(raw);
  if (parsed == null) return raw;
  return DateFormat('dd/MM HH:mm').format(parsed.toLocal());
}

class _InvestigationsScreenState extends State<InvestigationsScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  int _pendingReloadKey = 0;
  int _recentReloadKey = 0;
  bool _canUploadResults = false;
  bool _canManagePendingStatus = false;

  bool get _isScopedOpVisit =>
      (widget.contextMode ?? '').trim().toLowerCase() == 'op' &&
      (widget.initialPatientUid ?? '').trim().isNotEmpty;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadRolePermissions();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadRolePermissions() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    final canUpload = investigationsCanUploadResultsForRole(role);
    final canManagePendingStatus = investigationsCanManagePendingStatusForRole(
      role,
    );
    if (!mounted) return;
    if (canUpload != _canUploadResults) {
      final oldIndex = _tabController.index;
      _tabController.dispose();
      final nextIndex = canUpload
          ? oldIndex.clamp(0, 2).toInt()
          : oldIndex.clamp(0, 1).toInt();
      _tabController = TabController(
        length: canUpload ? 3 : 2,
        vsync: this,
        initialIndex: nextIndex,
      );
    }
    setState(() {
      _canUploadResults = canUpload;
      _canManagePendingStatus = canManagePendingStatus;
    });
  }

  Map<String, dynamic> _prescriptionContext() {
    int? parseInt(String? value) => int.tryParse((value ?? '').trim());
    return {
      if (parseInt(widget.initialAppointmentId) != null)
        'id': parseInt(widget.initialAppointmentId),
      if (parseInt(widget.initialPatientId) != null)
        'patient_id': parseInt(widget.initialPatientId),
      'patient_uid': widget.initialPatientUid,
      if ((widget.initialPatientName ?? '').trim().isNotEmpty)
        'patient_name': widget.initialPatientName!.trim(),
      if (parseInt(widget.initialDoctorId) != null)
        'doctor_id': parseInt(widget.initialDoctorId),
      if ((widget.initialDoctorName ?? '').trim().isNotEmpty)
        'doctor_name': widget.initialDoctorName!.trim(),
      if ((widget.initialDepartment ?? '').trim().isNotEmpty)
        'department': widget.initialDepartment!.trim(),
      if ((widget.initialAppointmentDate ?? '').trim().isNotEmpty)
        'appointment_date': widget.initialAppointmentDate!.trim(),
      if ((widget.initialAppointmentTime ?? '').trim().isNotEmpty)
        'appointment_time': widget.initialAppointmentTime!.trim(),
    };
  }

  void _continueToPrescription() {
    if (!_isScopedOpVisit) return;
    context.push('/prescriptions', extra: _prescriptionContext());
  }

  Future<void> _orderInvestigation() async {
    final formKey = GlobalKey<FormState>();
    final scopedPatientId = int.tryParse(widget.initialPatientId ?? '');
    final scopedAppointmentId = int.tryParse(widget.initialAppointmentId ?? '');
    final patientIdCtrl = TextEditingController(
      text: scopedPatientId == null ? '' : scopedPatientId.toString(),
    );
    final patientPhoneCtrl = TextEditingController(
      text: widget.initialPatientPhone?.trim() ?? '',
    );
    final testNameCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    var type = 'LAB';
    var priority = 'NORMAL';
    var submitting = false;

    try {
      final ordered = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, setSheetState) {
            Future<void> submit() async {
              if (!formKey.currentState!.validate()) return;
              setSheetState(() => submitting = true);
              try {
                await MedicalApiService.orderInvestigation(
                  patientId: int.parse(patientIdCtrl.text.trim()),
                  testName: testNameCtrl.text.trim(),
                  appointmentId: scopedAppointmentId,
                  type: type,
                  priority: priority,
                  notes: notesCtrl.text.trim().isEmpty
                      ? null
                      : notesCtrl.text.trim(),
                );
                if (!ctx.mounted) return;
                Navigator.pop(ctx, true);
              } catch (e) {
                if (!ctx.mounted) return;
                setSheetState(() => submitting = false);
                ScaffoldMessenger.of(ctx).showSnackBar(
                  SnackBar(
                    content: Text(e.toString().replaceFirst('Exception: ', '')),
                    backgroundColor: AppTheme.errorRed,
                  ),
                );
              }
            }

            return Padding(
              padding: EdgeInsets.only(
                left: 20,
                right: 20,
                top: 20,
                bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
              ),
              child: SingleChildScrollView(
                child: Form(
                  key: formKey,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Expanded(
                            child: AppText(
                              'queue.order_investigation',
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          IconButton(
                            icon: const Icon(Icons.close),
                            tooltip: AppStrings.of(
                              context,
                            ).lookup('action.close'),
                            onPressed: submitting
                                ? null
                                : () => Navigator.pop(ctx, false),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      if (patientPhoneCtrl.text.trim().isNotEmpty) ...[
                        TextFormField(
                          controller: patientPhoneCtrl,
                          readOnly: true,
                          keyboardType: TextInputType.phone,
                          decoration: InputDecoration(
                            labelText: AppStrings.of(
                              context,
                            ).lookup('reception_counter.patient.phone'),
                            helperText: [
                              if ((widget.initialPatientName ?? '')
                                  .trim()
                                  .isNotEmpty)
                                widget.initialPatientName!.trim(),
                              if ((widget.initialHospitalNumber ?? '')
                                  .trim()
                                  .isNotEmpty)
                                widget.initialHospitalNumber!.trim(),
                            ].join(' - '),
                            prefixIcon: const ExcludeSemantics(
                              child: Icon(Icons.phone_outlined),
                            ),
                            suffixIcon: const Icon(Icons.lock_outline),
                          ),
                        ),
                        const SizedBox(height: 12),
                      ],
                      if (scopedAppointmentId != null) ...[
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: AppTheme.primaryBlue.withValues(alpha: 0.08),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(
                              color: AppTheme.primaryBlue.withValues(
                                alpha: 0.2,
                              ),
                            ),
                          ),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Icon(
                                Icons.event_note_outlined,
                                color: AppTheme.primaryBlue,
                                size: 20,
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(
                                  [
                                    'Linked to OP visit #$scopedAppointmentId',
                                    if ((widget.initialAppointmentDate ?? '')
                                        .trim()
                                        .isNotEmpty)
                                      widget.initialAppointmentDate!.trim(),
                                    if ((widget.initialAppointmentTime ?? '')
                                        .trim()
                                        .isNotEmpty)
                                      widget.initialAppointmentTime!.trim(),
                                    if ((widget.initialDoctorName ?? '')
                                        .trim()
                                        .isNotEmpty)
                                      widget.initialDoctorName!.trim(),
                                    if ((widget.initialDepartment ?? '')
                                        .trim()
                                        .isNotEmpty)
                                      widget.initialDepartment!.trim(),
                                  ].join(' - '),
                                  style: TextStyle(
                                    color: AppTheme.textPrimary,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 12),
                      ],
                      TextFormField(
                        controller: patientIdCtrl,
                        readOnly: scopedPatientId != null,
                        keyboardType: TextInputType.number,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('vitals.patient_id_label'),
                          helperText: scopedPatientId != null
                              ? 'Using selected OP patient'
                              : null,
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.badge_outlined),
                          ),
                          suffixIcon: scopedPatientId != null
                              ? const Icon(Icons.lock_outline)
                              : null,
                        ),
                        validator: (value) {
                          final id = int.tryParse(value?.trim() ?? '');
                          return id == null || id < 1
                              ? 'Enter a valid patient ID'
                              : null;
                        },
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: testNameCtrl,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('s4.lib.investigations.test_name'),
                          hintText: AppStrings.of(
                            context,
                          ).lookup('s4.lib.investigations.cbc_x_ray_chest_ecg'),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.science_outlined),
                          ),
                        ),
                        validator: (value) => (value?.trim().isEmpty ?? true)
                            ? 'Test name is required'
                            : null,
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: type,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('bed_sheet.field.type'),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.category_outlined),
                          ),
                        ),
                        items:
                            const [
                                  'LAB',
                                  'RADIOLOGY',
                                  'PATHOLOGY',
                                  'CARDIOLOGY',
                                  'PULMONARY',
                                  'ENDOSCOPY',
                                ]
                                .map(
                                  (value) => DropdownMenuItem(
                                    value: value,
                                    child: Text(value),
                                  ),
                                )
                                .toList(),
                        onChanged: submitting
                            ? null
                            : (value) =>
                                  setSheetState(() => type = value ?? 'LAB'),
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: priority,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(
                            context,
                          ).lookup('clinical_inbox.priority'),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.priority_high_outlined),
                          ),
                        ),
                        items: const ['NORMAL', 'HIGH', 'URGENT', 'LOW']
                            .map(
                              (value) => DropdownMenuItem(
                                value: value,
                                child: Text(
                                  _investigationPriorityLabel(
                                    AppStrings.of(context),
                                    value,
                                  ),
                                ),
                              ),
                            )
                            .toList(),
                        onChanged: submitting
                            ? null
                            : (value) => setSheetState(
                                () => priority = value ?? 'NORMAL',
                              ),
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: notesCtrl,
                        decoration: InputDecoration(
                          labelText: AppStrings.of(context).lookup(
                            's4.lib.investigations.clinical_notes_optional',
                          ),
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.notes_outlined),
                          ),
                          alignLabelWithHint: true,
                        ),
                        maxLines: 3,
                      ),
                      const SizedBox(height: 18),
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          onPressed: submitting ? null : submit,
                          icon: submitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Icon(Icons.add, color: Colors.white),
                          label: Text(
                            submitting
                                ? AppStrings.of(
                                    context,
                                  ).lookup('s4.lib.investigations.ordering')
                                : AppStrings.of(context).lookup(
                                    's4.lib.investigations.order_investigation',
                                  ),
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppTheme.accentCyan,
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 14),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      );

      if (ordered == true && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const AppText(
              's4.lib.investigations.investigation_ordered',
            ),
            backgroundColor: AppTheme.successGreen,
            action: _isScopedOpVisit
                ? SnackBarAction(
                    label: AppStrings.of(
                      context,
                    ).lookup('s4.lib.investigations.prescription'),
                    textColor: AppTheme.surfaceWhite,
                    onPressed: _continueToPrescription,
                  )
                : null,
          ),
        );
        setState(() {
          _pendingReloadKey++;
          _recentReloadKey++;
          _tabController.index = _canUploadResults ? 1 : 0;
        });
      }
    } finally {
      patientIdCtrl.dispose();
      patientPhoneCtrl.dispose();
      testNameCtrl.dispose();
      notesCtrl.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final tabs = _canUploadResults
        ? [
            Tab(text: s.investigationsTabUpload),
            Tab(text: s.investigationsTabPending),
            Tab(text: s.investigationsTabRecent),
          ]
        : [
            Tab(text: s.investigationsTabPending),
            Tab(text: s.investigationsTabRecent),
          ];
    final tabViews = _canUploadResults
        ? [
            _UploadTab(initialPatientPhone: widget.initialPatientPhone),
            _PendingTab(
              key: ValueKey(_pendingReloadKey),
              initialPatientId: widget.initialPatientId,
              initialPatientPhone: widget.initialPatientPhone,
              initialPatientName: widget.initialPatientName,
              canManageStatus: _canManagePendingStatus,
            ),
            _RecentUploadsTab(
              key: ValueKey(_recentReloadKey),
              initialPatientId: widget.initialPatientId,
              initialPatientPhone: widget.initialPatientPhone,
              initialPatientName: widget.initialPatientName,
            ),
          ]
        : [
            _PendingTab(
              key: ValueKey(_pendingReloadKey),
              initialPatientId: widget.initialPatientId,
              initialPatientPhone: widget.initialPatientPhone,
              initialPatientName: widget.initialPatientName,
              canManageStatus: _canManagePendingStatus,
            ),
            _RecentUploadsTab(
              key: ValueKey(_recentReloadKey),
              initialPatientId: widget.initialPatientId,
              initialPatientPhone: widget.initialPatientPhone,
              initialPatientName: widget.initialPatientName,
            ),
          ];
    return StaffScaffold(
      title: s.investigationsTitle,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
            child: Row(
              children: [
                const Spacer(),
                if (_isScopedOpVisit) ...[
                  OutlinedButton.icon(
                    onPressed: _continueToPrescription,
                    icon: const Icon(Icons.medication_outlined),
                    label: const AppText(
                      's4.lib.investigations.continue_to_prescription',
                    ),
                  ),
                  const SizedBox(width: 12),
                ],
                const SizedBox(width: 12),
                ElevatedButton.icon(
                  onPressed: _orderInvestigation,
                  icon: const Icon(Icons.add, color: Colors.white, size: 18),
                  label: const AppText('timeline.filter.order'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.accentCyan,
                    foregroundColor: Colors.white,
                    minimumSize: const Size(0, 38),
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                  ),
                ),
              ],
            ),
          ),
          Container(
            color: AppTheme.cardSurface,
            child: TabBar(
              controller: _tabController,
              labelColor: AppTheme.primaryBlue,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: AppTheme.primaryBlue,
              tabs: tabs,
            ),
          ),
          Expanded(
            child: TabBarView(controller: _tabController, children: tabViews),
          ),
        ],
      ),
    );
  }
}

class _UploadTab extends StatefulWidget {
  final String? initialPatientPhone;

  const _UploadTab({this.initialPatientPhone});

  @override
  State<_UploadTab> createState() => _UploadTabState();
}

class _SelectedInvestigationFile {
  final File file;
  final String name;
  final int sizeBytes;
  bool uploaded = false;
  String? error;

  _SelectedInvestigationFile({
    required this.file,
    required this.name,
    required this.sizeBytes,
  });
}

class _UploadTabState extends State<_UploadTab> {
  final _formKey = GlobalKey<FormState>();
  final _phoneCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  final _resultCtrl = TextEditingController();
  String? _testType;
  bool _submitting = false;
  String? _uploadingFileName;
  int _uploadedCount = 0;
  final List<_SelectedInvestigationFile> _files = [];

  static const _testTypes = [
    'Blood Test - CBC',
    'Blood Test - Lipid Panel',
    'Blood Test - HBA1C',
    'Blood Test - Thyroid',
    'Urine Analysis',
    'X-Ray',
    'CT Scan',
    'MRI',
    'Ultrasound',
    'ECG',
    'Echocardiogram',
    'Biopsy',
    'Culture & Sensitivity',
    'COVID-19 PCR',
    'Other',
  ];

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _notesCtrl.dispose();
    _resultCtrl.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _phoneCtrl.text = widget.initialPatientPhone?.trim() ?? '';
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _submitting = true;
      _uploadedCount = 0;
      _uploadingFileName = null;
      for (final file in _files) {
        file.error = null;
      }
    });
    try {
      if (_files.isEmpty) {
        await _uploadOne();
      } else {
        for (var i = 0; i < _files.length; i++) {
          final selected = _files[i];
          if (selected.uploaded) continue;
          if (mounted) {
            setState(() {
              _uploadedCount = i + 1;
              _uploadingFileName = selected.name;
            });
          }
          try {
            await _uploadOne(file: selected);
            selected.uploaded = true;
          } catch (e) {
            selected.error = e.toString().replaceFirst('Exception: ', '');
            rethrow;
          }
        }
      }
      if (mounted) {
        final s = AppStrings.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.investigationsUploadSuccess),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _formKey.currentState!.reset();
        setState(() {
          _testType = null;
          _resultCtrl.clear();
          _notesCtrl.clear();
          _files.clear();
          _uploadedCount = 0;
          _uploadingFileName = null;
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
    } finally {
      if (mounted) {
        setState(() {
          _submitting = false;
          _uploadingFileName = null;
        });
      }
    }
  }

  Future<void> _uploadOne({_SelectedInvestigationFile? file}) {
    return MedicalApiService.uploadInvestigation(
      phone: _phoneCtrl.text.trim(),
      testType: _testType!,
      result: _resultCtrl.text.trim().isEmpty ? null : _resultCtrl.text.trim(),
      notes: _notesCtrl.text.trim().isEmpty ? null : _notesCtrl.text.trim(),
      date: DateFormat('yyyy-MM-dd').format(DateTime.now()),
      filePath: file?.file.path,
      fileName: file?.name,
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppTheme.accentCyan.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: AppTheme.accentCyan.withValues(alpha: 0.3),
                ),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.info_outline,
                    color: AppTheme.accentCyan,
                    size: 18,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      s.investigationsUploadIntro,
                      style: const TextStyle(
                        color: AppTheme.accentCyan,
                        fontSize: 13,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _phoneCtrl,
              keyboardType: TextInputType.phone,
              decoration: InputDecoration(
                labelText: s.investigationsPhoneLabel,
                hintText: s.investigationsPhoneHint,
                prefixIcon: const ExcludeSemantics(
                  child: Icon(Icons.phone_outlined),
                ),
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty) {
                  return s.investigationsPhoneRequired;
                }
                if (v.trim().length < 10) return s.investigationsPhoneInvalid;
                return null;
              },
            ),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              initialValue: _testType,
              decoration: InputDecoration(
                labelText: s.investigationsTestTypeLabel,
                prefixIcon: const ExcludeSemantics(
                  child: Icon(Icons.biotech_outlined),
                ),
              ),
              items: _testTypes
                  .map((t) => DropdownMenuItem(value: t, child: Text(t)))
                  .toList(),
              onChanged: (v) => setState(() => _testType = v),
              validator: (v) =>
                  v == null ? s.investigationsTestTypeRequired : null,
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _resultCtrl,
              decoration: InputDecoration(
                labelText: s.investigationsResultLabel,
                hintText: s.investigationsResultHint,
                prefixIcon: const ExcludeSemantics(
                  child: Icon(Icons.assignment_outlined),
                ),
                alignLabelWithHint: true,
              ),
              maxLines: 3,
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _notesCtrl,
              decoration: InputDecoration(
                labelText: s.investigationsClinicalNotesLabel,
                hintText: s.investigationsClinicalNotesHint,
                prefixIcon: const ExcludeSemantics(
                  child: Icon(Icons.notes_outlined),
                ),
                alignLabelWithHint: true,
              ),
              maxLines: 2,
            ),
            const SizedBox(height: 16),
            GestureDetector(
              onTap: _submitting
                  ? null
                  : () async {
                      try {
                        final result = await FilePicker.pickFiles(
                          type: FileType.custom,
                          allowMultiple: true,
                          allowedExtensions: [
                            'pdf',
                            'doc',
                            'docx',
                            'jpg',
                            'jpeg',
                            'png',
                          ],
                        );
                        if (result == null || result.files.isEmpty) return;
                        final selected = <_SelectedInvestigationFile>[];
                        var skippedLarge = 0;
                        final existingPaths = _files
                            .map((file) => file.file.path)
                            .toSet();
                        for (final picked in result.files) {
                          final path = picked.path;
                          if (path == null || existingPaths.contains(path)) {
                            continue;
                          }
                          final file = File(path);
                          final sizeBytes = await file.length();
                          const maxSizeBytes = 10 * 1024 * 1024; // 10 MB
                          if (sizeBytes > maxSizeBytes) {
                            skippedLarge += 1;
                            continue;
                          }
                          selected.add(
                            _SelectedInvestigationFile(
                              file: file,
                              name: picked.name,
                              sizeBytes: sizeBytes,
                            ),
                          );
                          existingPaths.add(path);
                        }
                        if (mounted && selected.isNotEmpty) {
                          setState(() => _files.addAll(selected));
                        }
                        if (mounted && skippedLarge > 0) {
                          // ignore: use_build_context_synchronously
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(s.investigationsFileTooLarge),
                              backgroundColor: AppTheme.errorRed,
                            ),
                          );
                        }
                      } catch (e) {
                        if (mounted) {
                          // ignore: use_build_context_synchronously
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(s.investigationsFilePickFailed),
                              backgroundColor: AppTheme.errorRed,
                            ),
                          );
                        }
                      }
                    },
              child: Container(
                height: 80,
                width: double.infinity,
                decoration: BoxDecoration(
                  color: _files.isNotEmpty
                      ? AppTheme.accentCyan.withValues(alpha: 0.08)
                      : AppTheme.surfaceWhite,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: _files.isNotEmpty
                        ? AppTheme.accentCyan
                        : AppTheme.divider,
                    style: BorderStyle.solid,
                  ),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      _files.isNotEmpty
                          ? Icons.check_circle_outline
                          : Icons.upload_file_outlined,
                      color: _files.isNotEmpty
                          ? AppTheme.accentCyan
                          : AppTheme.textSecondary,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _files.isEmpty
                          ? s.investigationsAttachReport
                          : s.format(
                              _files.length == 1
                                  ? 's4.dynamic.investigations.file_selected_one'
                                  : 's4.dynamic.investigations.file_selected_other',
                              {'count': _files.length},
                            ),
                      style: TextStyle(
                        color: _files.isNotEmpty
                            ? AppTheme.accentCyan
                            : AppTheme.textSecondary,
                        fontSize: 13,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (_files.isNotEmpty)
                      GestureDetector(
                        onTap: () => setState(() {
                          _files.clear();
                        }),
                        child: Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            s.investigationsClearFile,
                            style: const TextStyle(
                              color: AppTheme.errorRed,
                              fontSize: 11,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            if (_files.isNotEmpty) ...[
              const SizedBox(height: 10),
              for (var i = 0; i < _files.length; i++)
                _SelectedFileRow(
                  file: _files[i],
                  uploading:
                      _submitting && _uploadingFileName == _files[i].name,
                  onRemove: _submitting
                      ? null
                      : () => setState(() => _files.removeAt(i)),
                ),
            ],
            const SizedBox(height: 24),
            ElevatedButton.icon(
              onPressed: _submitting ? null : _submit,
              icon: _submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        color: Colors.white,
                        strokeWidth: 2,
                      ),
                    )
                  : const Icon(Icons.upload, color: Colors.white),
              label: Text(
                _submitting
                    ? _files.isEmpty
                          ? s.investigationsUploading
                          : s.format(
                              _uploadingFileName == null
                                  ? 's4.dynamic.investigations.uploading_count'
                                  : 's4.dynamic.investigations.uploading_file',
                              {
                                'uploaded': _uploadedCount,
                                'total': _files.length,
                                'file': _uploadingFileName ?? '',
                              },
                            )
                    : s.investigationsUploadButton,
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.accentCyan,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SelectedFileRow extends StatelessWidget {
  final _SelectedInvestigationFile file;
  final bool uploading;
  final VoidCallback? onRemove;

  const _SelectedFileRow({
    required this.file,
    required this.uploading,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final color = file.error != null
        ? AppTheme.errorOnSurface
        : file.uploaded
        ? AppTheme.successOnSurface
        : AppTheme.textSecondary;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: AppTheme.surfaceWhite,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: file.error != null
              ? AppTheme.errorOnSurface.withValues(alpha: 0.45)
              : AppTheme.divider,
        ),
      ),
      child: Row(
        children: [
          if (uploading)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: AppTheme.accentCyan,
              ),
            )
          else
            Icon(
              file.uploaded
                  ? Icons.check_circle_outline
                  : file.error != null
                  ? Icons.error_outline
                  : Icons.insert_drive_file_outlined,
              size: 18,
              color: color,
            ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  file.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  file.error ?? _fileSizeLabel(file.sizeBytes),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: color),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: AppStrings.of(
              context,
            ).lookup('s4.lib.patient_records.remove_file'),
            onPressed: onRemove,
            icon: const Icon(Icons.close, size: 18),
          ),
        ],
      ),
    );
  }
}

String _fileSizeLabel(int bytes) {
  if (bytes >= 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  if (bytes >= 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '$bytes B';
}

class _PendingTab extends StatefulWidget {
  final String? initialPatientId;
  final String? initialPatientPhone;
  final String? initialPatientName;
  final bool canManageStatus;

  const _PendingTab({
    super.key,
    this.initialPatientId,
    this.initialPatientPhone,
    this.initialPatientName,
    required this.canManageStatus,
  });

  @override
  State<_PendingTab> createState() => _PendingTabState();
}

class _PendingTabState extends State<_PendingTab> {
  List<dynamic> _pending = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  List<dynamic> _extractInvestigations(Map<String, dynamic> data) {
    return data['investigations'] as List? ??
        data['records'] as List? ??
        data['data'] as List? ??
        [];
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final scopedPatientId = widget.initialPatientId?.trim();
      final scopedPhone = widget.initialPatientPhone?.trim();
      List<dynamic> list;
      if (scopedPatientId != null && scopedPatientId.isNotEmpty) {
        final data = await MedicalApiService.getPatientInvestigations(
          scopedPatientId,
          status: 'PENDING',
        );
        list = _extractInvestigations(data);
      } else {
        // Try doctor-specific first, fall back to all pending.
        final staffId = await ApiConfig.getStaffId();
        Map<String, dynamic> data;
        if (staffId != null) {
          try {
            data = await MedicalApiService.getDoctorInvestigations(staffId);
          } catch (e) {
            data = await MedicalApiService.getPendingInvestigations();
          }
        } else {
          data = await MedicalApiService.getPendingInvestigations();
        }
        list = _extractInvestigations(data);
        if (scopedPhone != null && scopedPhone.isNotEmpty) {
          list = list
              .where(
                (entry) =>
                    entry is Map<String, dynamic> &&
                    investigationPhoneMatches(
                      entry['patient_phone']?.toString() ??
                          entry['phone']?.toString() ??
                          entry['patient']?['phone']?.toString(),
                      scopedPhone,
                    ),
              )
              .toList();
        }
      }
      if (mounted) setState(() => _pending = list);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _updateStatus(String id, String status) async {
    final s = AppStrings.of(context);
    try {
      await MedicalApiService.updateInvestigationStatus(id, status);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('${s.investigationsMarkedAsPrefix} $status'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _load();
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

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, color: AppTheme.errorRed, size: 40),
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(color: AppTheme.textSecondary)),
            TextButton(onPressed: _load, child: Text(s.actionRetry)),
          ],
        ),
      );
    }
    if (_pending.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(
              Icons.check_circle_outline,
              size: 56,
              color: AppTheme.successGreen,
            ),
            const SizedBox(height: 16),
            Text(
              s.investigationsPendingEmpty,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              s.investigationsPendingEmptyBody,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _pending.length,
        itemBuilder: (_, i) {
          final inv = _pending[i] as Map<String, dynamic>;
          final id = inv['_id']?.toString() ?? inv['id']?.toString() ?? '';
          final testName = investigationTestTitle(inv);
          final testType = _investigationType(inv);
          final patientName = investigationPatientLabel(
            inv,
            fallbackName: widget.initialPatientName,
            fallbackPhone: widget.initialPatientPhone,
          );
          final date = _formatInvestigationDate(
            inv['requested_at'] ?? inv['created_at'] ?? inv['date'],
          );
          final status = investigationStatus(inv);

          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      CircleAvatar(
                        backgroundColor: AppTheme.warningAmber.withValues(
                          alpha: 0.15,
                        ),
                        child: const Icon(
                          Icons.science_outlined,
                          color: AppTheme.warningAmber,
                          size: 20,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              testName,
                              style: TextStyle(
                                fontWeight: FontWeight.bold,
                                color: AppTheme.textPrimary,
                              ),
                            ),
                            Text(
                              [
                                if (patientName.isNotEmpty) patientName,
                                if (testType.isNotEmpty) testType,
                              ].join(' • '),
                              style: TextStyle(
                                fontSize: 12,
                                color: AppTheme.textSecondary,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: AppTheme.warningAmber.withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          status.isEmpty ? 'PENDING' : status,
                          style: const TextStyle(
                            fontSize: 10,
                            color: AppTheme.warningAmber,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ],
                  ),
                  if (date.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(
                      date,
                      style: TextStyle(
                        fontSize: 11,
                        color: AppTheme.textSecondary,
                      ),
                    ),
                  ],
                  if (widget.canManageStatus) ...[
                    const SizedBox(height: 10),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        TextButton(
                          onPressed: () => _updateStatus(id, 'IN_PROGRESS'),
                          child: Text(s.investigationsStartButton),
                        ),
                        const SizedBox(width: 8),
                        ElevatedButton(
                          onPressed: () => _updateStatus(id, 'COMPLETED'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppTheme.successGreen,
                          ),
                          child: Text(
                            s.investigationsCompleteButton,
                            style: const TextStyle(color: Colors.white),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _RecentUploadsTab extends StatefulWidget {
  final String? initialPatientId;
  final String? initialPatientPhone;
  final String? initialPatientName;

  const _RecentUploadsTab({
    super.key,
    this.initialPatientId,
    this.initialPatientPhone,
    this.initialPatientName,
  });

  @override
  State<_RecentUploadsTab> createState() => _RecentUploadsTabState();
}

class _RecentUploadsTabState extends State<_RecentUploadsTab> {
  List<dynamic> _investigations = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final scopedPatientId = widget.initialPatientId?.trim();
      final scopedPhone = widget.initialPatientPhone?.trim();
      Map<String, dynamic> data;
      if (scopedPatientId != null && scopedPatientId.isNotEmpty) {
        data = await MedicalApiService.getPatientInvestigations(
          scopedPatientId,
        );
      } else {
        data = await MedicalApiService.listInvestigations();
      }
      var list =
          data['investigations'] as List? ??
          data['records'] as List? ??
          data['data'] as List? ??
          [];
      if (scopedPatientId != null && scopedPatientId.isNotEmpty) {
        list = list
            .where(
              (entry) =>
                  entry is Map<String, dynamic> &&
                  investigationBelongsInRecent(entry),
            )
            .toList();
      } else if (scopedPhone != null && scopedPhone.isNotEmpty) {
        list = list
            .where(
              (entry) =>
                  entry is Map<String, dynamic> &&
                  investigationPhoneMatches(
                    entry['patient_phone']?.toString() ??
                        entry['phone']?.toString() ??
                        _mapValue(entry['patient'])?['phone']?.toString(),
                    scopedPhone,
                  ) &&
                  investigationBelongsInRecent(entry),
            )
            .toList();
      }
      if (mounted) setState(() => _investigations = list);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, color: AppTheme.errorRed, size: 40),
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(color: AppTheme.textSecondary)),
            TextButton(onPressed: _load, child: Text(s.actionRetry)),
          ],
        ),
      );
    }
    if (_investigations.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.science_outlined,
              size: 56,
              color: AppTheme.textSecondary,
            ),
            const SizedBox(height: 16),
            Text(
              s.investigationsRecentEmpty,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              s.investigationsRecentEmptyBody,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _investigations.length,
        itemBuilder: (_, i) {
          final inv = _investigations[i] as Map<String, dynamic>;
          final testName = investigationTestTitle(inv);
          final testType = _investigationType(inv);
          final patientName = investigationPatientLabel(
            inv,
            fallbackName: widget.initialPatientName,
            fallbackPhone: widget.initialPatientPhone,
          );
          final date = _formatInvestigationDate(
            inv['completed_at'] ??
                inv['verified_at'] ??
                inv['updated_at'] ??
                inv['requested_at'] ??
                inv['created_at'] ??
                inv['date'],
          );
          final status = investigationStatus(inv);
          final resultReady = investigationIsResultReady(inv);

          Color statusColor = switch (status) {
            'COMPLETED' || 'RESULT_READY' => AppTheme.successGreen,
            'IN_PROGRESS' || 'COLLECTED' || 'SCHEDULED' => AppTheme.primaryBlue,
            'PENDING' || 'REQUESTED' => AppTheme.warningAmber,
            _ => AppTheme.textSecondary,
          };

          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: ListTile(
              onTap: resultReady
                  ? () => _showInvestigationResultDetail(context, inv)
                  : null,
              leading: CircleAvatar(
                backgroundColor: AppTheme.accentCyan.withValues(alpha: 0.1),
                child: const Icon(
                  Icons.biotech,
                  color: AppTheme.accentCyan,
                  size: 20,
                ),
              ),
              title: Text(testName),
              subtitle: Text(
                [
                  if (patientName.isNotEmpty) patientName,
                  if (testType.isNotEmpty) testType,
                  if (date.isNotEmpty) date,
                ].join(' • '),
                style: const TextStyle(fontSize: 12),
              ),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (status.isNotEmpty)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: statusColor.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        resultReady
                            ? AppStrings.of(
                                context,
                              ).lookup('s4.lib.investigations.result_ready')
                            : status,
                        style: TextStyle(
                          fontSize: 10,
                          color: statusColor,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  if (resultReady) ...[
                    const SizedBox(width: 8),
                    Icon(Icons.chevron_right, color: AppTheme.textSecondary),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  void _showInvestigationResultDetail(
    BuildContext context,
    Map<String, dynamic> investigation,
  ) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => _InvestigationResultSheet(
        investigation: investigation,
        patientName: investigationPatientLabel(
          investigation,
          fallbackName: widget.initialPatientName,
          fallbackPhone: widget.initialPatientPhone,
        ),
      ),
    );
  }
}

class _InvestigationResultSheet extends StatelessWidget {
  final Map<String, dynamic> investigation;
  final String patientName;

  const _InvestigationResultSheet({
    required this.investigation,
    required this.patientName,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final title = investigationTestTitle(investigation);
    final status = investigationStatus(investigation);
    final resultSummary = _firstText([
      investigation['result_summary'],
      investigation['summary'],
      investigation['result'],
    ]);
    final interpretation = _textValue(investigation['interpretation']);
    final results = investigation['results'];
    final completedAt = _formatInvestigationDate(
      investigation['completed_at'] ??
          investigation['verified_at'] ??
          investigation['updated_at'],
    );

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          top: 16,
          bottom: MediaQuery.of(context).viewInsets.bottom + 20,
        ),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: AppStrings.of(context).lookup('action.close'),
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.pop(context),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  _ResultChip(
                    icon: Icons.person_outline,
                    label: patientName.isEmpty
                        ? s.lookup('s4.lib.investigations.selected_patient')
                        : patientName,
                  ),
                  _ResultChip(
                    icon: Icons.verified_outlined,
                    label: status.isEmpty
                        ? s.lookup('s4.lib.investigations.result_ready')
                        : status,
                  ),
                  if (completedAt.isNotEmpty)
                    _ResultChip(
                      icon: Icons.event_available_outlined,
                      label: completedAt,
                    ),
                ],
              ),
              const SizedBox(height: 16),
              if (resultSummary.isNotEmpty)
                _ResultBlock(
                  title: s.lookup('s4.lib.investigations.result_summary'),
                  body: resultSummary,
                ),
              if (interpretation.isNotEmpty)
                _ResultBlock(
                  title: s.lookup('s4.lib.investigations.interpretation'),
                  body: interpretation,
                ),
              if (resultSummary.isEmpty &&
                  interpretation.isEmpty &&
                  results != null)
                _ResultBlock(
                  title: s.lookup('s4.lib.investigations.results'),
                  body: _stringifyResults(s, results),
                ),
              if (resultSummary.isEmpty &&
                  interpretation.isEmpty &&
                  results == null)
                AppText(
                  's4.lib.investigations.result_has_been_marked_ready_but_no_structured_s',
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ResultChip extends StatelessWidget {
  final IconData icon;
  final String label;

  const _ResultChip({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppTheme.primaryBlue.withValues(alpha: 0.2)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: AppTheme.primaryBlue),
          const SizedBox(width: 6),
          Text(label, style: TextStyle(color: AppTheme.textPrimary)),
        ],
      ),
    );
  }
}

class _ResultBlock extends StatelessWidget {
  final String title;
  final String body;

  const _ResultBlock({required this.title, required this.body});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 6),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppTheme.cardSurface,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: AppTheme.divider),
            ),
            child: Text(body, style: TextStyle(color: AppTheme.textPrimary)),
          ),
        ],
      ),
    );
  }
}

String _stringifyResults(AppStrings s, dynamic results) {
  if (results is Map) {
    final lines = <String>[];
    for (final entry in results.entries) {
      final value = entry.value;
      if (value is Map) {
        final resultText = _firstText([value['value'], value['result']]);
        final unit = _textValue(value['unit']);
        final flag = _textValue(value['flag'] ?? value['abnormal_flag']);
        if (resultText.isNotEmpty) {
          lines.add(
            '${entry.key}: $resultText${unit.isNotEmpty ? ' $unit' : ''}${flag.isNotEmpty ? ' [$flag]' : ''}',
          );
        }
      } else {
        final text = _textValue(value);
        if (text.isNotEmpty) lines.add('${entry.key}: $text');
      }
    }
    if (lines.isNotEmpty) return lines.join('\n');
  }
  if (results is List) {
    final lines = results
        .map((value) {
          if (value is Map) {
            final name = _firstText([
              value['name'],
              value['test_name'],
              value['analyte'],
              value['parameter'],
            ]);
            final resultText = _firstText([value['value'], value['result']]);
            final unit = _textValue(value['unit']);
            final flag = _textValue(value['flag'] ?? value['abnormal_flag']);
            if (resultText.isEmpty) return '';
            final label = name.isEmpty
                ? s.lookup('s4.lib.investigations.result')
                : name;
            return '$label: $resultText${unit.isNotEmpty ? ' $unit' : ''}${flag.isNotEmpty ? ' [$flag]' : ''}';
          }
          return _textValue(value);
        })
        .where((line) => line.isNotEmpty)
        .toList();
    if (lines.isNotEmpty) return lines.join('\n');
  }
  return _textValue(results);
}
