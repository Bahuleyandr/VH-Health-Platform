import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth_core/vhhealth_core.dart'
    show SignaturePadController, SignaturePadField;

import '../../../core/services/medical_api_service.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../../appointments/models/staff_appointment.dart';

class ReceptionCounterScreen extends StatefulWidget {
  const ReceptionCounterScreen({super.key});

  @override
  State<ReceptionCounterScreen> createState() => _ReceptionCounterScreenState();
}

class _ReceptionCounterScreenState extends State<ReceptionCounterScreen> {
  final _searchCtrl = TextEditingController();
  final _patientPhoneCtrl = TextEditingController();
  final _patientNameCtrl = TextEditingController();
  final _opReasonCtrl = TextEditingController();
  final _opNotesCtrl = TextEditingController();
  final _chiefComplaintCtrl = TextEditingController();
  final _diagnosisCtrl = TextEditingController();
  final _wardCtrl = TextEditingController();
  final _bedCtrl = TextEditingController();
  final _doctorSearchCtrl = TextEditingController();
  final _doctorSearchFocus = FocusNode();
  final _patientSignatureController = SignaturePadController();
  final _staffWitnessSignatureController = SignaturePadController();

  late final Future<List<Map<String, dynamic>>> _doctorsFuture;
  late final Future<List<Map<String, dynamic>>> _wardOptionsFuture;
  Future<List<Map<String, dynamic>>>? _bedOptionsFuture;
  Timer? _searchDebounce;
  Timer? _admissionLookupDebounce;

  List<Map<String, dynamic>> _patientMatches = const [];
  List<StaffAppointment> _todayAppointments = const [];
  List<Map<String, dynamic>> _activeAdmissions = const [];
  Map<String, dynamic>? _selectedPatient;
  Map<String, dynamic>? _admissionLookup;

  bool _lookupBusy = false;
  bool _admissionLookupBusy = false;
  bool _workloadBusy = true;
  bool _opSubmitting = false;
  bool _ipSubmitting = false;
  bool _ipConsentCaptured = false;
  String? _lookupError;
  String? _admissionLookupError;
  int _tabIndex = 0;

  DateTime _appointmentDate = DateTime.now();
  late TimeOfDay _appointmentTime;
  int? _selectedDoctorId;
  String? _selectedDoctorUid;
  String _selectedDoctorLabel = '';
  String _doctorSearchText = '';
  String? _selectedWardValue;
  String? _selectedBedValue;
  int? _selectedBedId;
  String _priority = 'Routine';
  String _codeStatus = 'Full Code';

  @override
  void initState() {
    super.initState();
    _doctorsFuture = ScheduleApiService.getAppointmentDoctors();
    _wardOptionsFuture = MedicalApiService.getAdmissionWardOptions();
    _doctorSearchFocus.addListener(() {
      if (mounted) setState(() {});
    });
    _appointmentTime = TimeOfDay.fromDateTime(
      DateTime.now().add(const Duration(hours: 1)),
    );
    _loadWorkload();
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _admissionLookupDebounce?.cancel();
    _searchCtrl.dispose();
    _patientPhoneCtrl.dispose();
    _patientNameCtrl.dispose();
    _opReasonCtrl.dispose();
    _opNotesCtrl.dispose();
    _chiefComplaintCtrl.dispose();
    _diagnosisCtrl.dispose();
    _wardCtrl.dispose();
    _bedCtrl.dispose();
    _doctorSearchCtrl.dispose();
    _doctorSearchFocus.dispose();
    _patientSignatureController.dispose();
    _staffWitnessSignatureController.dispose();
    super.dispose();
  }

  Future<void> _loadWorkload() async {
    setState(() => _workloadBusy = true);
    try {
      final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
      final results = await Future.wait([
        ScheduleApiService.getAppointments(date: today, limit: 10),
        MedicalApiService.getActiveAdmissions(limit: 10),
      ]);
      if (!mounted) return;
      final strings = AppStrings.of(context);
      setState(() {
        _todayAppointments = StaffAppointment.listFrom(
          results[0],
          patientFallback: strings.patientRecordsUnknownPatient,
        );
        _activeAdmissions = _listFromAdmissions(results[1]);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _todayAppointments = const [];
        _activeAdmissions = const [];
      });
    } finally {
      if (mounted) setState(() => _workloadBusy = false);
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

  void _queuePatientLookup(String value) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 350), () {
      _searchPatients(value);
    });
  }

  Future<void> _searchPatients(String rawQuery) async {
    final query = rawQuery.trim();
    if (query.length < 2) {
      setState(() {
        _patientMatches = const [];
        _lookupError = null;
        _lookupBusy = false;
      });
      return;
    }

    setState(() {
      _lookupBusy = true;
      _lookupError = null;
    });
    try {
      final patients = await PatientApiService.search(query, limit: 8);
      if (!mounted) return;
      setState(() => _patientMatches = patients);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _patientMatches = const [];
        _lookupError = e.toString().replaceFirst('Exception: ', '');
      });
    } finally {
      if (mounted) setState(() => _lookupBusy = false);
    }
  }

  void _selectPatient(Map<String, dynamic> patient) {
    final name = _text(patient['name']);
    final phone = _text(patient['phone']);
    final hospitalNumber = _text(patient['hospital_number']);
    setState(() {
      _selectedPatient = patient;
      _patientNameCtrl.text = name;
      _patientPhoneCtrl.text = phone;
      _searchCtrl.text = hospitalNumber.isNotEmpty ? hospitalNumber : name;
      _patientMatches = const [];
      _lookupError = null;
    });
    if (_tabIndex == 1 && phone.isNotEmpty) {
      _queueAdmissionLookup(phone);
    }
  }

  void _onPatientPhoneChanged(String value) {
    if (_tabIndex == 1) _queueAdmissionLookup(value);
  }

  void _queueAdmissionLookup(String value) {
    _admissionLookupDebounce?.cancel();
    final digits = _digitsOnly(value);
    if (digits.length < 8) {
      setState(() {
        _admissionLookup = null;
        _admissionLookupError = null;
        _admissionLookupBusy = false;
      });
      return;
    }
    _admissionLookupDebounce = Timer(const Duration(milliseconds: 400), () {
      _lookupAdmissionByPhone(digits);
    });
  }

  Future<void> _lookupAdmissionByPhone(String phone) async {
    setState(() {
      _admissionLookupBusy = true;
      _admissionLookupError = null;
    });
    try {
      final lookup = await MedicalApiService.lookupAdmissionPatient(
        phone: phone,
      );
      if (!mounted) return;
      final patient = lookup['patient'];
      setState(() {
        _admissionLookup = lookup;
        if (patient is Map) {
          final normalized = Map<String, dynamic>.from(patient);
          _selectedPatient = normalized;
          _patientNameCtrl.text = _text(normalized['name']);
          _patientPhoneCtrl.text = _text(normalized['phone']);
          final hospitalNumber = _text(normalized['hospital_number']);
          if (hospitalNumber.isNotEmpty) _searchCtrl.text = hospitalNumber;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _admissionLookup = null;
        _admissionLookupError = e.toString().replaceFirst('Exception: ', '');
      });
    } finally {
      if (mounted) setState(() => _admissionLookupBusy = false);
    }
  }

  int? _patientId() => _intFrom(_selectedPatient?['id']);

  String? _patientUid() {
    final value = _text(_selectedPatient?['uid']);
    return value.isEmpty ? null : value;
  }

  String _patientQuery() {
    final hospitalNumber = _text(_selectedPatient?['hospital_number']);
    final phone = _patientPhoneCtrl.text.trim();
    final name = _patientNameCtrl.text.trim();
    if (hospitalNumber.isNotEmpty) return hospitalNumber;
    if (phone.isNotEmpty) return phone;
    if (name.isNotEmpty) return name;
    return _searchCtrl.text.trim();
  }

  void _selectDoctor(Map<String, dynamic> doctor) {
    final label = _doctorLabel(doctor);
    setState(() {
      _selectedDoctorId = _doctorId(doctor);
      _selectedDoctorUid = _doctorUid(doctor);
      _selectedDoctorLabel = label;
      _doctorSearchText = label;
      _doctorSearchCtrl.text = label;
    });
    _doctorSearchFocus.unfocus();
  }

  void _selectWard(Map<String, dynamic> ward) {
    final label = _wardLabel(ward);
    final id = _wardId(ward);
    setState(() {
      _selectedWardValue = _wardValue(ward);
      _wardCtrl.text = label;
      _selectedBedValue = null;
      _selectedBedId = null;
      _bedCtrl.clear();
      _bedOptionsFuture = MedicalApiService.getAdmissionBedOptions(
        wardId: id,
        wardLabel: label,
      );
      if (_isEmergencyWard(label)) _priority = 'Emergency';
    });
  }

  Future<void> _submitOpdBooking() async {
    final s = AppStrings.of(context);
    final patientId = _patientId();
    final phone = _patientPhoneCtrl.text.trim();
    final reason = _opReasonCtrl.text.trim();
    if (patientId == null && _digitsOnly(phone).length < 10) {
      _showError(s.receptionCounterValidatePhoneOrPatient);
      return;
    }
    if (_selectedDoctorId == null) {
      _showError(s.receptionCounterValidateDoctor);
      return;
    }
    if (reason.isEmpty) {
      _showError(s.receptionCounterValidateReason);
      return;
    }

    setState(() => _opSubmitting = true);
    try {
      await ScheduleApiService.createAppointment(
        patientId: patientId,
        patientPhone: patientId == null ? phone : null,
        patientName: _patientNameCtrl.text.trim(),
        doctorId: _selectedDoctorId!,
        doctorUid: _selectedDoctorUid,
        appointmentDate: DateFormat('yyyy-MM-dd').format(_appointmentDate),
        appointmentTime: _formatTime(_appointmentTime),
        reason: reason,
        notes: _opNotesCtrl.text.trim().isEmpty
            ? null
            : _opNotesCtrl.text.trim(),
      );
      if (!mounted) return;
      _showSuccess(AppStrings.of(context).receptionCounterOpdBookedSuccess);
      _opReasonCtrl.clear();
      _opNotesCtrl.clear();
      await _loadWorkload();
    } catch (e) {
      if (mounted) _showError(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _opSubmitting = false);
    }
  }

  Future<void> _submitIpAdmission() async {
    final s = AppStrings.of(context);
    final patientQuery = _patientQuery();
    if (patientQuery.isEmpty) {
      _showError(s.receptionCounterValidateSelectPatient);
      return;
    }
    if ((_selectedDoctorUid ?? '').isEmpty) {
      _showError(s.receptionCounterValidateAdmittingDoctor);
      return;
    }
    if (_chiefComplaintCtrl.text.trim().isEmpty) {
      _showError(s.receptionCounterValidateChiefComplaint);
      return;
    }
    if (_patientUid() == null && _patientNameCtrl.text.trim().isEmpty) {
      _showError(s.receptionCounterValidatePatientName);
      return;
    }
    if (_ipConsentCaptured &&
        (_patientSignatureController.isEmpty ||
            _staffWitnessSignatureController.isEmpty)) {
      _showError(s.receptionCounterIpSignatureRequired);
      return;
    }

    setState(() => _ipSubmitting = true);
    try {
      final result = await MedicalApiService.admitPatient({
        'patient_query': patientQuery,
        'patient_uid': ?_patientUid(),
        'patient_phone': _patientPhoneCtrl.text.trim(),
        'patient_name': _patientNameCtrl.text.trim(),
        'admitting_doctor': _selectedDoctorUid,
        'chief_complaint': _chiefComplaintCtrl.text.trim(),
        'provisional_diagnosis': _diagnosisCtrl.text.trim(),
        'ward': _wardCtrl.text.trim(),
        'bed_id': ?_selectedBedId,
        'bed': _bedCtrl.text.trim(),
        'priority': _apiPriority(_priority),
        'admission_type': _apiAdmissionType(_priority),
        'code_status': _apiCodeStatus(_codeStatus),
        'counter_consent_captured': _ipConsentCaptured,
      });
      final consentId = _intFrom(result['counter_treatment_consent_id']);
      if (_ipConsentCaptured) {
        if (consentId == null) {
          throw Exception(s.receptionCounterIpSignatureUploadFailed);
        }
        await _uploadIpConsentSignatures(
          consentId,
          signatureRequiredMessage: s.receptionCounterIpSignatureRequired,
        );
      }
      if (!mounted) return;
      final strings = AppStrings.of(context);
      final admission = _admissionFromResponse(result);
      final ipNumber = _text(admission['ip_number']);
      final hospitalNumber = _text(
        admission['patient_hospital_number'] ?? admission['hospital_number'],
      );
      _showSuccess(
        [
          if (ipNumber.isEmpty)
            '${strings.receptionCounterIpCreatedPrefix} created'
          else
            '${strings.receptionCounterIpCreatedPrefix} $ipNumber created',
          if (hospitalNumber.isNotEmpty)
            '${strings.receptionCounterIpHospitalIdPrefix} $hospitalNumber',
        ].join(' - '),
      );
      _chiefComplaintCtrl.clear();
      _diagnosisCtrl.clear();
      _bedCtrl.clear();
      _patientSignatureController.clear();
      _staffWitnessSignatureController.clear();
      setState(() {
        _admissionLookup = null;
        _ipConsentCaptured = false;
        _selectedBedValue = null;
        _selectedBedId = null;
      });
      await _loadWorkload();
    } catch (e) {
      if (mounted) _showError(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _ipSubmitting = false);
    }
  }

  Future<void> _uploadIpConsentSignatures(
    int consentId, {
    required String signatureRequiredMessage,
  }) async {
    final patientBytes = await _patientSignatureController.toPngBytes();
    final witnessBytes = await _staffWitnessSignatureController.toPngBytes();
    if (patientBytes == null || witnessBytes == null) {
      throw Exception(signatureRequiredMessage);
    }
    await MedicalApiService.uploadConsentSignature(
      consentId: consentId,
      signatureRole: 'patient',
      pngBytes: patientBytes,
      signerName: _patientNameCtrl.text.trim(),
    );
    await MedicalApiService.uploadConsentSignature(
      consentId: consentId,
      signatureRole: 'staff_witness',
      pngBytes: witnessBytes,
      signerName: 'Staff witness',
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

  String _apiAdmissionType(String priority) {
    final lower = priority.toLowerCase();
    return lower == 'emergency' || lower == 'critical'
        ? 'emergency'
        : 'elective';
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

  Map<String, dynamic> _admissionFromResponse(Map<String, dynamic> result) {
    final admission = result['admission'];
    if (admission is Map<String, dynamic>) return admission;
    if (admission is Map) return Map<String, dynamic>.from(admission);
    return result;
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: AppTheme.errorRed),
    );
  }

  void _showSuccess(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: AppTheme.successGreen),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.receptionCounterTitle,
      body: RefreshIndicator(
        onRefresh: _loadWorkload,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
          children: [
            _buildHeader(),
            const SizedBox(height: 12),
            _buildModeSwitcher(),
            const SizedBox(height: 12),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 180),
              child: switch (_tabIndex) {
                0 => _buildOpdPanel(key: const ValueKey('opd')),
                1 => _buildIpPanel(key: const ValueKey('ip')),
                _ => _buildTodayPanel(key: const ValueKey('today')),
              },
            ),
            if (_tabIndex != 2) ...[
              const SizedBox(height: 12),
              _buildPatientLookup(),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return _Surface(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final s = AppStrings.of(context);
          final compact = constraints.maxWidth < 620;
          final stats = [
            _CounterStat(
              label: s.receptionCounterStatTodayOpd,
              value: '${_todayAppointments.length}',
              icon: Icons.event_available,
              color: AppTheme.primaryBlue,
            ),
            _CounterStat(
              label: s.receptionCounterStatActiveIp,
              value: '${_activeAdmissions.length}',
              icon: Icons.local_hospital,
              color: AppTheme.primaryTeal,
            ),
          ];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: AppTheme.primaryBlue.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Icon(
                      Icons.point_of_sale,
                      color: AppTheme.primaryBlue,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          s.receptionCounterModeTitle,
                          style: Theme.of(context).textTheme.titleLarge
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                        Text(
                          s.receptionCounterModeSubtitle,
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: s.receptionCounterRefreshTooltip,
                    onPressed: _loadWorkload,
                    icon: const Icon(Icons.refresh),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              if (compact)
                Column(
                  children: stats
                      .map(
                        (stat) => Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: stat,
                        ),
                      )
                      .toList(),
                )
              else
                Row(
                  children: stats
                      .map(
                        (stat) => Expanded(
                          child: Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: stat,
                          ),
                        ),
                      )
                      .toList(),
                ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildPatientLookup() {
    final s = AppStrings.of(context);
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.manage_search,
            title: s.receptionCounterPatientLookupTitle,
            trailing: _selectedPatient == null
                ? null
                : TextButton.icon(
                    onPressed: () => setState(() => _selectedPatient = null),
                    icon: const Icon(Icons.close),
                    label: Text(s.receptionCounterClearPatient),
                  ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _searchCtrl,
                  onChanged: _queuePatientLookup,
                  onSubmitted: _searchPatients,
                  decoration: InputDecoration(
                    labelText: s.receptionCounterPatientLookupHint,
                    prefixIcon: const Icon(Icons.search),
                    suffixIcon: _lookupBusy
                        ? const Padding(
                            padding: EdgeInsets.all(12),
                            child: SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          )
                        : null,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Builder(
                builder: (ctx) => IconButton.filledTonal(
                  tooltip: AppStrings.of(ctx).receptionCounterSearchTooltip,
                  onPressed: () => _searchPatients(_searchCtrl.text),
                  icon: const Icon(Icons.search),
                ),
              ),
            ],
          ),
          if (_lookupError != null) ...[
            const SizedBox(height: 8),
            Text(
              _lookupError!,
              style: TextStyle(color: AppTheme.errorOnSurface),
            ),
          ],
          if (_selectedPatient != null) ...[
            const SizedBox(height: 10),
            _SelectedPatientCard(patient: _selectedPatient!),
          ],
          if (_patientMatches.isNotEmpty) ...[
            const SizedBox(height: 10),
            ..._patientMatches.map(
              (patient) => _PatientMatchTile(
                patient: patient,
                onTap: () => _selectPatient(patient),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildDoctorPicker({bool framed = true}) {
    final s = AppStrings.of(context);
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionTitle(
          icon: Icons.medical_services_outlined,
          title: s.receptionCounterDoctorTitle,
        ),
        const SizedBox(height: 10),
        FutureBuilder<List<Map<String, dynamic>>>(
          future: _doctorsFuture,
          builder: (context, snapshot) {
            final doctors = snapshot.data ?? const [];
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const LinearProgressIndicator(minHeight: 2);
            }
            if (snapshot.hasError) {
              return Text(
                s.receptionCounterDoctorCouldNotLoad,
                style: TextStyle(color: AppTheme.errorOnSurface),
              );
            }
            final search = _doctorSearchText.trim().toLowerCase();
            final filteredDoctors = doctors
                .where((doctor) => _doctorId(doctor) != null)
                .where((doctor) {
                  if (search.isEmpty) return true;
                  return _doctorLabel(doctor).toLowerCase().contains(search);
                })
                .toList();
            final showOptions =
                _doctorSearchFocus.hasFocus &&
                (_doctorSearchCtrl.text.trim() != _selectedDoctorLabel ||
                    search.isEmpty);
            return Column(
              children: [
                TextField(
                  controller: _doctorSearchCtrl,
                  focusNode: _doctorSearchFocus,
                  onTap: () => setState(() {}),
                  onChanged: (value) {
                    setState(() {
                      _doctorSearchText = value;
                      if (value.trim() != _selectedDoctorLabel) {
                        _selectedDoctorId = null;
                        _selectedDoctorUid = null;
                        _selectedDoctorLabel = '';
                      }
                    });
                  },
                  decoration: InputDecoration(
                    labelText: s.receptionCounterDoctorSearchHint,
                    prefixIcon: const Icon(Icons.person_search_outlined),
                  ),
                ),
                if (showOptions) ...[
                  const SizedBox(height: 8),
                  _DoctorTypeaheadList(
                    doctors: filteredDoctors.take(10).toList(),
                    onSelect: _selectDoctor,
                  ),
                ],
              ],
            );
          },
        ),
        if (_selectedDoctorLabel.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(
            _selectedDoctorLabel,
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      ],
    );
    return framed ? _Surface(child: content) : content;
  }

  Widget _buildModeSwitcher() {
    final s = AppStrings.of(context);
    final tabs = [
      (Icons.event_available, s.receptionCounterTabOpd),
      (Icons.local_hospital, s.receptionCounterTabIp),
      (Icons.view_list, s.receptionCounterTabToday),
    ];
    return Container(
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.divider),
      ),
      padding: const EdgeInsets.all(4),
      child: Row(
        children: [
          for (var i = 0; i < tabs.length; i++)
            Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: () {
                  setState(() => _tabIndex = i);
                  if (i == 1 && _patientPhoneCtrl.text.trim().isNotEmpty) {
                    _queueAdmissionLookup(_patientPhoneCtrl.text);
                  }
                },
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 160),
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  decoration: BoxDecoration(
                    color: _tabIndex == i
                        ? AppTheme.primaryBlue.withValues(alpha: 0.14)
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        tabs[i].$1,
                        size: 18,
                        color: _tabIndex == i
                            ? AppTheme.primaryBlue
                            : AppTheme.textSecondary,
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          tabs[i].$2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: _tabIndex == i
                                ? AppTheme.primaryBlue
                                : AppTheme.textSecondary,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildOpdPanel({required Key key}) {
    final s = AppStrings.of(context);
    return _Surface(
      key: key,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.event_available,
            title: s.receptionCounterOpdTitle,
          ),
          const SizedBox(height: 12),
          _buildPatientIdentityFields(),
          const SizedBox(height: 12),
          _buildDoctorPicker(framed: false),
          const SizedBox(height: 12),
          LayoutBuilder(
            builder: (context, constraints) {
              final compact = constraints.maxWidth < 620;
              final children = [
                _DateTimeButton(
                  icon: Icons.calendar_today,
                  label: DateFormat('dd MMM yyyy').format(_appointmentDate),
                  onTap: _pickAppointmentDate,
                ),
                _DateTimeButton(
                  icon: Icons.schedule,
                  label: _appointmentTime.format(context),
                  onTap: _pickAppointmentTime,
                ),
              ];
              if (compact) {
                return Column(
                  children: children
                      .map(
                        (child) => Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: child,
                        ),
                      )
                      .toList(),
                );
              }
              return Row(
                children: [
                  Expanded(child: children[0]),
                  const SizedBox(width: 10),
                  Expanded(child: children[1]),
                ],
              );
            },
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _opReasonCtrl,
            decoration: InputDecoration(
              labelText: s.receptionCounterOpdReason,
              prefixIcon: const Icon(Icons.short_text),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _opNotesCtrl,
            minLines: 2,
            maxLines: 3,
            decoration: InputDecoration(
              labelText: s.receptionCounterOpdNotes,
              prefixIcon: const Icon(Icons.notes),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _opSubmitting ? null : _submitOpdBooking,
            icon: _opSubmitting
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.send),
            label: Text(s.receptionCounterOpdBookButton),
          ),
        ],
      ),
    );
  }

  Widget _buildIpPanel({required Key key}) {
    final s = AppStrings.of(context);
    return _Surface(
      key: key,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.local_hospital,
            title: s.receptionCounterIpTitle,
          ),
          const SizedBox(height: 12),
          _buildPatientIdentityFields(),
          const SizedBox(height: 12),
          _buildAdmissionLookupStatus(),
          const SizedBox(height: 12),
          _buildDoctorPicker(framed: false),
          const SizedBox(height: 12),
          TextField(
            controller: _chiefComplaintCtrl,
            minLines: 2,
            maxLines: 3,
            decoration: InputDecoration(
              labelText: s.receptionCounterIpChiefComplaint,
              prefixIcon: const Icon(Icons.report_problem_outlined),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _diagnosisCtrl,
            decoration: InputDecoration(
              labelText: s.receptionCounterIpDiagnosis,
              prefixIcon: const Icon(Icons.assignment_outlined),
            ),
          ),
          const SizedBox(height: 12),
          LayoutBuilder(
            builder: (context, constraints) {
              final compact = constraints.maxWidth < 620;
              final wardField = _buildWardPicker();
              final bedField = _buildBedPicker();
              if (compact) {
                return Column(
                  children: [wardField, const SizedBox(height: 12), bedField],
                );
              }
              return Row(
                children: [
                  Expanded(child: wardField),
                  const SizedBox(width: 10),
                  Expanded(child: bedField),
                ],
              );
            },
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: _priority,
                  decoration: InputDecoration(
                    labelText: s.receptionCounterIpPriority,
                  ),
                  items: const ['Routine', 'Urgent', 'Emergency', 'Critical']
                      .map(
                        (value) =>
                            DropdownMenuItem(value: value, child: Text(value)),
                      )
                      .toList(),
                  onChanged: (value) =>
                      setState(() => _priority = value ?? _priority),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: _codeStatus,
                  decoration: InputDecoration(
                    labelText: s.receptionCounterIpCodeStatus,
                  ),
                  items: const ['Full Code', 'DNR', 'DNR/DNI', 'Comfort Care']
                      .map(
                        (value) =>
                            DropdownMenuItem(value: value, child: Text(value)),
                      )
                      .toList(),
                  onChanged: (value) =>
                      setState(() => _codeStatus = value ?? _codeStatus),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          CheckboxListTile(
            value: _ipConsentCaptured,
            onChanged: (value) {
              setState(() => _ipConsentCaptured = value ?? false);
              if (value != true) {
                _patientSignatureController.clear();
                _staffWitnessSignatureController.clear();
              }
            },
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            title: Text(s.receptionCounterIpConsentTitle),
            subtitle: Text(
              s.receptionCounterIpConsentSubtitle,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ),
          if (_ipConsentCaptured) ...[
            const SizedBox(height: 8),
            SignaturePadField(
              controller: _patientSignatureController,
              label: s.receptionCounterIpPatientSignatureLabel,
              clearLabel: s.receptionCounterIpSignatureClear,
              emptyHint: s.receptionCounterIpSignatureHint,
            ),
            const SizedBox(height: 12),
            SignaturePadField(
              controller: _staffWitnessSignatureController,
              label: s.receptionCounterIpStaffWitnessSignatureLabel,
              clearLabel: s.receptionCounterIpSignatureClear,
              emptyHint: s.receptionCounterIpSignatureHint,
            ),
          ],
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _ipSubmitting ? null : _submitIpAdmission,
            icon: _ipSubmitting
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.local_hospital),
            label: Text(s.receptionCounterIpCreateButton),
          ),
        ],
      ),
    );
  }

  Widget _buildAdmissionLookupStatus() {
    final s = AppStrings.of(context);
    if (_admissionLookupBusy) {
      return const LinearProgressIndicator(minHeight: 2);
    }
    if (_admissionLookupError != null) {
      return _InfoStrip(
        icon: Icons.warning_amber_outlined,
        color: AppTheme.errorRed,
        text: _admissionLookupError!,
      );
    }
    final lookup = _admissionLookup;
    if (lookup == null) {
      return _InfoStrip(
        icon: Icons.info_outline,
        color: AppTheme.primaryBlue,
        text: s.receptionCounterAdmissionLookupHint,
      );
    }

    final state = _text(lookup['lookup_state']);
    final patient = lookup['patient'];
    final prior = lookup['prior_admissions'];
    final patientName = patient is Map ? _text(patient['name']) : '';
    final hospitalNumber = patient is Map
        ? _text(patient['hospital_number'])
        : '';
    final lastIp = _text(lookup['last_ip_number']);
    final priorCount = prior is List ? prior.length : 0;
    if (state == 'new_patient') {
      return _InfoStrip(
        icon: Icons.person_add_alt_1,
        color: AppTheme.primaryTeal,
        text: s.receptionCounterNewPatient,
      );
    }
    if (state == 'multiple_matches') {
      return _InfoStrip(
        icon: Icons.groups_outlined,
        color: AppTheme.warningAmber,
        text: s.receptionCounterMultipleMatches,
      );
    }
    return _InfoStrip(
      icon: Icons.history,
      color: AppTheme.successGreen,
      text: [
        if (patientName.isNotEmpty) patientName,
        if (hospitalNumber.isNotEmpty) hospitalNumber,
        if (lastIp.isNotEmpty) '${s.receptionCounterLastIpPrefix} $lastIp',
        s.receptionCounterPriorAdmissions(priorCount),
      ].join(' - '),
    );
  }

  Widget _buildWardPicker() {
    final s = AppStrings.of(context);
    return FutureBuilder<List<Map<String, dynamic>>>(
      future: _wardOptionsFuture,
      builder: (context, snapshot) {
        final wards = snapshot.data ?? const [];
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const LinearProgressIndicator(minHeight: 2);
        }
        if (snapshot.hasError || wards.isEmpty) {
          return TextField(
            controller: _wardCtrl,
            decoration: InputDecoration(
              labelText: s.receptionCounterWardFloor,
              prefixIcon: const Icon(Icons.meeting_room_outlined),
            ),
          );
        }
        final selectedValue =
            wards.any((ward) => _wardValue(ward) == _selectedWardValue)
            ? _selectedWardValue
            : null;
        return DropdownButtonFormField<String>(
          initialValue: selectedValue,
          decoration: InputDecoration(
            labelText: s.receptionCounterWardFloor,
            prefixIcon: const Icon(Icons.meeting_room_outlined),
          ),
          isExpanded: true,
          items: wards.map((ward) {
            final label = _wardLabel(ward);
            final available = _intFrom(ward['available_count']);
            final count = _intFrom(ward['bed_count']);
            final suffix = count == null
                ? ''
                : ' - ${available ?? 0}/$count free';
            return DropdownMenuItem(
              value: _wardValue(ward),
              child: Text('$label$suffix', overflow: TextOverflow.ellipsis),
            );
          }).toList(),
          onChanged: (value) {
            final ward = wards.firstWhere(
              (item) => _wardValue(item) == value,
              orElse: () => const <String, dynamic>{},
            );
            _selectWard(ward);
          },
        );
      },
    );
  }

  Widget _buildBedPicker() {
    final s = AppStrings.of(context);
    final future = _bedOptionsFuture;
    if (future == null) {
      return DropdownButtonFormField<String>(
        initialValue: null,
        decoration: InputDecoration(
          labelText: s.receptionCounterBed,
          prefixIcon: const Icon(Icons.bed_outlined),
        ),
        items: const [],
        onChanged: null,
        hint: Text(s.receptionCounterBedSelectWardFirst),
      );
    }
    return FutureBuilder<List<Map<String, dynamic>>>(
      future: future,
      builder: (context, snapshot) {
        final beds = snapshot.data ?? const [];
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const LinearProgressIndicator(minHeight: 2);
        }
        final selectedValue =
            beds.any((bed) => _bedValue(bed) == _selectedBedValue)
            ? _selectedBedValue
            : null;
        if (snapshot.hasError || beds.isEmpty) {
          return DropdownButtonFormField<String>(
            initialValue: null,
            decoration: InputDecoration(
              labelText: s.receptionCounterBed,
              prefixIcon: const Icon(Icons.bed_outlined),
            ),
            items: const [],
            onChanged: null,
            hint: Text(
              snapshot.hasError
                  ? s.receptionCounterBedUnavailable
                  : s.receptionCounterBedNoFree,
            ),
          );
        }
        return DropdownButtonFormField<String>(
          initialValue: selectedValue,
          decoration: InputDecoration(
            labelText: s.receptionCounterBed,
            prefixIcon: const Icon(Icons.bed_outlined),
          ),
          isExpanded: true,
          items: beds
              .map(
                (bed) => DropdownMenuItem(
                  value: _bedValue(bed),
                  child: Text(_bedLabel(bed), overflow: TextOverflow.ellipsis),
                ),
              )
              .toList(),
          onChanged: (value) {
            final bed = beds.firstWhere(
              (item) => _bedValue(item) == value,
              orElse: () => const <String, dynamic>{},
            );
            setState(() {
              _selectedBedValue = value;
              _selectedBedId = _bedId(bed);
              _bedCtrl.text = _text(bed['bed_number']);
            });
          },
        );
      },
    );
  }

  Widget _buildPatientIdentityFields() {
    final s = AppStrings.of(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final compact = constraints.maxWidth < 620;
        final phone = TextField(
          controller: _patientPhoneCtrl,
          keyboardType: TextInputType.phone,
          onChanged: _onPatientPhoneChanged,
          decoration: InputDecoration(
            labelText: s.receptionCounterPatientPhone,
            prefixIcon: const Icon(Icons.phone_outlined),
          ),
        );
        final name = TextField(
          controller: _patientNameCtrl,
          decoration: InputDecoration(
            labelText: s.receptionCounterPatientName,
            prefixIcon: const Icon(Icons.person_outline),
          ),
        );
        if (compact) {
          return Column(children: [phone, const SizedBox(height: 12), name]);
        }
        return Row(
          children: [
            Expanded(child: phone),
            const SizedBox(width: 10),
            Expanded(child: name),
          ],
        );
      },
    );
  }

  Widget _buildTodayPanel({required Key key}) {
    final s = AppStrings.of(context);
    return _Surface(
      key: key,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.view_list,
            title: s.receptionCounterTodayTitle,
            trailing: TextButton(
              onPressed: () => context.push('/appointments'),
              child: Text(s.receptionCounterTodayOpenAppointments),
            ),
          ),
          const SizedBox(height: 12),
          if (_workloadBusy)
            const LinearProgressIndicator(minHeight: 2)
          else ...[
            _MiniList(
              title: s.receptionCounterOpdAppointments,
              emptyText: s.receptionCounterTodayNoAppointments,
              children: _todayAppointments.take(5).map((appointment) {
                return ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.event_available),
                  title: Text(appointment.patientName),
                  subtitle: Text(
                    [
                      appointment.scheduledLabel,
                      appointment.doctorName,
                    ].where((value) => value.isNotEmpty).join(' - '),
                  ),
                  trailing: Text(appointment.status),
                );
              }).toList(),
            ),
            const SizedBox(height: 14),
            _MiniList(
              title: s.receptionCounterActiveAdmissions,
              emptyText: s.receptionCounterTodayNoAdmissions,
              children: _activeAdmissions.take(5).map((admission) {
                final patientName = _text(
                  admission['patient_name'] ?? admission['patientName'],
                );
                final bed = [
                  _text(admission['ward']),
                  if (_text(admission['bed']).isNotEmpty)
                    'Bed ${_text(admission['bed'])}',
                ].where((value) => value.isNotEmpty).join(' - ');
                return ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.local_hospital),
                  title: Text(
                    patientName.isEmpty
                        ? s.receptionCounterUnknownPatient
                        : patientName,
                  ),
                  subtitle: Text(
                    bed.isEmpty ? s.receptionCounterAdmissionActive : bed,
                  ),
                  trailing: Text(_text(admission['status']).toUpperCase()),
                );
              }).toList(),
            ),
          ],
          const SizedBox(height: 10),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              OutlinedButton.icon(
                onPressed: () => context.push('/front-office'),
                icon: const Icon(Icons.space_dashboard_outlined),
                label: Text(s.receptionCounterOpenFrontOffice),
              ),
              OutlinedButton.icon(
                onPressed: () => context.push('/emr/admissions'),
                icon: const Icon(Icons.local_hospital),
                label: Text(s.receptionCounterOpenAdmissions),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _pickAppointmentDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _appointmentDate,
      firstDate: DateTime.now().subtract(const Duration(days: 1)),
      lastDate: DateTime.now().add(const Duration(days: 120)),
    );
    if (picked != null) setState(() => _appointmentDate = picked);
  }

  Future<void> _pickAppointmentTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _appointmentTime,
    );
    if (picked != null) setState(() => _appointmentTime = picked);
  }
}

class _Surface extends StatelessWidget {
  final Widget child;

  const _Surface({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.divider),
      ),
      child: child,
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final IconData icon;
  final String title;
  final Widget? trailing;

  const _SectionTitle({required this.icon, required this.title, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: AppTheme.primaryBlue, size: 20),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            title,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        ?trailing,
      ],
    );
  }
}

class _CounterStat extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;

  const _CounterStat({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.24)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 10),
          Text(
            value,
            style: Theme.of(context).textTheme.titleLarge?.copyWith(
              color: color,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}

class _SelectedPatientCard extends StatelessWidget {
  final Map<String, dynamic> patient;

  const _SelectedPatientCard({required this.patient});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final name = _text(patient['name']);
    final hospitalNumber = _text(patient['hospital_number']);
    final phone = _text(patient['phone']);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.primaryTeal.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.primaryTeal.withValues(alpha: 0.26)),
      ),
      child: Row(
        children: [
          const Icon(Icons.verified_user_outlined, color: AppTheme.primaryTeal),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name.isEmpty ? s.receptionCounterSelectedPatient : name,
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
                Text(
                  [
                    if (hospitalNumber.isNotEmpty) hospitalNumber,
                    if (phone.isNotEmpty) phone,
                  ].join(' - '),
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PatientMatchTile extends StatelessWidget {
  final Map<String, dynamic> patient;
  final VoidCallback onTap;

  const _PatientMatchTile({required this.patient, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final name = _text(patient['name']);
    final hospitalNumber = _text(patient['hospital_number']);
    final phone = _text(patient['phone']);
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: const CircleAvatar(child: Icon(Icons.person_outline)),
      title: Text(name.isEmpty ? s.receptionCounterUnnamedPatient : name),
      subtitle: Text(
        [
          if (hospitalNumber.isNotEmpty) hospitalNumber,
          if (phone.isNotEmpty) phone,
        ].join(' - '),
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}

class _DateTimeButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  const _DateTimeButton({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: onTap,
      icon: Icon(icon),
      label: Text(label, overflow: TextOverflow.ellipsis),
    );
  }
}

class _InfoStrip extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String text;

  const _InfoStrip({
    required this.icon,
    required this.color,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.26)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(text, style: TextStyle(color: AppTheme.textPrimary)),
          ),
        ],
      ),
    );
  }
}

class _DoctorTypeaheadList extends StatelessWidget {
  final List<Map<String, dynamic>> doctors;
  final ValueChanged<Map<String, dynamic>> onSelect;

  const _DoctorTypeaheadList({required this.doctors, required this.onSelect});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (doctors.isEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppTheme.backgroundGrey,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppTheme.divider),
        ),
        child: Text(
          s.receptionCounterDoctorNoneMatch,
          style: TextStyle(color: AppTheme.textSecondary),
        ),
      );
    }

    return Container(
      constraints: const BoxConstraints(maxHeight: 260),
      decoration: BoxDecoration(
        color: AppTheme.backgroundGrey,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.divider),
      ),
      child: ListView.separated(
        shrinkWrap: true,
        itemCount: doctors.length,
        separatorBuilder: (_, _) => Divider(height: 1, color: AppTheme.divider),
        itemBuilder: (context, index) {
          final doctor = doctors[index];
          return ListTile(
            dense: true,
            leading: const Icon(
              Icons.medical_services_outlined,
              color: AppTheme.primaryBlue,
            ),
            title: Text(
              _doctorLabel(doctor),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            onTap: () => onSelect(doctor),
          );
        },
      ),
    );
  }
}

class _MiniList extends StatelessWidget {
  final String title;
  final String emptyText;
  final List<Widget> children;

  const _MiniList({
    required this.title,
    required this.emptyText,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: Theme.of(
            context,
          ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 6),
        if (children.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppTheme.backgroundGrey,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              emptyText,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          )
        else
          ...children,
      ],
    );
  }
}

String _digitsOnly(String value) => value.replaceAll(RegExp(r'\D'), '');

String _formatTime(TimeOfDay time) {
  final hour = time.hour.toString().padLeft(2, '0');
  final minute = time.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}

int? _intFrom(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

String _text(dynamic value) => value?.toString().trim() ?? '';

int? _doctorId(Map<String, dynamic> doctor) => int.tryParse(
  (doctor['user_id'] ?? doctor['userId'] ?? doctor['id'])?.toString() ?? '',
);

String? _doctorUid(Map<String, dynamic> doctor) {
  final value = doctor['uid'] ?? doctor['doctor_uid'] ?? doctor['doctorUid'];
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
}

String _doctorLabel(Map<String, dynamic> doctor) {
  final id = _doctorId(doctor);
  final name =
      doctor['name']?.toString() ?? (id == null ? 'Doctor' : 'Doctor #$id');
  final department = doctor['department']?.toString() ?? '';
  final specialization = doctor['specialization']?.toString() ?? '';
  return [
    name,
    if (department.isNotEmpty) department,
    if (specialization.isNotEmpty) specialization,
  ].join(' - ');
}

String _wardValue(Map<String, dynamic> ward) {
  final id = _text(ward['id']);
  if (id.isNotEmpty) return 'id:$id';
  return _wardLabel(ward);
}

int? _wardId(Map<String, dynamic> ward) => _intFrom(ward['id']);

String _wardLabel(Map<String, dynamic> ward) {
  final label = _text(ward['label']);
  if (label.isNotEmpty) return label;
  final name = _text(ward['name']);
  if (name.isNotEmpty) return name;
  return 'Ward';
}

bool _isEmergencyWard(String label) {
  final lower = label.toLowerCase();
  return lower.contains('icu') ||
      lower == 'er' ||
      lower.contains(' emergency') ||
      lower.startsWith('emergency');
}

int? _bedId(Map<String, dynamic> bed) => _intFrom(bed['id']);

String _bedValue(Map<String, dynamic> bed) {
  final id = _text(bed['id']);
  if (id.isNotEmpty) return 'id:$id';
  return _bedLabel(bed);
}

String _bedLabel(Map<String, dynamic> bed) {
  final number = _text(bed['bed_number']);
  final type = _text(bed['bed_type']).replaceAll('_', ' ');
  if (number.isEmpty) return type.isEmpty ? 'Bed' : type;
  if (type.isEmpty || type == 'unclassified') return number;
  return '$number - $type';
}
