import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/platform_info.dart';
import '../../../core/services/billing_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/patient_identity.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../widgets/billing_document_actions.dart';
import '../widgets/billing_payment_dialog.dart';

DateTime _dateOnly(DateTime value) =>
    DateTime(value.year, value.month, value.day);

String _dateParam(DateTime value) => DateFormat('yyyy-MM-dd').format(value);

@visibleForTesting
String frontOfficeQueueDateLabel(DateTime date, {DateTime? now}) {
  final today = _dateOnly(now ?? DateTime.now());
  final day = _dateOnly(date);
  final offset = day.difference(today).inDays;
  if (offset == 0) return 'Today OP Queue';
  if (offset == 1) return 'Tomorrow OP Queue';
  if (offset == 2) return 'Following Day OP Queue';
  return '${DateFormat('EEE, d MMM').format(day)} OP Queue';
}

@visibleForTesting
bool frontOfficeAppointmentStatusIsTerminal(String status) {
  return const {
    'COMPLETED',
    'CANCELLED',
    'NO_SHOW',
    'RESCHEDULED',
  }.contains(status.trim().toUpperCase());
}

@visibleForTesting
String frontOfficeAppointmentStatusLabel(String status) {
  switch (status.trim().toUpperCase()) {
    case 'NO_SHOW':
      return 'No-show';
    case 'RESCHEDULED':
      return 'Rescheduled';
    case 'IN_PROGRESS':
      return 'In progress';
    case 'COMPLETED':
      return 'Complete';
    case 'CANCELLED':
      return 'Cancelled';
    case 'CONFIRMED':
      return 'Confirmed';
    case 'SCHEDULED':
      return 'Scheduled';
    default:
      final cleaned = status.trim();
      return cleaned.isEmpty ? 'Scheduled' : cleaned;
  }
}

int frontOfficeAdmissionTotalFrom(dynamic data, {int fallbackCount = 0}) {
  if (data is! Map) return fallbackCount;
  final pagination = data['pagination'];
  if (pagination is Map) {
    final total = pagination['total'] ?? pagination['totalItems'];
    final parsed = int.tryParse('${total ?? ''}');
    if (parsed != null) return parsed;
  }
  final total = data['total'] ?? data['count'];
  final parsed = int.tryParse('${total ?? ''}');
  return parsed ?? fallbackCount;
}

@visibleForTesting
int? frontOfficeAdmissionAdviceIdFrom(Map<String, dynamic> row) {
  return _intFrom(
    row['admission_advice_id'] ??
        row['appointment_id'] ??
        row['appointmentId'] ??
        row['id'],
  );
}

@visibleForTesting
Map<String, dynamic>? frontOfficeAdmissionAdvicePatientFrom(
  Map<String, dynamic> row,
) {
  return _patientFromQueueRow(row);
}

@visibleForTesting
bool frontOfficeWorkbenchCanLoad({
  required StaffRole role,
  required AppDeviceMode mode,
}) {
  return RoleFeatures.hasFrontOfficeWorkbench(role) && mode.isWorkbench;
}

@visibleForTesting
bool frontOfficeWorkbenchShouldRequestWorklists({
  required bool roleLoaded,
  required StaffRole role,
  required AppDeviceMode mode,
  required AppDeviceMode? loadedForMode,
  required bool loadInFlight,
  bool force = false,
}) {
  if (!roleLoaded || loadInFlight) return false;
  if (!frontOfficeWorkbenchCanLoad(role: role, mode: mode)) return false;
  return force || loadedForMode != mode;
}

enum FrontOfficeQueueScope { none, mine, full }

@visibleForTesting
FrontOfficeQueueScope frontOfficeQueueScopeForRole(StaffRole role) {
  return switch (role) {
    StaffRole.doctor || StaffRole.dutyDoctor => FrontOfficeQueueScope.mine,
    StaffRole.admin ||
    StaffRole.superAdmin ||
    StaffRole.medicalSuperintendent ||
    StaffRole.nursingSuperintendent ||
    StaffRole.nursingIncharge ||
    StaffRole.opStaffNurse ||
    StaffRole.opIncharge ||
    StaffRole.receptionist ||
    StaffRole.receptionIncharge ||
    StaffRole.billingStaff ||
    StaffRole.billingIncharge ||
    StaffRole.financeIncharge ||
    StaffRole.admissionOfficer ||
    StaffRole.insuranceCoordinator ||
    StaffRole.ipdCounsellor => FrontOfficeQueueScope.full,
    _ => FrontOfficeQueueScope.none,
  };
}

@visibleForTesting
bool frontOfficeCanBookOp(StaffRole role) {
  return switch (role) {
    StaffRole.admin ||
    StaffRole.superAdmin ||
    StaffRole.medicalSuperintendent ||
    StaffRole.receptionist ||
    StaffRole.receptionIncharge ||
    StaffRole.opIncharge ||
    StaffRole.admissionOfficer => true,
    _ => false,
  };
}

@visibleForTesting
bool frontOfficeCanManageAppointmentQueue(StaffRole role) {
  return switch (role) {
    StaffRole.admin ||
    StaffRole.superAdmin ||
    StaffRole.medicalSuperintendent ||
    StaffRole.receptionist ||
    StaffRole.receptionIncharge ||
    StaffRole.opIncharge => true,
    _ => false,
  };
}

@visibleForTesting
bool frontOfficeCanCompleteAppointment(StaffRole role) {
  return frontOfficeCanManageAppointmentQueue(role) ||
      RoleFeatures.hasClinicalEntry(role);
}

@visibleForTesting
Map<String, dynamic> frontOfficeWalkInRegistrationPayload({
  required Map<String, dynamic> patient,
  Map<String, dynamic>? doctor,
  required String reason,
  String? notes,
  String? visitType,
  String? department,
  String? patientCategory,
  String? payerType,
  String? insurerName,
  String? policyNumber,
  String? schemeName,
  String? allergies,
  String? chronicMedications,
  bool mlc = false,
  String? mlcNumber,
  String? mlcNotes,
}) {
  final patientId = _intFrom(patient['id']);
  final doctorId = doctor == null ? null : _doctorId(doctor);
  final resolvedDepartment = _firstText([department, doctor?['department']]);
  final normalizedVisitType = _text(visitType).isEmpty
      ? 'NEW'
      : _text(visitType).toUpperCase();
  final body = <String, dynamic>{
    'patient_id': ?patientId,
    if (_text(patient['phone']).isNotEmpty)
      'patient_phone': _text(patient['phone']),
    if (_text(patient['name']).isNotEmpty)
      'patient_name': _text(patient['name']),
    if (_text(patient['birthday']).isNotEmpty)
      'patient_birthday': _text(patient['birthday']).split('T').first,
    if (_text(patient['gender']).isNotEmpty)
      'patient_gender': _text(patient['gender']),
    if (_text(patient['address']).isNotEmpty)
      'patient_address': _text(patient['address']),
    'doctor_id': ?doctorId,
    if (resolvedDepartment.isNotEmpty) 'department': resolvedDepartment,
    'reason': _text(reason),
    'chief_complaint': _text(reason),
    if (_text(notes).isNotEmpty) 'notes': _text(notes),
    'appointment_time': 'Walk-in',
    'visit_type': normalizedVisitType,
    if (_text(patientCategory).isNotEmpty)
      'patient_category': _text(patientCategory).toLowerCase(),
    if (_text(payerType).isNotEmpty) 'payer_type': _text(payerType),
    if (_text(insurerName).isNotEmpty) 'insurer_name': _text(insurerName),
    if (_text(policyNumber).isNotEmpty) 'policy_number': _text(policyNumber),
    if (_text(schemeName).isNotEmpty) 'scheme_name': _text(schemeName),
    if (_text(allergies).isNotEmpty) 'allergies': _text(allergies),
    if (_text(chronicMedications).isNotEmpty)
      'chronic_medications': _text(chronicMedications),
    if (mlc) 'mlc': true,
    if (mlc && _text(mlcNumber).isNotEmpty) 'mlc_number': _text(mlcNumber),
    if (mlc && _text(mlcNotes).isNotEmpty) 'mlc_notes': _text(mlcNotes),
  };
  body.removeWhere((_, value) => value is String && value.trim().isEmpty);
  return body;
}

@visibleForTesting
bool frontOfficeWardImpliesEmergencyPriority(String wardLabel) {
  final normalized = wardLabel.toUpperCase().replaceAll(
    RegExp(r'[^A-Z0-9]+'),
    ' ',
  );
  return RegExp(
        r'(^| )(ER|ICU|EMERGENCY|CASUALTY)( |$)',
      ).hasMatch(normalized) ||
      normalized.contains('INTENSIVE CARE');
}

@visibleForTesting
String frontOfficeAdmissionPriorityAfterWardSelection({
  required String wardLabel,
  required String currentPriority,
}) {
  return frontOfficeWardImpliesEmergencyPriority(wardLabel)
      ? 'Emergency'
      : currentPriority;
}

@visibleForTesting
List<Map<String, dynamic>> frontOfficeFilterDoctors(
  Iterable<Map<String, dynamic>> doctors,
  String query, {
  String department = '',
  bool requireNumericId = false,
  bool requireUid = false,
  int limit = 20,
}) {
  final normalizedQuery = query.trim().toLowerCase();
  final normalizedDepartment = _departmentKey(department);
  final matches = doctors.where((doctor) {
    if (requireNumericId && _doctorId(doctor) == null) return false;
    if (requireUid && _doctorUid(doctor) == null) return false;
    if (normalizedDepartment.isNotEmpty) {
      final doctorDepartment = _departmentKey(
        frontOfficeDoctorDepartment(doctor),
      );
      if (!doctorDepartment.contains(normalizedDepartment)) return false;
    }
    if (normalizedQuery.isEmpty) return true;
    final haystack = [
      _doctorLabel(doctor),
      doctor['department'],
      doctor['specialty'],
      doctor['specialization'],
      doctor['employee_id'],
      doctor['employeeId'],
    ].map(_text).join(' ').toLowerCase();
    return haystack.contains(normalizedQuery);
  }).toList();
  return matches.take(limit).toList(growable: false);
}

@visibleForTesting
String frontOfficeDoctorDepartment(Map<String, dynamic> doctor) {
  return _firstText([doctor['department'], doctor['doctor_department']]);
}

String _departmentKey(String value) => value.trim().toLowerCase();

@visibleForTesting
bool frontOfficeSameDepartment(String left, String right) {
  final normalizedLeft = _departmentKey(left);
  final normalizedRight = _departmentKey(right);
  return normalizedLeft.isNotEmpty && normalizedLeft == normalizedRight;
}

@visibleForTesting
bool frontOfficePatientMatchesLookupQuery(
  Map<String, dynamic> patient,
  String rawQuery,
) {
  return patientMatchesLookupQuery(patient, rawQuery);
}

@visibleForTesting
bool frontOfficePhoneMeetsMinimum(String value) {
  return patientPhoneMeetsMinimum(value);
}

bool _frontOfficePhoneLikeQuery(String value) {
  return patientPhoneLikeQuery(value);
}

@visibleForTesting
bool frontOfficeLookupQueryReady(String value) {
  return patientLookupQueryReady(value);
}

@visibleForTesting
bool frontOfficePotentialDuplicatePatient({
  required Map<String, dynamic> patient,
  required String name,
  required String phone,
  String? birthday,
}) {
  final phoneDigits = _digitsOnly(phone);
  final patientPhoneDigits = _digitsOnly(patientPhoneFrom(patient));
  if (phoneDigits.length >= 10 && patientPhoneDigits.length >= 10) {
    final queryLast10 = phoneDigits.substring(phoneDigits.length - 10);
    final patientLast10 = patientPhoneDigits.substring(
      patientPhoneDigits.length - 10,
    );
    if (queryLast10 == patientLast10) return true;
  }

  final normalizedName = _normalizedPersonName(name);
  final patientName = _normalizedPersonName(
    patientNameFrom(patient, fallback: ''),
  );
  if (normalizedName.isEmpty || patientName.isEmpty) return false;
  if (normalizedName != patientName) return false;

  final queryBirthDate = _dateText(birthday);
  final patientBirthDate = _dateText(
    patient['birthday'] ?? patient['date_of_birth'] ?? patient['dob'],
  );
  return queryBirthDate.isEmpty ||
      patientBirthDate.isEmpty ||
      queryBirthDate == patientBirthDate;
}

@visibleForTesting
bool frontOfficeShouldOfferPatientCreate({
  required StaffRole role,
  required String query,
  required bool lookupBusy,
  required bool hasSelectedPatient,
  required int matchCount,
}) {
  if (!RoleFeatures.hasPatientRegistryCreate(role) ||
      lookupBusy ||
      hasSelectedPatient ||
      matchCount > 0) {
    return false;
  }
  return frontOfficeLookupQueryReady(query);
}

@visibleForTesting
String frontOfficePatientScopedRoute(
  String path, {
  Map<String, dynamic>? patient,
  Map<String, String> queryParameters = const {},
}) {
  return patientScopedRoute(
    path,
    patient: patient,
    queryParameters: queryParameters,
  );
}

@visibleForTesting
Map<String, dynamic>? frontOfficeInitialPatientFromQuery({
  String? patientUid,
  String? patientId,
  String? patientName,
  String? patientPhone,
  String? hospitalNumber,
}) {
  final patient = <String, dynamic>{};
  void putIfPresent(String key, String? value) {
    final text = value?.trim() ?? '';
    if (text.isNotEmpty) patient[key] = text;
  }

  putIfPresent('uid', patientUid);
  putIfPresent('id', patientId);
  putIfPresent('name', patientName);
  putIfPresent('phone', patientPhone);
  putIfPresent('hospital_number', hospitalNumber);
  return patient.isEmpty ? null : patient;
}

@visibleForTesting
List<String> frontOfficeDepartmentOptionsFromDoctors(
  Iterable<Map<String, dynamic>> doctors,
) {
  final byKey = <String, String>{};
  for (final doctor in doctors) {
    final department = frontOfficeDoctorDepartment(doctor);
    if (department.isEmpty) continue;
    byKey.putIfAbsent(_departmentKey(department), () => department);
  }
  final options = byKey.values.toList(growable: false);
  options.sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
  return options;
}

class FrontOfficeWorkbenchScreen extends StatefulWidget {
  final String? initialPatientUid;
  final String? initialPatientId;
  final String? initialPatientName;
  final String? initialPatientPhone;
  final String? initialHospitalNumber;

  const FrontOfficeWorkbenchScreen({
    super.key,
    this.initialPatientUid,
    this.initialPatientId,
    this.initialPatientName,
    this.initialPatientPhone,
    this.initialHospitalNumber,
  });

  @override
  State<FrontOfficeWorkbenchScreen> createState() =>
      _FrontOfficeWorkbenchScreenState();
}

class _FrontOfficeWorkbenchScreenState
    extends State<FrontOfficeWorkbenchScreen> {
  final _searchCtrl = TextEditingController();
  final _searchFocus = FocusNode();
  final _scrollController = ScrollController();
  final _patientPanelKey = GlobalKey();
  final _queuePanelKey = GlobalKey();
  final _billingPanelKey = GlobalKey();
  final _admissionsPanelKey = GlobalKey();
  Timer? _searchDebounce;
  Future<List<Map<String, dynamic>>>? _doctorsFuture;
  Future<List<Map<String, dynamic>>>? _wardsFuture;

  StaffRole _role = StaffRole.general;
  bool _roleLoaded = false;
  bool _loading = true;
  bool _lookupBusy = false;
  bool _invoiceBusy = false;
  bool _billingActionBusy = false;
  bool _admissionActionBusy = false;
  bool _worklistsLoadInFlight = false;
  AppDeviceMode? _worklistsLoadedForMode;
  int? _queueActionId;
  String? _error;
  String? _lookupError;
  DateTime _queueDate = _dateOnly(DateTime.now());

  List<Map<String, dynamic>> _patientMatches = const [];
  Map<String, dynamic>? _selectedPatient;
  List<Map<String, dynamic>> _todayQueue = const [];
  List<Map<String, dynamic>> _admissionHandoffs = const [];
  List<Map<String, dynamic>> _activeAdmissions = const [];
  int _activeAdmissionsTotal = 0;
  List<Map<String, dynamic>> _patientInvoices = const [];

  FrontOfficeQueueScope get _queueScope => frontOfficeQueueScopeForRole(_role);
  bool get _canBookOp => frontOfficeCanBookOp(_role);
  bool get _canBilling => RoleFeatures.hasBillingDesk(_role);
  bool get _canClinical => RoleFeatures.hasClinicalEntry(_role);
  bool get _canManageOpQueue => frontOfficeCanManageAppointmentQueue(_role);
  bool get _canCompleteOpQueue => frontOfficeCanCompleteAppointment(_role);
  bool get _canPatientLookup => RoleFeatures.hasPatientLookup(_role);
  bool get _canPatientRegistryCreate =>
      RoleFeatures.hasPatientRegistryCreate(_role);
  bool get _canPatientRegistryWrite =>
      RoleFeatures.hasPatientRegistryWrite(_role);
  bool get _canViewAdmissionHandoffs => _canAdmitIp;
  bool get _canAdmitIp => RoleFeatures.hasIpAdmissionAccess(_role);

  @override
  void initState() {
    super.initState();
    _loadInitialState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _canPatientLookup) _searchFocus.requestFocus();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_roleLoaded) {
      unawaited(_requestWorklistsForMode(appDeviceModeForContext(context)));
    }
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchFocus.dispose();
    _scrollController.dispose();
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadInitialState() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    final initialPatient = frontOfficeInitialPatientFromQuery(
      patientUid: widget.initialPatientUid,
      patientId: widget.initialPatientId,
      patientName: widget.initialPatientName,
      patientPhone: widget.initialPatientPhone,
      hospitalNumber: widget.initialHospitalNumber,
    );
    if (!mounted) return;
    setState(() {
      _role = role;
      _roleLoaded = true;
      _loading = false;
      if (initialPatient != null) {
        _selectedPatient = initialPatient;
        _searchCtrl.text = _patientLabel(initialPatient);
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _canPatientLookup) _searchFocus.requestFocus();
    });

    if (initialPatient != null) {
      await _loadInvoicesFor(initialPatient);
      if (!mounted) return;
    }
    await _requestWorklistsForMode(appDeviceModeForContext(context));
  }

  Future<void> _requestWorklistsForMode(
    AppDeviceMode mode, {
    bool force = false,
  }) async {
    if (!frontOfficeWorkbenchShouldRequestWorklists(
      roleLoaded: _roleLoaded,
      role: _role,
      mode: mode,
      loadedForMode: _worklistsLoadedForMode,
      loadInFlight: _worklistsLoadInFlight,
      force: force,
    )) {
      if (mounted &&
          _loading &&
          !frontOfficeWorkbenchCanLoad(role: _role, mode: mode)) {
        setState(() => _loading = false);
      }
      return;
    }

    _worklistsLoadInFlight = true;
    try {
      await _loadWorklists();
      if (mounted && _error == null) {
        _worklistsLoadedForMode = mode;
      }
    } finally {
      _worklistsLoadInFlight = false;
    }
  }

  Future<void> _refreshWorklists() async {
    await _requestWorklistsForMode(
      appDeviceModeForContext(context),
      force: true,
    );
  }

  Future<void> _loadWorklists() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final queueFuture = switch (_queueScope) {
        FrontOfficeQueueScope.full ||
        FrontOfficeQueueScope.mine => _loadAppointmentQueueForSelectedDate(),
        FrontOfficeQueueScope.none => Future<List<dynamic>>.value(const []),
      };
      final admissionHandoffFuture = _canViewAdmissionHandoffs
          ? ScheduleApiService.getAdmissionAdviceQueue(limit: 12)
          : Future<List<Map<String, dynamic>>>.value(const []);
      final results = await Future.wait<dynamic>([
        queueFuture,
        MedicalApiService.getActiveAdmissions(limit: 12),
        admissionHandoffFuture,
      ]);
      if (!mounted) return;
      setState(() {
        _todayQueue = _mapList(results[0]);
        _activeAdmissions = _admissionList(results[1]);
        _activeAdmissionsTotal = _admissionTotal(results[1]);
        _admissionHandoffs = _mapList(results[2]);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<List<dynamic>> _loadAppointmentQueueForSelectedDate() async {
    final doctorId = _queueScope == FrontOfficeQueueScope.mine
        ? await ApiConfig.getStaffId()
        : null;
    final data = await ScheduleApiService.getAppointments(
      doctorId: doctorId,
      date: _dateParam(_queueDate),
      page: 1,
      limit: 100,
    );
    return _mapList(data)
        .where((row) => _appointmentStatus(row) != 'CANCELLED')
        .toList(growable: false);
  }

  Future<void> _setQueueDate(DateTime value) async {
    final next = _dateOnly(value);
    if (_queueDate == next) return;
    setState(() => _queueDate = next);
    await _refreshWorklists();
  }

  void _scrollTo(GlobalKey key) {
    final target = key.currentContext;
    if (target == null) return;
    Scrollable.ensureVisible(
      target,
      duration: const Duration(milliseconds: 240),
      curve: Curves.easeOutCubic,
      alignment: 0.05,
    );
  }

  Future<List<Map<String, dynamic>>> _doctorOptionsFuture() {
    _doctorsFuture ??= ScheduleApiService.getAppointmentDoctors();
    return _doctorsFuture!;
  }

  Future<List<Map<String, dynamic>>> _wardOptionsFuture() {
    _wardsFuture ??= MedicalApiService.getAdmissionWardOptions();
    return _wardsFuture!;
  }

  String? _patientDialogInitialPhone() {
    final raw = _searchCtrl.text.trim();
    final digits = _digitsOnly(raw);
    if (digits.length >= 10 && RegExp(r'^[\d\s()+.-]+$').hasMatch(raw)) {
      return raw;
    }
    return null;
  }

  List<Map<String, dynamic>> _mapList(dynamic value) {
    if (value is Map) {
      value =
          value['appointments'] ??
          value['queue'] ??
          value['data'] ??
          value['items'] ??
          value['rows'];
    }
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  List<Map<String, dynamic>> _admissionList(dynamic data) {
    dynamic value = data;
    if (value is Map) {
      value = value['admissions'] ?? value['data'] ?? value['items'];
      if (value is Map) {
        value = value['admissions'] ?? value['data'] ?? value['items'];
      }
    }
    return _mapList(value);
  }

  int _admissionTotal(dynamic data) {
    return frontOfficeAdmissionTotalFrom(
      data,
      fallbackCount: _admissionList(data).length,
    );
  }

  void _queuePatientLookup(String value) {
    _searchDebounce?.cancel();
    final query = value.trim();
    final selected = _selectedPatient;
    final selectedChanged =
        selected != null && query != _patientLabel(selected);
    final lookupReady = frontOfficeLookupQueryReady(query);
    setState(() {
      if (selectedChanged) {
        _selectedPatient = null;
        _patientInvoices = const [];
      }
      if (!lookupReady) {
        _patientMatches = const [];
        _lookupBusy = false;
        _lookupError = null;
      } else {
        _lookupBusy = true;
        _lookupError = null;
      }
    });
    if (!lookupReady) return;
    _searchDebounce = Timer(
      const Duration(milliseconds: 280),
      () => _searchPatients(value),
    );
  }

  Future<List<Map<String, dynamic>>> _searchPatients(String value) async {
    final query = value.trim();
    if (!frontOfficeLookupQueryReady(query)) {
      setState(() {
        _patientMatches = const [];
        _lookupBusy = false;
        _lookupError = null;
      });
      return const [];
    }
    setState(() {
      _lookupBusy = true;
      _lookupError = null;
    });
    try {
      final matches = (await PatientApiService.search(query, limit: 12))
          .where(
            (patient) => frontOfficePatientMatchesLookupQuery(patient, query),
          )
          .toList(growable: false);
      if (!mounted || _searchCtrl.text.trim() != query) return const [];
      setState(() {
        _patientMatches = matches;
        _lookupBusy = false;
      });
      return matches;
    } catch (e) {
      if (!mounted || _searchCtrl.text.trim() != query) return const [];
      setState(() {
        _lookupError = e.toString();
        _lookupBusy = false;
      });
      return const [];
    }
  }

  Future<void> _handlePatientSearchSubmitted(String value) async {
    final query = value.trim();
    final currentMatch = _bestPatientLookupMatch(_patientMatches, query);
    if (currentMatch != null) {
      await _selectPatient(currentMatch);
      return;
    }

    final matches = await _searchPatients(query);
    if (!mounted) return;
    final loadedMatch = _bestPatientLookupMatch(matches, query);
    if (loadedMatch != null) await _selectPatient(loadedMatch);
  }

  Future<void> _selectPatient(Map<String, dynamic> patient) async {
    setState(() {
      _selectedPatient = patient;
      _patientMatches = const [];
      _searchCtrl.text = _patientLabel(patient);
    });
    await _loadInvoicesFor(patient);
  }

  void _clearSelectedPatient() {
    _searchDebounce?.cancel();
    setState(() {
      _selectedPatient = null;
      _patientMatches = const [];
      _patientInvoices = const [];
      _lookupBusy = false;
      _lookupError = null;
      _searchCtrl.clear();
    });
    _searchFocus.requestFocus();
  }

  bool _queueRowMatchesSelectedPatient(Map<String, dynamic> row) {
    final selected = _selectedPatient;
    if (selected == null) return false;
    final patient = _patientFromQueueRow(row);
    if (patient == null) return false;

    final selectedUid = _text(selected['uid']);
    final patientUid = _text(patient['uid']);
    if (selectedUid.isNotEmpty && patientUid.isNotEmpty) {
      return selectedUid == patientUid;
    }

    final selectedId = _text(selected['id']);
    final patientId = _text(patient['id']);
    if (selectedId.isNotEmpty && patientId.isNotEmpty) {
      return selectedId == patientId;
    }

    final selectedPhone = _digitsOnly(_text(selected['phone']));
    final patientPhone = _digitsOnly(_text(patient['phone']));
    return selectedPhone.isNotEmpty && selectedPhone == patientPhone;
  }

  Future<Map<String, dynamic>> _resolveQueuePatient(
    Map<String, dynamic> queuePatient,
  ) async {
    if (_text(queuePatient['uid']).isNotEmpty) return queuePatient;

    final query = _patientAdmissionQuery(queuePatient);
    if (query.length < 2) return queuePatient;

    setState(() => _lookupBusy = true);
    try {
      final matches = await PatientApiService.search(query, limit: 6);
      return _bestQueuePatientMatch(matches, queuePatient) ?? queuePatient;
    } catch (_) {
      return queuePatient;
    } finally {
      if (mounted) setState(() => _lookupBusy = false);
    }
  }

  Future<void> _selectQueuePatient(Map<String, dynamic> row) async {
    final queuePatient = _patientFromQueueRow(row);
    if (queuePatient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Queue row has no patient details.')),
      );
      return;
    }

    final selected = await _resolveQueuePatient(queuePatient);
    if (!mounted) return;
    await _selectPatient(selected);
    if (!mounted) return;

    final hasUid = _text(selected['uid']).isNotEmpty;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          hasUid
              ? 'Patient selected from queue.'
              : 'Queue patient selected. Search the patient record before billing.',
        ),
        backgroundColor: hasUid ? AppTheme.successGreen : null,
      ),
    );
  }

  Future<void> _startAdmissionFromAdvice(Map<String, dynamic> row) async {
    final advicePatient = frontOfficeAdmissionAdvicePatientFrom(row);
    if (advicePatient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Advice row has no patient details.')),
      );
      return;
    }

    final selected = await _resolveQueuePatient(advicePatient);
    if (!mounted) return;
    await _selectPatient(selected);
    if (!mounted) return;
    await _showIpAdmissionDialog(admissionAdvice: row);
  }

  Future<void> _openBillingForAdvice(Map<String, dynamic> row) async {
    final advicePatient = frontOfficeAdmissionAdvicePatientFrom(row);
    if (advicePatient == null) return;
    final selected = await _resolveQueuePatient(advicePatient);
    if (!mounted) return;
    await _selectPatient(selected);
    if (!mounted) return;
    context.push(_patientRoute('/billing-desk'));
  }

  Future<void> _showAdmissionAdviceDialog(Map<String, dynamic> row) async {
    final patient = frontOfficeAdmissionAdvicePatientFrom(row);
    final doctor = _firstText([
      row['doctor_name'],
      row['doctorName'],
      row['consultant_name'],
      row['consultantName'],
    ]);
    final note = _admissionAdviceNote(row);
    final advisedAt = _admissionAdviceDate(row);
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('OPD to IPD advice'),
        content: SizedBox(
          width: 520,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (patient != null) _PatientCard(patient: patient, onTap: null),
              const SizedBox(height: 10),
              _DetailLine(label: 'Doctor', value: doctor),
              _DetailLine(label: 'Advised at', value: advisedAt),
              _DetailLine(label: 'Advice', value: note),
              const SizedBox(height: 10),
              const _InlineAlert(
                message:
                    'Admission stays pending until ward/bed, billing deposit, and counter consent are handled as applicable.',
                color: AppTheme.warningAmber,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Close'),
          ),
          FilledButton.icon(
            onPressed: () {
              Navigator.pop(dialogContext);
              _startAdmissionFromAdvice(row);
            },
            icon: const Icon(Icons.local_hospital_outlined),
            label: const Text('Assign ward/bed'),
          ),
        ],
      ),
    );
  }

  Future<void> _loadInvoicesFor(Map<String, dynamic>? patient) async {
    final uid = patient?['uid']?.toString();
    if (!_canBilling || uid == null || uid.isEmpty) {
      setState(() => _patientInvoices = const []);
      return;
    }
    setState(() => _invoiceBusy = true);
    try {
      final invoices = await BillingApiService.listInvoices(
        patientUid: uid,
        limit: 8,
      );
      if (!mounted) return;
      setState(() {
        _patientInvoices = invoices;
        _invoiceBusy = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _patientInvoices = const [];
        _invoiceBusy = false;
      });
    }
  }

  Future<void> _createDraftInvoice() async {
    final patient = _selectedPatient;
    final uid = patient?['uid']?.toString();
    if (!_canBilling || patient == null || uid == null || uid.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Select a patient before billing.')),
      );
      return;
    }

    setState(() {
      _billingActionBusy = true;
      _error = null;
    });
    try {
      await BillingApiService.createDraftInvoice(
        patientUid: uid,
        patientName: _text(patient['name']),
        patientPhone: _text(patient['phone']),
        invoiceType: 'OP',
        department: 'Front Office',
        notes: 'Front office OP draft invoice',
      );
      await _loadInvoicesFor(patient);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Draft OP invoice created'),
          backgroundColor: AppTheme.successGreen,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _billingActionBusy = false);
    }
  }

  Future<void> _issueInvoice(Map<String, dynamic> invoice) async {
    final id = _intFrom(invoice['id']);
    if (!_canBilling || id == null) return;

    setState(() {
      _billingActionBusy = true;
      _error = null;
    });
    try {
      await BillingApiService.issueInvoice(id);
      await _loadInvoicesFor(_selectedPatient);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Invoice issued'),
          backgroundColor: AppTheme.successGreen,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _billingActionBusy = false);
    }
  }

  Future<void> _collectInvoicePayment(Map<String, dynamic> invoice) async {
    if (!_canBilling) return;
    final collected = await showBillingPaymentDialog(
      context: context,
      invoice: invoice,
    );
    if (!collected || !mounted) return;
    await _loadInvoicesFor(_selectedPatient);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Payment collected'),
        backgroundColor: AppTheme.successGreen,
      ),
    );
  }

  Future<void> _printInvoiceDocument(
    Map<String, dynamic> invoice,
    BillingDocumentType type,
  ) async {
    if (!_canBilling) return;
    setState(() => _billingActionBusy = true);
    try {
      await printBillingDocument(
        context: context,
        invoice: invoice,
        type: type,
      );
    } finally {
      if (mounted) setState(() => _billingActionBusy = false);
    }
  }

  String _patientLabel(Map<String, dynamic> patient) {
    return patientSearchLabel(patient);
  }

  String? _selectedPatientUid() => _selectedPatient?['uid']?.toString();

  String _patientRoute(String path) {
    return frontOfficePatientScopedRoute(path, patient: _selectedPatient);
  }

  String _patientRecordsRoute() {
    return frontOfficePatientScopedRoute(
      '/patient-records',
      patient: _selectedPatient,
      queryParameters: const {'context': 'front-office'},
    );
  }

  String _patientRecordsUploadRoute() {
    return frontOfficePatientScopedRoute(
      '/patient-records',
      patient: _selectedPatient,
      queryParameters: const {'context': 'front-office', 'action': 'upload'},
    );
  }

  Future<List<Map<String, dynamic>>> _findPotentialDuplicatePatients({
    required String name,
    required String phone,
    String? birthday,
  }) async {
    final seen = <String>{};
    final candidates = <Map<String, dynamic>>[];

    Future<void> addMatches(String query) async {
      if (!frontOfficeLookupQueryReady(query)) return;
      final matches = await PatientApiService.search(query, limit: 8);
      for (final match in matches) {
        final key = _firstText([
          match['uid'],
          match['id'],
          match['hospital_number'],
          match['phone'],
          match['name'],
        ]);
        if (key.isEmpty || !seen.add(key)) continue;
        if (frontOfficePotentialDuplicatePatient(
          patient: match,
          name: name,
          phone: phone,
          birthday: birthday,
        )) {
          candidates.add(match);
        }
      }
    }

    await addMatches(phone);
    await addMatches(name);
    return candidates;
  }

  Future<Map<String, dynamic>?> _showDuplicatePatientDialog(
    List<Map<String, dynamic>> matches,
  ) {
    return showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Possible existing patient'),
        content: SizedBox(
          width: 560,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'A similar patient already exists. Select the existing patient or create a separate new record only if this is truly different.',
                style: TextStyle(color: AppTheme.textSecondary),
              ),
              const SizedBox(height: 12),
              ...matches
                  .take(5)
                  .map(
                    (patient) => Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: _PatientCard(
                        patient: patient,
                        onTap: () => Navigator.pop(dialogContext, patient),
                      ),
                    ),
                  ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () =>
                Navigator.pop(dialogContext, {'_action': 'cancel'}),
            child: const Text('Cancel'),
          ),
          FilledButton.tonalIcon(
            onPressed: () =>
                Navigator.pop(dialogContext, {'_action': 'create'}),
            icon: const Icon(Icons.person_add_alt_1),
            label: const Text('Create separate record'),
          ),
        ],
      ),
    );
  }

  Future<void> _showPatientDialog({
    Map<String, dynamic>? patient,
    String? initialPhone,
  }) async {
    final nameCtrl = TextEditingController(text: patient?['name']?.toString());
    final phoneCtrl = TextEditingController(
      text: patient?['phone']?.toString() ?? initialPhone,
    );
    final genderCtrl = TextEditingController(
      text: patient?['gender']?.toString(),
    );
    final birthdayCtrl = TextEditingController(
      text: patient?['birthday']?.toString().split('T').first,
    );
    final addressCtrl = TextEditingController(
      text: patient?['address']?.toString(),
    );
    var saving = false;
    String? dialogError;

    final saved = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            Future<void> save() async {
              if (!frontOfficePhoneMeetsMinimum(phoneCtrl.text)) {
                setDialogState(() {
                  dialogError = 'Patient phone must be at least 10 digits.';
                });
                return;
              }
              if (patient == null) {
                setDialogState(() {
                  saving = true;
                  dialogError = 'Checking for existing patients...';
                });
                try {
                  final duplicates = await _findPotentialDuplicatePatients(
                    name: nameCtrl.text,
                    phone: phoneCtrl.text,
                    birthday: birthdayCtrl.text,
                  );
                  if (duplicates.isNotEmpty) {
                    if (!dialogContext.mounted) return;
                    setDialogState(() {
                      saving = false;
                      dialogError = null;
                    });
                    final decision = await _showDuplicatePatientDialog(
                      duplicates,
                    );
                    final action = decision?['_action']?.toString();
                    if (action == 'cancel' || decision == null) return;
                    if (action != 'create') {
                      if (dialogContext.mounted) {
                        Navigator.of(dialogContext).pop(decision);
                      }
                      return;
                    }
                  }
                } catch (_) {
                  if (!dialogContext.mounted) return;
                  setDialogState(() {
                    saving = false;
                    dialogError = null;
                  });
                }
              }
              setDialogState(() {
                saving = true;
                dialogError = null;
              });
              try {
                final result = patient == null
                    ? await PatientApiService.createPatient(
                        name: nameCtrl.text,
                        phone: phoneCtrl.text,
                        gender: genderCtrl.text,
                        birthday: birthdayCtrl.text,
                        address: addressCtrl.text,
                      )
                    : await PatientApiService.updatePatient(
                        uid: patient['uid'].toString(),
                        name: nameCtrl.text,
                        phone: phoneCtrl.text,
                        gender: genderCtrl.text,
                        birthday: birthdayCtrl.text,
                        address: addressCtrl.text,
                      );
                if (dialogContext.mounted) {
                  Navigator.of(dialogContext).pop(result);
                }
              } catch (e) {
                setDialogState(() {
                  dialogError = e.toString();
                  saving = false;
                });
              }
            }

            return AlertDialog(
              title: Text(patient == null ? 'New Patient' : 'Edit Patient'),
              content: SizedBox(
                width: 520,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      TextField(
                        controller: nameCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Patient name',
                          prefixIcon: Icon(Icons.badge_outlined),
                        ),
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        controller: phoneCtrl,
                        keyboardType: TextInputType.phone,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Phone',
                          prefixIcon: Icon(Icons.phone_outlined),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: genderCtrl,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Gender',
                                prefixIcon: Icon(Icons.wc_outlined),
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: TextField(
                              controller: birthdayCtrl,
                              keyboardType: TextInputType.datetime,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Birth date',
                                hintText: 'YYYY-MM-DD',
                                prefixIcon: Icon(Icons.cake_outlined),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        controller: addressCtrl,
                        minLines: 2,
                        maxLines: 3,
                        decoration: const InputDecoration(
                          labelText: 'Address',
                          prefixIcon: Icon(Icons.home_outlined),
                        ),
                      ),
                      if (dialogError != null) ...[
                        const SizedBox(height: 10),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            dialogError!,
                            style: TextStyle(color: AppTheme.errorOnSurface),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving ? null : () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                FilledButton.icon(
                  onPressed: saving ? null : save,
                  icon: saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.save_outlined),
                  label: const Text('Save'),
                ),
              ],
            );
          },
        );
      },
    );

    nameCtrl.dispose();
    phoneCtrl.dispose();
    genderCtrl.dispose();
    birthdayCtrl.dispose();
    addressCtrl.dispose();

    if (saved == null || !mounted) return;
    setState(() {
      _selectedPatient = saved;
      _patientMatches = const [];
      _searchCtrl.text = _patientLabel(saved);
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(patient == null ? 'Patient created' : 'Patient updated'),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _loadInvoicesFor(saved);
  }

  Future<void> _showWalkInRegistrationDialog() async {
    final patient = _selectedPatient;
    if (!_canBookOp) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Walk-in registration is not enabled for this role.'),
        ),
      );
      return;
    }
    if (patient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Select a patient before registering a walk-in.'),
        ),
      );
      return;
    }

    final reasonCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    final departmentCtrl = TextEditingController();
    final insurerCtrl = TextEditingController();
    final policyCtrl = TextEditingController();
    final schemeCtrl = TextEditingController();
    final allergiesCtrl = TextEditingController(
      text: _text(patient['allergies']),
    );
    final medicationsCtrl = TextEditingController();
    final mlcNumberCtrl = TextEditingController();
    final mlcNotesCtrl = TextEditingController();
    var selectedVisitType = 'NEW';
    var patientCategory = 'cash';
    var mlc = false;
    Map<String, dynamic>? selectedDoctor;
    var saving = false;
    String? dialogError;

    final registered = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            Future<void> register() async {
              final patientId = _intFrom(patient['id']);
              final patientPhone = _text(patient['phone']);
              final reason = reasonCtrl.text.trim();
              if (patientId == null && _digitsOnly(patientPhone).length < 8) {
                setDialogState(() {
                  dialogError =
                      'Patient needs a saved record or a valid phone number.';
                });
                return;
              }
              if (reason.isEmpty) {
                setDialogState(
                  () => dialogError = 'Enter the visit reason or complaint.',
                );
                return;
              }
              if (selectedVisitType != 'LAB_ONLY' &&
                  selectedDoctor == null &&
                  departmentCtrl.text.trim().isEmpty) {
                setDialogState(
                  () => dialogError = 'Select a doctor or department.',
                );
                return;
              }

              setDialogState(() {
                saving = true;
                dialogError = null;
              });
              try {
                final payload = frontOfficeWalkInRegistrationPayload(
                  patient: patient,
                  doctor: selectedDoctor,
                  reason: reason,
                  notes: notesCtrl.text,
                  visitType: selectedVisitType,
                  department:
                      departmentCtrl.text.trim().isEmpty &&
                          selectedVisitType == 'LAB_ONLY'
                      ? 'Laboratory'
                      : departmentCtrl.text,
                  patientCategory: patientCategory,
                  payerType: patientCategory == 'cash' ? null : patientCategory,
                  insurerName: insurerCtrl.text,
                  policyNumber: policyCtrl.text,
                  schemeName: schemeCtrl.text,
                  allergies: allergiesCtrl.text,
                  chronicMedications: medicationsCtrl.text,
                  mlc: mlc,
                  mlcNumber: mlcNumberCtrl.text,
                  mlcNotes: mlcNotesCtrl.text,
                );
                final result = await ScheduleApiService.registerWalkInPayload(
                  payload,
                );
                if (dialogContext.mounted) {
                  Navigator.of(dialogContext).pop(result);
                }
              } catch (e) {
                setDialogState(() {
                  dialogError = e.toString().replaceFirst('Exception: ', '');
                  saving = false;
                });
              }
            }

            return AlertDialog(
              title: const Text('Register Walk-in'),
              content: SizedBox(
                width: 620,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _PatientCard(
                        patient: patient,
                        selected: true,
                        onTap: () {},
                      ),
                      const SizedBox(height: 12),
                      FutureBuilder<List<Map<String, dynamic>>>(
                        future: _doctorOptionsFuture(),
                        builder: (context, snapshot) {
                          if (snapshot.connectionState ==
                              ConnectionState.waiting) {
                            return const LinearProgressIndicator(minHeight: 2);
                          }
                          if (snapshot.hasError) {
                            return Text(
                              'Could not load doctors.',
                              style: TextStyle(color: AppTheme.errorOnSurface),
                            );
                          }
                          final doctors = frontOfficeFilterDoctors(
                            snapshot.data ?? const [],
                            '',
                            requireNumericId: true,
                            limit: 500,
                          );
                          return _DoctorAutocompleteField(
                            doctors: doctors,
                            selectedDoctor: selectedDoctor,
                            enabled: !saving,
                            labelText: 'Consulting doctor',
                            requireNumericId: true,
                            onSelected: (doctor) {
                              setDialogState(() {
                                selectedDoctor = doctor;
                                final department = _text(doctor?['department']);
                                if (department.isNotEmpty) {
                                  departmentCtrl.text = department;
                                }
                              });
                            },
                          );
                        },
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: departmentCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Department / counter',
                          prefixIcon: Icon(Icons.apartment_outlined),
                        ),
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: DropdownButtonFormField<String>(
                              initialValue: selectedVisitType,
                              decoration: const InputDecoration(
                                labelText: 'Visit type',
                                prefixIcon: Icon(Icons.assignment_outlined),
                              ),
                              items: const [
                                DropdownMenuItem(
                                  value: 'NEW',
                                  child: Text('New consultation'),
                                ),
                                DropdownMenuItem(
                                  value: 'FOLLOW_UP',
                                  child: Text('Follow-up'),
                                ),
                                DropdownMenuItem(
                                  value: 'EMERGENCY',
                                  child: Text('Emergency'),
                                ),
                                DropdownMenuItem(
                                  value: 'LAB_ONLY',
                                  child: Text('Lab only'),
                                ),
                                DropdownMenuItem(
                                  value: 'PAEDIATRIC_OPD',
                                  child: Text('Paediatric OPD'),
                                ),
                              ].toList(),
                              onChanged: saving
                                  ? null
                                  : (value) {
                                      if (value == null) return;
                                      setDialogState(() {
                                        selectedVisitType = value;
                                        if (value == 'LAB_ONLY' &&
                                            departmentCtrl.text
                                                .trim()
                                                .isEmpty) {
                                          departmentCtrl.text = 'Laboratory';
                                        }
                                      });
                                    },
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: DropdownButtonFormField<String>(
                              initialValue: patientCategory,
                              decoration: const InputDecoration(
                                labelText: 'Payment category',
                                prefixIcon: Icon(Icons.payments_outlined),
                              ),
                              items: const [
                                DropdownMenuItem(
                                  value: 'cash',
                                  child: Text('Cash'),
                                ),
                                DropdownMenuItem(
                                  value: 'corporate',
                                  child: Text('Corporate'),
                                ),
                                DropdownMenuItem(
                                  value: 'insurance',
                                  child: Text('Insurance'),
                                ),
                                DropdownMenuItem(
                                  value: 'tpa',
                                  child: Text('TPA'),
                                ),
                                DropdownMenuItem(
                                  value: 'scheme',
                                  child: Text('Govt scheme'),
                                ),
                              ].toList(),
                              onChanged: saving
                                  ? null
                                  : (value) => setDialogState(
                                      () => patientCategory = value ?? 'cash',
                                    ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: reasonCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Visit reason / chief complaint',
                          prefixIcon: Icon(Icons.short_text),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: notesCtrl,
                        minLines: 2,
                        maxLines: 3,
                        decoration: const InputDecoration(
                          labelText: 'Counter intake notes',
                          prefixIcon: Icon(Icons.notes_outlined),
                        ),
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: allergiesCtrl,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Known allergies',
                                prefixIcon: Icon(Icons.warning_amber_outlined),
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: TextField(
                              controller: medicationsCtrl,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Current medicines',
                                prefixIcon: Icon(Icons.medication_outlined),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: insurerCtrl,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Insurer / TPA',
                                prefixIcon: Icon(Icons.account_balance),
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: TextField(
                              controller: policyCtrl,
                              textInputAction: TextInputAction.next,
                              decoration: const InputDecoration(
                                labelText: 'Policy number',
                                prefixIcon: Icon(Icons.confirmation_number),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: schemeCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Scheme name',
                          prefixIcon: Icon(Icons.health_and_safety_outlined),
                        ),
                      ),
                      const SizedBox(height: 4),
                      CheckboxListTile(
                        value: mlc,
                        onChanged: saving
                            ? null
                            : (value) =>
                                  setDialogState(() => mlc = value ?? false),
                        contentPadding: EdgeInsets.zero,
                        controlAffinity: ListTileControlAffinity.leading,
                        title: const Text('Medico-legal case'),
                      ),
                      if (mlc) ...[
                        Row(
                          children: [
                            Expanded(
                              child: TextField(
                                controller: mlcNumberCtrl,
                                textInputAction: TextInputAction.next,
                                decoration: const InputDecoration(
                                  labelText: 'MLC number',
                                  prefixIcon: Icon(Icons.gavel_outlined),
                                ),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: TextField(
                                controller: mlcNotesCtrl,
                                decoration: const InputDecoration(
                                  labelText: 'MLC notes',
                                  prefixIcon: Icon(Icons.description_outlined),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                      if (dialogError != null) ...[
                        const SizedBox(height: 10),
                        Text(
                          dialogError!,
                          style: TextStyle(color: AppTheme.errorOnSurface),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving ? null : () => Navigator.pop(context, null),
                  child: const Text('Cancel'),
                ),
                FilledButton.icon(
                  onPressed: saving ? null : register,
                  icon: saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.how_to_reg_outlined),
                  label: const Text('Register'),
                ),
              ],
            );
          },
        );
      },
    );

    reasonCtrl.dispose();
    notesCtrl.dispose();
    departmentCtrl.dispose();
    insurerCtrl.dispose();
    policyCtrl.dispose();
    schemeCtrl.dispose();
    allergiesCtrl.dispose();
    medicationsCtrl.dispose();
    mlcNumberCtrl.dispose();
    mlcNotesCtrl.dispose();

    if (registered == null || !mounted) return;
    final visitNo = _text(registered['visit_no']);
    final token = _text(registered['token_number']);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          [
            if (visitNo.isEmpty) 'Walk-in registered' else 'Visit $visitNo',
            if (token.isNotEmpty) 'Token $token',
          ].join(' - '),
        ),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _refreshWorklists();
  }

  Future<void> _showOpBookingDialog() async {
    final patient = _selectedPatient;
    if (!_canBookOp) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('OP booking is not enabled for this role.'),
        ),
      );
      return;
    }
    if (patient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Select a patient before booking OP.')),
      );
      return;
    }

    final reasonCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    final doctorCtrl = TextEditingController();
    final doctorFocus = FocusNode();
    final departmentCtrl = TextEditingController();
    final departmentFocus = FocusNode();
    var appointmentDate = DateTime.now();
    var appointmentTime = TimeOfDay.fromDateTime(
      DateTime.now().add(const Duration(hours: 1)),
    );
    var selectedVisitType = 'NEW';
    Map<String, dynamic>? selectedDoctor;
    var saving = false;
    String? dialogError;

    final booked = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            Future<void> pickDate() async {
              final picked = await showDatePicker(
                context: dialogContext,
                initialDate: appointmentDate,
                firstDate: DateTime.now().subtract(const Duration(days: 1)),
                lastDate: DateTime.now().add(const Duration(days: 365)),
              );
              if (picked != null) {
                setDialogState(() => appointmentDate = picked);
              }
            }

            Future<void> pickTime() async {
              final picked = await showTimePicker(
                context: dialogContext,
                initialTime: appointmentTime,
              );
              if (picked != null) {
                setDialogState(() => appointmentTime = picked);
              }
            }

            Future<void> book() async {
              final doctor = selectedDoctor;
              final doctorId = doctor == null ? null : _doctorId(doctor);
              final department = departmentCtrl.text.trim();
              final reason = reasonCtrl.text.trim();
              final patientId = _intFrom(patient['id']);
              final patientPhone = _text(patient['phone']);
              if (doctorId == null && department.isEmpty) {
                setDialogState(
                  () => dialogError = 'Select a doctor or department.',
                );
                return;
              }
              if (patientId == null && _digitsOnly(patientPhone).length < 10) {
                setDialogState(() {
                  dialogError =
                      'Patient needs a saved record or a valid phone number.';
                });
                return;
              }
              if (reason.isEmpty) {
                setDialogState(
                  () => dialogError = 'Enter the reason for visit.',
                );
                return;
              }

              setDialogState(() {
                saving = true;
                dialogError = null;
              });
              try {
                await ScheduleApiService.createAppointment(
                  patientId: patientId,
                  patientPhone: patientId == null ? patientPhone : null,
                  patientName: _text(patient['name']),
                  doctorId: doctorId,
                  doctorUid: doctor == null ? null : _doctorUid(doctor),
                  department: department.isEmpty ? null : department,
                  appointmentDate: DateFormat(
                    'yyyy-MM-dd',
                  ).format(appointmentDate),
                  appointmentTime: _formatTime(appointmentTime),
                  reason: reason,
                  notes: notesCtrl.text.trim().isEmpty
                      ? null
                      : notesCtrl.text.trim(),
                  visitType: selectedVisitType,
                );
                if (dialogContext.mounted) {
                  Navigator.of(dialogContext).pop(true);
                }
              } catch (e) {
                setDialogState(() {
                  dialogError = e.toString().replaceFirst('Exception: ', '');
                  saving = false;
                });
              }
            }

            return AlertDialog(
              title: const Text('Book OP Appointment'),
              content: SizedBox(
                width: 560,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _PatientCard(
                        patient: patient,
                        selected: true,
                        onTap: () {},
                      ),
                      const SizedBox(height: 12),
                      FutureBuilder<List<Map<String, dynamic>>>(
                        future: _doctorOptionsFuture(),
                        builder: (context, snapshot) {
                          if (snapshot.connectionState ==
                              ConnectionState.waiting) {
                            return const LinearProgressIndicator(minHeight: 2);
                          }
                          if (snapshot.hasError) {
                            return Text(
                              'Could not load doctors.',
                              style: TextStyle(color: AppTheme.errorOnSurface),
                            );
                          }
                          final doctors = frontOfficeFilterDoctors(
                            snapshot.data ?? const [],
                            '',
                            requireNumericId: true,
                            limit: 500,
                          );
                          return _OpBookingClinicianFields(
                            doctors: doctors,
                            selectedDoctor: selectedDoctor,
                            doctorController: doctorCtrl,
                            doctorFocus: doctorFocus,
                            departmentController: departmentCtrl,
                            departmentFocus: departmentFocus,
                            enabled: !saving,
                            onDoctorSelected: (doctor) {
                              setDialogState(() {
                                selectedDoctor = doctor;
                                if (doctor == null) return;
                                doctorCtrl.text = _doctorLabel(doctor);
                                final department = frontOfficeDoctorDepartment(
                                  doctor,
                                );
                                if (department.isNotEmpty) {
                                  departmentCtrl.text = department;
                                }
                              });
                              doctorFocus.unfocus();
                            },
                            onDoctorTextChanged: (text) {
                              final selectedLabel = selectedDoctor == null
                                  ? ''
                                  : _doctorLabel(selectedDoctor!);
                              if (selectedDoctor != null &&
                                  text.trim() != selectedLabel) {
                                setDialogState(() => selectedDoctor = null);
                              }
                            },
                            onDepartmentChanged: (department) {
                              if (selectedDoctor == null ||
                                  department.trim().isEmpty ||
                                  frontOfficeSameDepartment(
                                    frontOfficeDoctorDepartment(
                                      selectedDoctor!,
                                    ),
                                    department,
                                  )) {
                                return;
                              }
                              setDialogState(() => selectedDoctor = null);
                              doctorCtrl.clear();
                            },
                          );
                        },
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: _DateTimeButton(
                              icon: Icons.calendar_today,
                              label: DateFormat(
                                'dd MMM yyyy',
                              ).format(appointmentDate),
                              onTap: saving ? null : pickDate,
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: _DateTimeButton(
                              icon: Icons.schedule,
                              label: appointmentTime.format(dialogContext),
                              onTap: saving ? null : pickTime,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: selectedVisitType,
                        decoration: const InputDecoration(
                          labelText: 'Visit type',
                          prefixIcon: Icon(Icons.assignment_outlined),
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: 'NEW',
                            child: Text('New consultation'),
                          ),
                          DropdownMenuItem(
                            value: 'FOLLOW_UP',
                            child: Text('Follow-up'),
                          ),
                          DropdownMenuItem(
                            value: 'TELE',
                            child: Text('Teleconsult'),
                          ),
                          DropdownMenuItem(
                            value: 'LAB_ONLY',
                            child: Text('Lab-only visit'),
                          ),
                          DropdownMenuItem(
                            value: 'PAEDIATRIC_OPD',
                            child: Text('Paediatric OPD'),
                          ),
                        ],
                        onChanged: saving
                            ? null
                            : (value) {
                                if (value == null) return;
                                setDialogState(() => selectedVisitType = value);
                              },
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: reasonCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Reason / chief complaint',
                          prefixIcon: Icon(Icons.short_text),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: notesCtrl,
                        minLines: 2,
                        maxLines: 3,
                        decoration: const InputDecoration(
                          labelText: 'Counter notes',
                          prefixIcon: Icon(Icons.notes_outlined),
                        ),
                      ),
                      if (dialogError != null) ...[
                        const SizedBox(height: 10),
                        Text(
                          dialogError!,
                          style: TextStyle(color: AppTheme.errorOnSurface),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving
                      ? null
                      : () => Navigator.pop(context, false),
                  child: const Text('Cancel'),
                ),
                FilledButton.icon(
                  onPressed: saving ? null : book,
                  icon: saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.event_available),
                  label: const Text('Book OP'),
                ),
              ],
            );
          },
        );
      },
    );

    reasonCtrl.dispose();
    notesCtrl.dispose();
    doctorCtrl.dispose();
    doctorFocus.dispose();
    departmentCtrl.dispose();
    departmentFocus.dispose();

    if (booked != true || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('OP appointment booked'),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _refreshWorklists();
  }

  Future<void> _showIpAdmissionDialog({
    Map<String, dynamic>? admissionAdvice,
  }) async {
    final patient =
        _selectedPatient ??
        (admissionAdvice == null
            ? null
            : frontOfficeAdmissionAdvicePatientFrom(admissionAdvice));
    if (!_canAdmitIp) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('IP admission is not enabled for this role.'),
        ),
      );
      return;
    }
    if (patient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Select a patient before admitting IP.')),
      );
      return;
    }

    final adviceId = admissionAdvice == null
        ? null
        : frontOfficeAdmissionAdviceIdFrom(admissionAdvice);
    final adviceNote = _admissionAdviceNote(admissionAdvice);
    final chiefComplaintCtrl = TextEditingController(text: adviceNote);
    final diagnosisCtrl = TextEditingController();
    Map<String, dynamic>? selectedDoctor;
    Map<String, dynamic>? selectedWard;
    Map<String, dynamic>? selectedBed;
    Future<List<Map<String, dynamic>>> bedOptionsFuture = Future.value(
      const <Map<String, dynamic>>[],
    );
    var priority = 'Routine';
    var codeStatus = 'Full Code';
    var consentCaptured = false;
    var saving = false;
    String? dialogError;

    final admitted = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            Future<void> admit() async {
              final doctor = selectedDoctor;
              final doctorUid = doctor == null ? null : _doctorUid(doctor);
              final patientQuery = _patientAdmissionQuery(patient);
              final chiefComplaint = chiefComplaintCtrl.text.trim();
              final isEmergency = _apiAdmissionPriority(priority) == 'emergent';

              if (doctorUid == null || doctorUid.isEmpty) {
                setDialogState(
                  () => dialogError = 'Select an admitting doctor.',
                );
                return;
              }
              if (chiefComplaint.isEmpty) {
                setDialogState(
                  () => dialogError = 'Enter the chief complaint.',
                );
                return;
              }
              if (patientQuery.isEmpty) {
                setDialogState(
                  () =>
                      dialogError = 'The selected patient needs an identifier.',
                );
                return;
              }
              if (!isEmergency && _bedId(selectedBed) == null) {
                setDialogState(
                  () => dialogError = 'Select a bed for routine IP admission.',
                );
                return;
              }

              setDialogState(() {
                saving = true;
                dialogError = null;
              });
              setState(() => _admissionActionBusy = true);
              try {
                final result = await MedicalApiService.admitPatient({
                  'patient_query': patientQuery,
                  if (_text(patient['uid']).isNotEmpty)
                    'patient_uid': _text(patient['uid']),
                  if (_text(patient['phone']).isNotEmpty)
                    'patient_phone': _text(patient['phone']),
                  if (_text(patient['name']).isNotEmpty)
                    'patient_name': _text(patient['name']),
                  'admission_advice_id': ?adviceId,
                  'admitting_doctor': doctorUid,
                  'chief_complaint': chiefComplaint,
                  if (diagnosisCtrl.text.trim().isNotEmpty)
                    'provisional_diagnosis': diagnosisCtrl.text.trim(),
                  if (_wardLabel(selectedWard).isNotEmpty)
                    'ward': _wardLabel(selectedWard),
                  if (_bedId(selectedBed) != null)
                    'bed_id': _bedId(selectedBed),
                  if (_bedLabel(selectedBed).isNotEmpty)
                    'bed': _bedLabel(selectedBed),
                  'priority': _apiAdmissionPriority(priority),
                  'admission_type': _apiAdmissionType(priority),
                  'code_status': _apiCodeStatus(codeStatus),
                  'counter_consent_captured': consentCaptured,
                });
                if (dialogContext.mounted) {
                  Navigator.of(
                    dialogContext,
                  ).pop(_admissionFromResponse(result));
                }
              } catch (e) {
                setDialogState(() {
                  dialogError = e.toString().replaceFirst('Exception: ', '');
                  saving = false;
                });
              } finally {
                if (mounted) setState(() => _admissionActionBusy = false);
              }
            }

            return AlertDialog(
              title: const Text('Create IP Admission'),
              content: SizedBox(
                width: 620,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _PatientCard(
                        patient: patient,
                        selected: true,
                        onTap: () {},
                      ),
                      if (admissionAdvice != null) ...[
                        const SizedBox(height: 12),
                        _InlineAlert(
                          message: _admissionAdviceSummary(admissionAdvice),
                          color: AppTheme.primaryTeal,
                        ),
                      ],
                      const SizedBox(height: 12),
                      FutureBuilder<List<Map<String, dynamic>>>(
                        future: _doctorOptionsFuture(),
                        builder: (context, snapshot) {
                          if (snapshot.connectionState ==
                              ConnectionState.waiting) {
                            return const LinearProgressIndicator(minHeight: 2);
                          }
                          if (snapshot.hasError) {
                            return Text(
                              'Could not load doctors.',
                              style: TextStyle(color: AppTheme.errorOnSurface),
                            );
                          }
                          final doctors = frontOfficeFilterDoctors(
                            snapshot.data ?? const [],
                            '',
                            requireUid: true,
                            limit: 500,
                          );
                          return _DoctorAutocompleteField(
                            doctors: doctors,
                            selectedDoctor: selectedDoctor,
                            enabled: !saving,
                            labelText: 'Admitting doctor',
                            requireUid: true,
                            onSelected: (doctor) {
                              setDialogState(() => selectedDoctor = doctor);
                            },
                          );
                        },
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: chiefComplaintCtrl,
                        minLines: 2,
                        maxLines: 3,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Chief complaint',
                          prefixIcon: Icon(Icons.report_problem_outlined),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: diagnosisCtrl,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Provisional diagnosis',
                          prefixIcon: Icon(Icons.assignment_outlined),
                        ),
                      ),
                      const SizedBox(height: 12),
                      LayoutBuilder(
                        builder: (context, constraints) {
                          final compact = constraints.maxWidth < 560;
                          final wardPicker = FutureBuilder<List<Map<String, dynamic>>>(
                            future: _wardOptionsFuture(),
                            builder: (context, snapshot) {
                              if (snapshot.connectionState ==
                                  ConnectionState.waiting) {
                                return const LinearProgressIndicator(
                                  minHeight: 2,
                                );
                              }
                              final wards = snapshot.data ?? const [];
                              return DropdownButtonFormField<int>(
                                initialValue: _wardId(selectedWard),
                                isExpanded: true,
                                decoration: const InputDecoration(
                                  labelText: 'Ward / floor',
                                  prefixIcon: Icon(Icons.apartment_outlined),
                                ),
                                items: wards
                                    .map(
                                      (ward) => DropdownMenuItem<int>(
                                        value: _wardId(ward),
                                        child: Text(
                                          _wardLabel(ward),
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                    )
                                    .where((item) => item.value != null)
                                    .toList(),
                                onChanged: saving
                                    ? null
                                    : (wardId) {
                                        final ward = wards.firstWhere(
                                          (item) => _wardId(item) == wardId,
                                          orElse: () => <String, dynamic>{},
                                        );
                                        setDialogState(() {
                                          selectedWard = ward.isEmpty
                                              ? null
                                              : ward;
                                          selectedBed = null;
                                          priority =
                                              frontOfficeAdmissionPriorityAfterWardSelection(
                                                wardLabel: _wardLabel(
                                                  selectedWard,
                                                ),
                                                currentPriority: priority,
                                              );
                                          bedOptionsFuture =
                                              MedicalApiService.getAdmissionBedOptions(
                                                wardId: _wardId(selectedWard),
                                                wardLabel: _wardLabel(
                                                  selectedWard,
                                                ),
                                              );
                                        });
                                      },
                              );
                            },
                          );
                          final bedPicker =
                              FutureBuilder<List<Map<String, dynamic>>>(
                                future: bedOptionsFuture,
                                builder: (context, snapshot) {
                                  final waiting =
                                      snapshot.connectionState ==
                                      ConnectionState.waiting;
                                  final beds = snapshot.data ?? const [];
                                  if (waiting) {
                                    return const LinearProgressIndicator(
                                      minHeight: 2,
                                    );
                                  }
                                  return DropdownButtonFormField<int>(
                                    initialValue: _bedId(selectedBed),
                                    isExpanded: true,
                                    decoration: const InputDecoration(
                                      labelText: 'Bed',
                                      prefixIcon: Icon(Icons.bed_outlined),
                                    ),
                                    items: beds
                                        .map(
                                          (bed) => DropdownMenuItem<int>(
                                            value: _bedId(bed),
                                            child: Text(
                                              _bedLabel(bed),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                        )
                                        .where((item) => item.value != null)
                                        .toList(),
                                    onChanged: saving
                                        ? null
                                        : (bedId) {
                                            setDialogState(() {
                                              selectedBed = beds.firstWhere(
                                                (bed) => _bedId(bed) == bedId,
                                                orElse: () =>
                                                    <String, dynamic>{},
                                              );
                                              if (selectedBed!.isEmpty) {
                                                selectedBed = null;
                                              }
                                            });
                                          },
                                  );
                                },
                              );
                          if (compact) {
                            return Column(
                              children: [
                                wardPicker,
                                const SizedBox(height: 12),
                                bedPicker,
                              ],
                            );
                          }
                          return Row(
                            children: [
                              Expanded(child: wardPicker),
                              const SizedBox(width: 10),
                              Expanded(child: bedPicker),
                            ],
                          );
                        },
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: DropdownButtonFormField<String>(
                              initialValue: priority,
                              decoration: const InputDecoration(
                                labelText: 'Priority',
                              ),
                              items:
                                  const [
                                        'Routine',
                                        'Urgent',
                                        'Emergency',
                                        'Critical',
                                      ]
                                      .map(
                                        (value) => DropdownMenuItem(
                                          value: value,
                                          child: Text(value),
                                        ),
                                      )
                                      .toList(),
                              onChanged: saving
                                  ? null
                                  : (value) => setDialogState(
                                      () => priority = value ?? priority,
                                    ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: DropdownButtonFormField<String>(
                              initialValue: codeStatus,
                              decoration: const InputDecoration(
                                labelText: 'Code status',
                              ),
                              items:
                                  const [
                                        'Full Code',
                                        'DNR',
                                        'DNR/DNI',
                                        'Comfort Care',
                                      ]
                                      .map(
                                        (value) => DropdownMenuItem(
                                          value: value,
                                          child: Text(value),
                                        ),
                                      )
                                      .toList(),
                              onChanged: saving
                                  ? null
                                  : (value) => setDialogState(
                                      () => codeStatus = value ?? codeStatus,
                                    ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      CheckboxListTile(
                        value: consentCaptured,
                        onChanged: saving
                            ? null
                            : (value) => setDialogState(
                                () => consentCaptured = value ?? false,
                              ),
                        contentPadding: EdgeInsets.zero,
                        controlAffinity: ListTileControlAffinity.leading,
                        title: const Text(
                          'Treatment consent captured at counter',
                        ),
                        subtitle: Text(
                          'Emergency admissions can proceed without a bed; routine admissions require a selected bed.',
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ),
                      if (dialogError != null) ...[
                        const SizedBox(height: 10),
                        Text(
                          dialogError!,
                          style: TextStyle(color: AppTheme.errorOnSurface),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving ? null : () => Navigator.pop(context, null),
                  child: const Text('Cancel'),
                ),
                FilledButton.icon(
                  onPressed: saving ? null : admit,
                  icon: saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.local_hospital),
                  label: const Text('Create IP'),
                ),
              ],
            );
          },
        );
      },
    );

    chiefComplaintCtrl.dispose();
    diagnosisCtrl.dispose();

    if (admitted == null || !mounted) return;
    final ipNumber = _text(admitted['ip_number']);
    final hospitalNumber = _text(
      admitted['patient_hospital_number'] ?? admitted['hospital_number'],
    );
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          [
            if (ipNumber.isEmpty)
              'IP admission created'
            else
              'IP admission $ipNumber created',
            if (hospitalNumber.isNotEmpty) 'Hospital ID $hospitalNumber',
          ].join(' - '),
        ),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    await _refreshWorklists();
  }

  Future<bool> _confirmQueueAction({
    required String title,
    required String message,
    required String confirmLabel,
    Color? confirmColor,
  }) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: confirmColor == null
                ? null
                : FilledButton.styleFrom(backgroundColor: confirmColor),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    return confirmed == true;
  }

  Future<void> _runQueueAction(
    Map<String, dynamic> row, {
    required String successMessage,
    required Future<void> Function(int id) action,
  }) async {
    final id = _appointmentId(row);
    if (id == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Appointment ID is missing.')),
      );
      return;
    }

    setState(() {
      _queueActionId = id;
      _error = null;
    });
    try {
      await action(id);
      await _refreshWorklists();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(successMessage),
          backgroundColor: AppTheme.successGreen,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _queueActionId = null);
    }
  }

  Future<void> _confirmQueueAppointment(Map<String, dynamic> row) async {
    await _runQueueAction(
      row,
      successMessage: 'Patient checked in',
      action: (id) => ScheduleApiService.confirmAppointment(id, {
        'confirmation_notes': 'Checked in from Front Office Workbench',
      }).then((_) {}),
    );
  }

  Future<void> _completeQueueAppointment(Map<String, dynamic> row) async {
    final notesCtrl = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Complete appointment'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Mark ${_queuePatientName(row)} as completed?'),
            const SizedBox(height: 12),
            TextField(
              controller: notesCtrl,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: 'Visit notes (optional)',
                prefixIcon: Icon(Icons.notes_outlined),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton.icon(
            onPressed: () => Navigator.pop(dialogContext, true),
            icon: const Icon(Icons.done_all),
            label: const Text('Complete'),
          ),
        ],
      ),
    );
    final notes = notesCtrl.text.trim();
    notesCtrl.dispose();
    if (confirmed != true) return;

    await _runQueueAction(
      row,
      successMessage: 'Appointment completed',
      action: (id) => ScheduleApiService.completeAppointmentStaff(
        id,
        notes: notes.isEmpty ? null : notes,
      ).then((_) {}),
    );
  }

  Future<void> _markQueueNoShow(Map<String, dynamic> row) async {
    final confirmed = await _confirmQueueAction(
      title: 'Mark no-show',
      message: 'Mark ${_queuePatientName(row)} as no-show?',
      confirmLabel: 'No-show',
      confirmColor: AppTheme.textSecondary,
    );
    if (!confirmed) return;
    await _runQueueAction(
      row,
      successMessage: 'Appointment marked no-show',
      action: (id) => ScheduleApiService.markNoShow(id).then((_) {}),
    );
  }

  Future<void> _rescheduleQueueAppointment(Map<String, dynamic> row) async {
    final currentDate = _appointmentDate(row) ?? _queueDate;
    final currentTime = _appointmentTime(row) ?? TimeOfDay.now();
    var appointmentDate = currentDate;
    var appointmentTime = currentTime;
    final notesCtrl = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) {
          Future<void> pickDate() async {
            final picked = await showDatePicker(
              context: dialogContext,
              initialDate: appointmentDate,
              firstDate: DateTime.now().subtract(const Duration(days: 1)),
              lastDate: DateTime.now().add(const Duration(days: 365)),
            );
            if (picked != null) {
              setDialogState(() => appointmentDate = picked);
            }
          }

          Future<void> pickTime() async {
            final picked = await showTimePicker(
              context: dialogContext,
              initialTime: appointmentTime,
            );
            if (picked != null) {
              setDialogState(() => appointmentTime = picked);
            }
          }

          return AlertDialog(
            title: const Text('Reschedule appointment'),
            content: SizedBox(
              width: 420,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_queuePatientName(row)),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: _DateTimeButton(
                          icon: Icons.calendar_today,
                          label: DateFormat(
                            'dd MMM yyyy',
                          ).format(appointmentDate),
                          onTap: pickDate,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _DateTimeButton(
                          icon: Icons.schedule,
                          label: appointmentTime.format(dialogContext),
                          onTap: pickTime,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: notesCtrl,
                    maxLines: 2,
                    decoration: const InputDecoration(
                      labelText: 'Reschedule note',
                      prefixIcon: Icon(Icons.notes_outlined),
                    ),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: const Text('Cancel'),
              ),
              FilledButton.icon(
                onPressed: () => Navigator.pop(dialogContext, true),
                icon: const Icon(Icons.event_repeat_outlined),
                label: const Text('Reschedule'),
              ),
            ],
          );
        },
      ),
    );
    final notes = notesCtrl.text.trim();
    notesCtrl.dispose();
    if (confirmed != true) return;

    await _runQueueAction(
      row,
      successMessage: 'Appointment rescheduled',
      action: (id) => ScheduleApiService.rescheduleAppointmentStaff(
        id,
        appointmentDate: _dateParam(appointmentDate),
        appointmentTime: _formatTime(appointmentTime),
        notes: notes.isEmpty
            ? 'Rescheduled from Front Office Workbench'
            : notes,
      ).then((_) {}),
    );
  }

  Future<void> _cancelQueueAppointment(Map<String, dynamic> row) async {
    final reasonCtrl = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Cancel appointment'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_queuePatientName(row)),
              const SizedBox(height: 12),
              TextField(
                controller: reasonCtrl,
                maxLines: 2,
                decoration: const InputDecoration(
                  labelText: 'Cancellation reason',
                  prefixIcon: Icon(Icons.notes_outlined),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Keep appointment'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppTheme.errorRed),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Cancel appointment'),
          ),
        ],
      ),
    );
    final reason = reasonCtrl.text.trim();
    reasonCtrl.dispose();
    if (confirmed != true) return;

    await _runQueueAction(
      row,
      successMessage: 'Appointment cancelled',
      action: (id) => ScheduleApiService.cancelAppointmentStaff(
        id,
        reason: reason.isEmpty
            ? 'Cancelled from Front Office Workbench'
            : reason,
      ).then((_) {}),
    );
  }

  @override
  Widget build(BuildContext context) {
    final mode = appDeviceModeForContext(context);
    if (!_roleLoaded) {
      return const StaffScaffold(
        title: 'Front Office',
        body: Center(child: CircularProgressIndicator()),
      );
    }

    if (!RoleFeatures.hasFrontOfficeWorkbench(_role)) {
      return StaffScaffold(
        title: 'Front Office',
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _buildUnavailablePanel(
              icon: Icons.lock_outline,
              title: 'Front Office unavailable',
              message: 'Front Office is not enabled for ${_role.displayName}.',
            ),
          ],
        ),
      );
    }

    if (!mode.isWorkbench) {
      return StaffScaffold(
        title: 'Front Office',
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _buildUnavailablePanel(
              icon: Icons.devices_outlined,
              title: 'Workstation mode required',
              message:
                  'Patient search, OP booking, admissions, billing, and clinical entry open on tablet or desktop workstations.',
              actions: [
                _ActionTile(
                  icon: Icons.schedule_outlined,
                  label: 'Roster',
                  color: AppTheme.primaryTeal,
                  onTap: () => context.push('/schedule'),
                ),
                _ActionTile(
                  icon: Icons.event_available_outlined,
                  label: 'Leave',
                  color: AppTheme.primaryBlue,
                  onTap: () => context.push('/leave'),
                ),
                _ActionTile(
                  icon: Icons.person_outline,
                  label: 'Profile',
                  color: AppTheme.warningAmber,
                  onTap: () => context.push('/profile'),
                ),
              ],
            ),
          ],
        ),
      );
    }

    return StaffScaffold(
      title: 'Front Office Workbench',
      body: RefreshIndicator(
        onRefresh: _refreshWorklists,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 980;
            return ListView(
              controller: _scrollController,
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
              children: [
                _buildHeader(mode),
                const SizedBox(height: 12),
                if (_error != null)
                  _InlineAlert(message: _error!, color: AppTheme.errorRed),
                if (_selectedPatient != null) ...[
                  _buildPatientContextStrip(_selectedPatient!),
                  const SizedBox(height: 12),
                ],
                if (_loading) const LinearProgressIndicator(minHeight: 2),
                if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        flex: 5,
                        child: Column(
                          children: [
                            KeyedSubtree(
                              key: _patientPanelKey,
                              child: _buildPatientPanel(),
                            ),
                            const SizedBox(height: 12),
                            _buildActionPanel(),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        flex: 4,
                        child: Column(
                          children: [
                            KeyedSubtree(
                              key: _queuePanelKey,
                              child: _buildQueuePanel(),
                            ),
                            const SizedBox(height: 12),
                            KeyedSubtree(
                              key: _billingPanelKey,
                              child: _buildBillingPanel(),
                            ),
                            const SizedBox(height: 12),
                            KeyedSubtree(
                              key: _admissionsPanelKey,
                              child: _buildAdmissionsPanel(),
                            ),
                          ],
                        ),
                      ),
                    ],
                  )
                else ...[
                  KeyedSubtree(
                    key: _patientPanelKey,
                    child: _buildPatientPanel(),
                  ),
                  const SizedBox(height: 12),
                  _buildActionPanel(),
                  const SizedBox(height: 12),
                  KeyedSubtree(key: _queuePanelKey, child: _buildQueuePanel()),
                  const SizedBox(height: 12),
                  KeyedSubtree(
                    key: _billingPanelKey,
                    child: _buildBillingPanel(),
                  ),
                  const SizedBox(height: 12),
                  KeyedSubtree(
                    key: _admissionsPanelKey,
                    child: _buildAdmissionsPanel(),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildHeader(AppDeviceMode mode) {
    return _Surface(
      child: Wrap(
        spacing: 12,
        runSpacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppTheme.primaryBlue.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(
              Icons.space_dashboard_outlined,
              color: AppTheme.primaryBlue,
            ),
          ),
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 220, maxWidth: 520),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Front Office Workbench',
                  style: Theme.of(
                    context,
                  ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                ),
                Text(
                  _role.displayName,
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
          _Metric(
            icon: Icons.event_available,
            label: 'Today OP Queue',
            value: '${_todayQueue.length}',
            color: AppTheme.primaryTeal,
            onTap: () => _scrollTo(_queuePanelKey),
          ),
          _Metric(
            icon: Icons.local_hospital,
            label: 'Active IP Admissions',
            value: '$_activeAdmissionsTotal',
            color: AppTheme.primaryBlue,
            onTap: () => _scrollTo(_admissionsPanelKey),
          ),
          if (_canViewAdmissionHandoffs)
            _Metric(
              icon: Icons.move_down_outlined,
              label: 'OPD -> IPD Handoff',
              value: '${_admissionHandoffs.length}',
              color: AppTheme.warningAmber,
              onTap: () => _scrollTo(_admissionsPanelKey),
            ),
          Chip(
            avatar: const Icon(Icons.devices_outlined, size: 18),
            label: Text(mode.apiValue.toUpperCase()),
          ),
          if (_canBookOp)
            FilledButton.icon(
              onPressed: _showOpBookingDialog,
              icon: const Icon(Icons.event_available_outlined),
              label: const Text('Book OP Appointment'),
            ),
          IconButton.filledTonal(
            tooltip: 'Refresh',
            onPressed: _refreshWorklists,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
    );
  }

  Widget _buildPatientContextStrip(Map<String, dynamic> patient) {
    final appointments = _todayQueue
        .where(_queueRowMatchesSelectedPatient)
        .toList(growable: false);
    final invoiceDue = _patientInvoices.fold<num>(
      0,
      (total, invoice) => total + billingInvoiceAmountDue(invoice),
    );
    final demographics = [
      patientHospitalNumberFrom(patient),
      patientNameFrom(patient),
      patientPhoneFrom(patient),
      [
        patientAgeFrom(patient).isEmpty ? null : '${patientAgeFrom(patient)}y',
        patientGenderFrom(patient),
      ].whereType<String>().where((value) => value.isNotEmpty).join('/'),
    ].where((value) => value.isNotEmpty).join(' | ');

    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CircleAvatar(
                backgroundColor: AppTheme.primaryTeal.withValues(alpha: 0.14),
                child: const Icon(Icons.person_pin_outlined),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      patientNameFrom(patient),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    if (demographics.isNotEmpty)
                      Text(
                        demographics,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                  ],
                ),
              ),
              TextButton.icon(
                onPressed: _clearSelectedPatient,
                icon: const Icon(Icons.close),
                label: const Text('Clear'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _InfoPill(
                icon: Icons.event_available_outlined,
                label:
                    '${appointments.length} OP appointment${appointments.length == 1 ? '' : 's'} today',
                color: AppTheme.primaryTeal,
              ),
              _InfoPill(
                icon: Icons.receipt_long_outlined,
                label: _patientInvoices.isEmpty
                    ? 'No bills loaded'
                    : '${_patientInvoices.length} bill${_patientInvoices.length == 1 ? '' : 's'} | Due ${_money(invoiceDue)}',
                color: AppTheme.primaryBlue,
              ),
              const _InfoPill(
                icon: Icons.folder_shared_outlined,
                label: 'Front-office summary only',
                color: AppTheme.warningAmber,
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (_canBookOp)
                FilledButton.icon(
                  onPressed: _showOpBookingDialog,
                  icon: const Icon(Icons.event_available_outlined),
                  label: const Text('Book OP'),
                ),
              if (_canBookOp)
                OutlinedButton.icon(
                  onPressed: _showWalkInRegistrationDialog,
                  icon: const Icon(Icons.how_to_reg_outlined),
                  label: const Text('Register Walk-in'),
                ),
              if (_canBilling)
                OutlinedButton.icon(
                  onPressed: _billingActionBusy ? null : _createDraftInvoice,
                  icon: const Icon(Icons.receipt_long_outlined),
                  label: const Text('Draft Bill'),
                ),
              OutlinedButton.icon(
                onPressed: () => context.push(_patientRecordsUploadRoute()),
                icon: const Icon(Icons.upload_file),
                label: const Text('Upload Prior Record'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildUnavailablePanel({
    required IconData icon,
    required String title,
    required String message,
    List<Widget> actions = const [],
  }) {
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(icon: icon, title: title),
          const SizedBox(height: 8),
          Text(message, style: TextStyle(color: AppTheme.textSecondary)),
          if (actions.isNotEmpty) ...[
            const SizedBox(height: 14),
            Wrap(spacing: 10, runSpacing: 10, children: actions),
          ],
        ],
      ),
    );
  }

  Widget _buildPatientPanel() {
    final selected = _selectedPatient;
    final createOffer = frontOfficeShouldOfferPatientCreate(
      role: _role,
      query: _searchCtrl.text,
      lookupBusy: _lookupBusy,
      hasSelectedPatient: selected != null,
      matchCount: _patientMatches.length,
    );
    final phoneLikeQuery = _frontOfficePhoneLikeQuery(_searchCtrl.text);
    final shortPhoneQuery =
        phoneLikeQuery && !frontOfficePhoneMeetsMinimum(_searchCtrl.text);
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.manage_search,
            title: 'Patient',
            trailing: Wrap(
              spacing: 8,
              children: [
                if (selected != null && _canPatientRegistryWrite)
                  IconButton.filledTonal(
                    tooltip: 'Edit patient',
                    onPressed: () => _showPatientDialog(patient: selected),
                    icon: const Icon(Icons.edit_outlined),
                  ),
                if (_canPatientRegistryCreate)
                  FilledButton.icon(
                    onPressed: () => _showPatientDialog(
                      initialPhone: _patientDialogInitialPhone(),
                    ),
                    icon: const Icon(Icons.person_add_alt_1),
                    label: const Text('New Patient'),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          if (_canPatientLookup) ...[
            Row(
              children: [
                Expanded(
                  child: Focus(
                    onKeyEvent: (node, event) {
                      if (event is KeyDownEvent &&
                          event.logicalKey == LogicalKeyboardKey.escape) {
                        _clearSelectedPatient();
                        return KeyEventResult.handled;
                      }
                      return KeyEventResult.ignored;
                    },
                    child: TextField(
                      controller: _searchCtrl,
                      focusNode: _searchFocus,
                      onChanged: _queuePatientLookup,
                      onSubmitted: _handlePatientSearchSubmitted,
                      decoration: InputDecoration(
                        labelText: 'Hospital ID / phone / name',
                        prefixIcon: const Icon(Icons.search),
                        suffixIcon: _lookupBusy
                            ? const Padding(
                                padding: EdgeInsets.all(12),
                                child: SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                ),
                              )
                            : null,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                IconButton.filledTonal(
                  tooltip: 'Search',
                  onPressed: () => _searchPatients(_searchCtrl.text),
                  icon: const Icon(Icons.search),
                ),
              ],
            ),
            if (_lookupError != null) ...[
              const SizedBox(height: 8),
              Text(
                _lookupError!,
                style: TextStyle(color: AppTheme.errorOnSurface),
              ),
            ] else if (shortPhoneQuery) ...[
              const SizedBox(height: 8),
              Text(
                'Enter at least 10 digits to search or create by phone.',
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ],
          ] else
            Text(
              'Patient lookup is not enabled for ${_role.displayName}.',
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          if (selected != null) ...[
            const SizedBox(height: 10),
            _PatientCard(patient: selected, selected: true, onTap: null),
          ],
          if (_patientMatches.isNotEmpty) ...[
            const SizedBox(height: 10),
            ..._patientMatches.map(
              (patient) => Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _PatientCard(
                  patient: patient,
                  onTap: () => _selectPatient(patient),
                ),
              ),
            ),
          ] else if (createOffer) ...[
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: () => _showPatientDialog(
                initialPhone: _patientDialogInitialPhone(),
              ),
              icon: const Icon(Icons.person_add_alt_1),
              label: const Text('Create New Patient'),
            ),
          ] else if (!_canPatientRegistryCreate &&
              !_lookupBusy &&
              _patientMatches.isEmpty &&
              selected == null &&
              frontOfficeLookupQueryReady(_searchCtrl.text)) ...[
            const SizedBox(height: 10),
            Text(
              'No patient found. ${_role.displayName} can search, but cannot create patient registry entries.',
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildActionPanel() {
    final hasPatient = _selectedPatientUid() != null;
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionTitle(icon: Icons.apps_outlined, title: 'Workflows'),
          const SizedBox(height: 10),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              if (_canBookOp)
                _ActionTile(
                  icon: Icons.calendar_month,
                  label: 'Book OP Appointment',
                  color: AppTheme.accentCyan,
                  onTap: _showOpBookingDialog,
                ),
              if (_canBookOp)
                _ActionTile(
                  icon: Icons.event_note_outlined,
                  label: 'Appointments',
                  color: AppTheme.primaryBlue,
                  onTap: () => context.push('/appointments'),
                ),
              if (_canBookOp)
                _ActionTile(
                  icon: Icons.how_to_reg_outlined,
                  label: 'Register Walk-in',
                  color: AppTheme.primaryTeal,
                  enabled: hasPatient,
                  onTap: _showWalkInRegistrationDialog,
                ),
              if (_canAdmitIp)
                _ActionTile(
                  icon: Icons.local_hospital_outlined,
                  label: 'Admit IP',
                  color: AppTheme.warningAmber,
                  enabled: hasPatient && !_admissionActionBusy,
                  onTap: () => _showIpAdmissionDialog(),
                ),
              if (_canAdmitIp)
                _ActionTile(
                  icon: Icons.local_hospital,
                  label: 'Admissions',
                  color: AppTheme.warningAmber,
                  onTap: () => context.push('/emr/admissions'),
                ),
              if (_canBilling)
                _ActionTile(
                  icon: Icons.receipt_long,
                  label: 'Billing',
                  color: AppTheme.primaryBlue,
                  onTap: () => context.push(_patientRoute('/billing-desk')),
                ),
              if (_canClinical)
                _ActionTile(
                  icon: Icons.folder_shared,
                  label: 'Records',
                  color: AppTheme.primaryTeal,
                  enabled: hasPatient,
                  onTap: () => context.push(_patientRecordsRoute()),
                ),
              if (_canClinical)
                _ActionTile(
                  icon: Icons.monitor_heart_outlined,
                  label: 'Vitals',
                  color: AppTheme.errorRed,
                  enabled: hasPatient,
                  onTap: () => context.push(_patientRoute('/vitals')),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildQueuePanel() {
    final queueScope = _queueScope;
    final title = queueScope == FrontOfficeQueueScope.mine
        ? 'My ${frontOfficeQueueDateLabel(_queueDate)}'
        : frontOfficeQueueDateLabel(_queueDate);
    final dateParam = _dateParam(_queueDate);
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.event_note,
            title: title,
            trailing: Wrap(
              spacing: 8,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                TextButton.icon(
                  onPressed: () =>
                      context.push('/appointments?date=$dateParam'),
                  icon: const Icon(Icons.calendar_month_outlined),
                  label: const Text('Calendar'),
                ),
                TextButton.icon(
                  onPressed: _refreshWorklists,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Refresh'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          if (queueScope != FrontOfficeQueueScope.none) ...[
            _QueueDateSwitcher(
              selectedDate: _queueDate,
              onSelected: _setQueueDate,
            ),
            const SizedBox(height: 8),
          ],
          if (queueScope == FrontOfficeQueueScope.none)
            const _EmptyLine(
              icon: Icons.lock_outline,
              text: 'OP queue is restricted for this role',
            )
          else if (_todayQueue.isEmpty)
            const _EmptyLine(
              icon: Icons.event_busy,
              text: 'No appointments queued for this date',
            )
          else
            ..._todayQueue.take(5).map(_queueTile),
        ],
      ),
    );
  }

  Widget _queueTile(Map<String, dynamic> row) {
    final id = _appointmentId(row);
    final name = _queuePatientName(row);
    final patient = _patientFromQueueRow(row);
    final phone = patientPhoneFrom(patient);
    final doctor = _queueDoctorName(row);
    final department = _queueDepartment(row);
    final status = _appointmentStatus(row);
    final dateTime = _queueAppointmentDateTimeLabel(row);
    final busy = id != null && _queueActionId == id;
    final selected = _queueRowMatchesSelectedPatient(row);
    final terminal = frontOfficeAppointmentStatusIsTerminal(status);
    final canConfirm = _canManageOpQueue && status == 'SCHEDULED';
    final canComplete =
        _canCompleteOpQueue &&
        (status == 'CONFIRMED' || status == 'IN_PROGRESS');
    final canNoShow = _canManageOpQueue;
    final canReschedule = _canManageOpQueue;
    final canCancel = _canManageOpQueue;
    final hasQueueAction =
        !terminal &&
        (canConfirm || canComplete || canNoShow || canReschedule || canCancel);
    final actions = <Widget>[
      if (canConfirm)
        _QueueActionButton(
          icon: Icons.check,
          label: 'Check in',
          color: AppTheme.primaryTeal,
          onPressed: busy ? null : () => _confirmQueueAppointment(row),
        ),
      if (canComplete)
        _QueueActionButton(
          icon: Icons.done_all,
          label: 'Complete',
          color: AppTheme.successGreen,
          onPressed: busy ? null : () => _completeQueueAppointment(row),
        ),
      if (canNoShow)
        _QueueActionButton(
          icon: Icons.person_off_outlined,
          label: 'No-show',
          color: AppTheme.textSecondary,
          onPressed: busy ? null : () => _markQueueNoShow(row),
        ),
      if (canReschedule)
        _QueueActionButton(
          icon: Icons.event_repeat_outlined,
          label: 'Reschedule',
          color: AppTheme.primaryBlue,
          onPressed: busy ? null : () => _rescheduleQueueAppointment(row),
        ),
      if (canCancel)
        _QueueActionButton(
          icon: Icons.cancel_outlined,
          label: 'Cancel',
          color: AppTheme.errorRed,
          onPressed: busy ? null : () => _cancelQueueAppointment(row),
        ),
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: selected
            ? AppTheme.primaryBlue.withValues(alpha: 0.06)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => _selectQueuePatient(row),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    CircleAvatar(
                      backgroundColor: _appointmentStatusColor(
                        status,
                      ).withValues(alpha: 0.12),
                      child: busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Icon(
                              selected
                                  ? Icons.person_pin_circle_outlined
                                  : Icons.person_outline,
                              color: _appointmentStatusColor(status),
                            ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w800),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            [
                              if (dateTime.isNotEmpty) dateTime,
                              if (phone.isNotEmpty) phone,
                            ].join(' - '),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            softWrap: false,
                            style: TextStyle(color: AppTheme.textSecondary),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    _StatusPill(
                      label: frontOfficeAppointmentStatusLabel(status),
                      color: _appointmentStatusColor(status),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  children: [
                    if (doctor.isNotEmpty)
                      _InfoPill(
                        icon: Icons.medical_services_outlined,
                        label: doctor,
                        color: AppTheme.primaryBlue,
                      ),
                    if (department.isNotEmpty)
                      _InfoPill(
                        icon: Icons.business_outlined,
                        label: department,
                        color: AppTheme.primaryTeal,
                      ),
                  ],
                ),
                if (hasQueueAction) ...[
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [for (final action in actions) action],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildBillingPanel() {
    if (!_canBilling) return const SizedBox.shrink();
    final selected = _selectedPatient;
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.receipt_long,
            title: 'Billing',
            trailing: selected == null
                ? null
                : Wrap(
                    spacing: 8,
                    children: [
                      TextButton.icon(
                        onPressed: () =>
                            context.push(_patientRoute('/billing-desk')),
                        icon: const Icon(Icons.open_in_new),
                        label: const Text('Open'),
                      ),
                      FilledButton.icon(
                        onPressed: _billingActionBusy
                            ? null
                            : _createDraftInvoice,
                        icon: _billingActionBusy
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.add),
                        label: const Text('Draft OP'),
                      ),
                    ],
                  ),
          ),
          const SizedBox(height: 8),
          if (selected == null)
            const _EmptyLine(
              icon: Icons.person_search,
              text: 'Select a patient',
            )
          else if (_invoiceBusy)
            const LinearProgressIndicator(minHeight: 2)
          else if (_patientInvoices.isEmpty)
            const _EmptyLine(
              icon: Icons.receipt_long,
              text: 'No invoices found',
            )
          else
            ..._patientInvoices.take(4).map(_invoiceTile),
        ],
      ),
    );
  }

  Widget _invoiceTile(Map<String, dynamic> invoice) {
    final id = invoice['invoice_number'] ?? '#${invoice['id']}';
    final status = invoice['status']?.toString().toUpperCase() ?? 'DRAFT';
    final invoiceType = invoice['invoice_type']?.toString() ?? 'OP';
    final isDraft = status == 'DRAFT';
    final due = billingInvoiceAmountDue(invoice);
    final canCollect = billingInvoiceCanCollect(invoice);
    final canPrintTax = billingInvoiceCanPrintTaxInvoice(invoice);
    final canPrintReceipt = billingInvoiceCanPrintReceipt(invoice);
    final actions = <Widget>[
      if (canPrintTax)
        IconButton.filledTonal(
          tooltip: 'Print tax invoice',
          onPressed: _billingActionBusy
              ? null
              : () => _printInvoiceDocument(
                  invoice,
                  BillingDocumentType.taxInvoice,
                ),
          icon: const Icon(Icons.picture_as_pdf_outlined, size: 18),
        ),
      if (canPrintReceipt)
        IconButton.filledTonal(
          tooltip: 'Print receipt',
          onPressed: _billingActionBusy
              ? null
              : () =>
                    _printInvoiceDocument(invoice, BillingDocumentType.receipt),
          icon: const Icon(Icons.receipt_outlined, size: 18),
        ),
      if (isDraft)
        SizedBox(
          height: 34,
          child: OutlinedButton.icon(
            onPressed: _billingActionBusy ? null : () => _issueInvoice(invoice),
            icon: const Icon(Icons.publish_outlined, size: 16),
            label: const Text('Issue'),
          ),
        ),
      if (canCollect)
        SizedBox(
          height: 34,
          child: FilledButton.icon(
            onPressed: _billingActionBusy
                ? null
                : () => _collectInvoicePayment(invoice),
            icon: const Icon(Icons.payments_outlined, size: 16),
            label: const Text('Collect'),
          ),
        ),
    ];

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Theme.of(context).dividerColor),
          color: Theme.of(
            context,
          ).colorScheme.surfaceContainerHighest.withValues(alpha: 0.26),
        ),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final compact = constraints.maxWidth < 520;
            final details = Row(
              children: [
                const Icon(Icons.receipt_long_outlined, size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        id.toString(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: 2),
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(
                            '$invoiceType - $status',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          Text(
                            _money(due),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(fontWeight: FontWeight.w700),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            );

            if (compact) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  details,
                  if (actions.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      alignment: WrapAlignment.end,
                      children: actions,
                    ),
                  ],
                ],
              );
            }

            return Row(
              children: [
                Expanded(child: details),
                if (actions.isNotEmpty) ...[
                  const SizedBox(width: 12),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 360),
                    child: Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: actions,
                    ),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildAdmissionsPanel() {
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.local_hospital,
            title: 'Active IP Admissions',
            trailing: Wrap(
              spacing: 8,
              children: [
                if (_canAdmitIp && _selectedPatient != null)
                  FilledButton.icon(
                    onPressed: _admissionActionBusy
                        ? null
                        : () => _showIpAdmissionDialog(),
                    icon: _admissionActionBusy
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.add),
                    label: const Text('Admit IP'),
                  ),
                TextButton.icon(
                  onPressed: () => context.push('/emr/admissions'),
                  icon: const Icon(Icons.open_in_new),
                  label: const Text('Open'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          if (_canViewAdmissionHandoffs) ...[
            Row(
              children: [
                const Icon(Icons.move_down_outlined, size: 18),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'OPD -> IPD Handoff',
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (_admissionHandoffs.isEmpty)
              const _EmptyLine(
                icon: Icons.assignment_turned_in_outlined,
                text: 'No OPD admission advice pending',
              )
            else
              ..._admissionHandoffs.take(4).map(_admissionHandoffTile),
            const Divider(height: 22),
          ],
          if (_activeAdmissions.isEmpty)
            const _EmptyLine(
              icon: Icons.local_hospital_outlined,
              text: 'No active admissions',
            )
          else ...[
            ..._activeAdmissions.take(5).map(_admissionTile),
            if (_activeAdmissionsTotal > _activeAdmissions.take(5).length) ...[
              const SizedBox(height: 6),
              Text(
                'Showing first ${_activeAdmissions.take(5).length} of $_activeAdmissionsTotal active admissions.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: AppTheme.textSecondary),
              ),
            ],
          ],
        ],
      ),
    );
  }

  Widget _admissionHandoffTile(Map<String, dynamic> row) {
    final patient = frontOfficeAdmissionAdvicePatientFrom(row);
    final name = _text(patient?['name']);
    final phone = _text(patient?['phone']);
    final doctor = _firstText([
      row['doctor_name'],
      row['doctorName'],
      row['consultant_name'],
      row['consultantName'],
    ]);
    final advisedAt = _admissionAdviceDate(row);
    final note = _admissionAdviceNote(row);
    final busy = _admissionActionBusy;

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: AppTheme.warningAmber.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: AppTheme.warningAmber.withValues(alpha: 0.24),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.assignment_returned_outlined),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    name.isEmpty ? 'Patient advised for IP' : name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
                if (busy)
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              [
                if (phone.isNotEmpty) phone,
                if (doctor.isNotEmpty) doctor,
                if (advisedAt.isNotEmpty) advisedAt,
                if (note.isNotEmpty) note,
              ].join(' - '),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                const _InfoPill(
                  icon: Icons.rule_outlined,
                  label: 'Needs bed, deposit, consent',
                  color: AppTheme.warningAmber,
                ),
                OutlinedButton.icon(
                  onPressed: () => _showAdmissionAdviceDialog(row),
                  icon: const Icon(Icons.visibility_outlined, size: 16),
                  label: const Text('View advice'),
                ),
                FilledButton.icon(
                  onPressed: busy ? null : () => _startAdmissionFromAdvice(row),
                  icon: const Icon(Icons.bed_outlined, size: 16),
                  label: const Text('Assign ward/bed'),
                ),
                OutlinedButton.icon(
                  onPressed: patient == null
                      ? null
                      : () => _openBillingForAdvice(row),
                  icon: const Icon(Icons.account_balance_wallet_outlined),
                  label: const Text('Billing deposit'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _admissionTile(Map<String, dynamic> row) {
    final name = row['patient_name'] ?? row['name'] ?? 'Patient';
    final ward = row['ward'] ?? row['ward_name'] ?? row['bed_ward_name'];
    final admittedAt = row['admitted_at'] ?? row['created_at'];
    final date = admittedAt == null
        ? null
        : DateTime.tryParse(admittedAt.toString())?.toLocal();
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.bed_outlined),
      title: Text(
        name.toString(),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        [
          ?ward,
          if (date != null) DateFormat('dd MMM, HH:mm').format(date),
        ].join(' - '),
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.push('/emr/admissions'),
    );
  }
}

class _Surface extends StatelessWidget {
  final Widget child;

  const _Surface({required this.child});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
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
        Icon(icon, color: AppTheme.primaryBlue),
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

class _Metric extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;
  final VoidCallback? onTap;

  const _Metric({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final content = Container(
      constraints: const BoxConstraints(minWidth: 156),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 8),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: color,
                  ),
                ),
                Text(
                  label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
    return Material(
      color: color.withValues(alpha: 0.1),
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: content,
      ),
    );
  }
}

class _InfoPill extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;

  const _InfoPill({
    required this.icon,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 260),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.22)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: color, fontWeight: FontWeight.w700),
            ),
          ),
        ],
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
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: color,
          fontWeight: FontWeight.w800,
          fontSize: 12,
        ),
      ),
    );
  }
}

class _DetailLine extends StatelessWidget {
  final String label;
  final String value;

  const _DetailLine({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    if (value.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 96,
            child: Text(label, style: TextStyle(color: AppTheme.textSecondary)),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

class _PatientCard extends StatelessWidget {
  final Map<String, dynamic> patient;
  final bool selected;
  final VoidCallback? onTap;

  const _PatientCard({
    required this.patient,
    required this.onTap,
    this.selected = false,
  });

  @override
  Widget build(BuildContext context) {
    final name = patientNameFrom(patient);
    final subtitle = patientSubtitle(patient, includeAgeGender: true);
    final interactive = onTap != null;
    return Semantics(
      button: interactive,
      selected: selected,
      label: [name, subtitle].where((part) => part.isNotEmpty).join(', '),
      child: Material(
        color: selected
            ? AppTheme.primaryBlue.withValues(alpha: 0.08)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Row(
              children: [
                CircleAvatar(
                  backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.14),
                  child: const ExcludeSemantics(
                    child: Icon(Icons.person_outline),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                      if (subtitle.isNotEmpty)
                        Text(
                          subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                    ],
                  ),
                ),
                if (interactive) const Icon(Icons.chevron_right),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _OpBookingClinicianFields extends StatelessWidget {
  final List<Map<String, dynamic>> doctors;
  final Map<String, dynamic>? selectedDoctor;
  final TextEditingController doctorController;
  final FocusNode doctorFocus;
  final TextEditingController departmentController;
  final FocusNode departmentFocus;
  final bool enabled;
  final ValueChanged<Map<String, dynamic>?> onDoctorSelected;
  final ValueChanged<String> onDoctorTextChanged;
  final ValueChanged<String> onDepartmentChanged;

  const _OpBookingClinicianFields({
    required this.doctors,
    required this.selectedDoctor,
    required this.doctorController,
    required this.doctorFocus,
    required this.departmentController,
    required this.departmentFocus,
    required this.onDoctorSelected,
    required this.onDoctorTextChanged,
    required this.onDepartmentChanged,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    final departments = frontOfficeDepartmentOptionsFromDoctors(doctors);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        RawAutocomplete<Map<String, dynamic>>(
          textEditingController: doctorController,
          focusNode: doctorFocus,
          displayStringForOption: _doctorLabel,
          optionsBuilder: (value) {
            if (!enabled) return const Iterable<Map<String, dynamic>>.empty();
            return frontOfficeFilterDoctors(
              doctors,
              value.text,
              department: departmentController.text,
              requireNumericId: true,
              limit: 25,
            );
          },
          onSelected: enabled ? onDoctorSelected : null,
          fieldViewBuilder: (context, textController, focusNode, _) {
            return TextFormField(
              controller: textController,
              focusNode: focusNode,
              enabled: enabled,
              textInputAction: TextInputAction.search,
              decoration: const InputDecoration(
                labelText: 'Consulting doctor',
                hintText: 'Optional if department is selected',
                prefixIcon: Icon(Icons.medical_services_outlined),
              ),
              onChanged: onDoctorTextChanged,
            );
          },
          optionsViewBuilder: (context, onOptionSelected, options) {
            final items = options.toList(growable: false);
            return Align(
              alignment: Alignment.topLeft,
              child: Material(
                elevation: 4,
                borderRadius: BorderRadius.circular(8),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxHeight: 260,
                    maxWidth: 560,
                  ),
                  child: ListView.separated(
                    padding: EdgeInsets.zero,
                    shrinkWrap: true,
                    itemCount: items.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final doctor = items[index];
                      final department = _firstText([
                        frontOfficeDoctorDepartment(doctor),
                        doctor['specialty'],
                        doctor['specialization'],
                      ]);
                      return ListTile(
                        dense: true,
                        leading: const Icon(Icons.person_outline),
                        title: Text(
                          _doctorLabel(doctor),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        subtitle: department.isEmpty
                            ? null
                            : Text(
                                department,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                        onTap: () => onOptionSelected(doctor),
                      );
                    },
                  ),
                ),
              ),
            );
          },
        ),
        const SizedBox(height: 12),
        RawAutocomplete<String>(
          textEditingController: departmentController,
          focusNode: departmentFocus,
          optionsBuilder: (value) {
            if (!enabled) return const Iterable<String>.empty();
            final query = value.text.trim().toLowerCase();
            if (query.isEmpty) return departments.take(25);
            return departments
                .where((department) => department.toLowerCase().contains(query))
                .take(25);
          },
          onSelected: enabled
              ? (department) {
                  departmentController.text = department;
                  onDepartmentChanged(department);
                  departmentFocus.unfocus();
                }
              : null,
          fieldViewBuilder: (context, textController, focusNode, _) {
            return TextFormField(
              controller: textController,
              focusNode: focusNode,
              enabled: enabled,
              decoration: const InputDecoration(
                labelText: 'Department',
                hintText: 'Any available doctor',
                prefixIcon: Icon(Icons.business),
              ),
              onChanged: onDepartmentChanged,
            );
          },
          optionsViewBuilder: (context, onOptionSelected, options) {
            final items = options.toList(growable: false);
            return Align(
              alignment: Alignment.topLeft,
              child: Material(
                elevation: 4,
                borderRadius: BorderRadius.circular(8),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxHeight: 220,
                    maxWidth: 560,
                  ),
                  child: ListView.separated(
                    padding: EdgeInsets.zero,
                    shrinkWrap: true,
                    itemCount: items.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final department = items[index];
                      return ListTile(
                        dense: true,
                        leading: const Icon(Icons.business_outlined),
                        title: Text(
                          department,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        trailing: selectedDoctor == null
                            ? const Text('Any doctor')
                            : null,
                        onTap: () => onOptionSelected(department),
                      );
                    },
                  ),
                ),
              ),
            );
          },
        ),
      ],
    );
  }
}

class _DoctorAutocompleteField extends StatelessWidget {
  final List<Map<String, dynamic>> doctors;
  final Map<String, dynamic>? selectedDoctor;
  final ValueChanged<Map<String, dynamic>?> onSelected;
  final String labelText;
  final bool enabled;
  final bool requireNumericId;
  final bool requireUid;

  const _DoctorAutocompleteField({
    required this.doctors,
    required this.selectedDoctor,
    required this.onSelected,
    required this.labelText,
    this.enabled = true,
    this.requireNumericId = false,
    this.requireUid = false,
  });

  @override
  Widget build(BuildContext context) {
    final selectedValue = selectedDoctor;

    return Autocomplete<Map<String, dynamic>>(
      displayStringForOption: _doctorLabel,
      initialValue: TextEditingValue(
        text: selectedValue == null ? '' : _doctorLabel(selectedValue),
      ),
      optionsBuilder: (textEditingValue) {
        if (!enabled) return const Iterable<Map<String, dynamic>>.empty();
        return frontOfficeFilterDoctors(
          doctors,
          textEditingValue.text,
          requireNumericId: requireNumericId,
          requireUid: requireUid,
        );
      },
      onSelected: enabled ? (doctor) => onSelected(doctor) : null,
      fieldViewBuilder: (context, textController, focusNode, onFieldSubmitted) {
        return TextFormField(
          controller: textController,
          focusNode: focusNode,
          enabled: enabled,
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            labelText: labelText,
            prefixIcon: const Icon(Icons.medical_services_outlined),
          ),
          onChanged: (value) {
            final selectedLabel = selectedDoctor == null
                ? ''
                : _doctorLabel(selectedDoctor!);
            if (selectedDoctor != null && value.trim() != selectedLabel) {
              onSelected(null);
            }
          },
          onFieldSubmitted: (_) => onFieldSubmitted(),
        );
      },
      optionsViewBuilder: (context, onOptionSelected, options) {
        return Align(
          alignment: Alignment.topLeft,
          child: Material(
            elevation: 4,
            borderRadius: BorderRadius.circular(8),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 280, maxWidth: 560),
              child: ListView.builder(
                padding: EdgeInsets.zero,
                shrinkWrap: true,
                itemCount: options.length,
                itemBuilder: (context, index) {
                  final doctor = options.elementAt(index);
                  final department = _text(
                    doctor['department'] ??
                        doctor['specialty'] ??
                        doctor['specialization'],
                  );
                  return ListTile(
                    dense: true,
                    leading: const Icon(Icons.person_outline),
                    title: Text(
                      _doctorLabel(doctor),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: department.isEmpty
                        ? null
                        : Text(
                            department,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                    onTap: () => onOptionSelected(doctor),
                  );
                },
              ),
            ),
          ),
        );
      },
    );
  }
}

class _ActionTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;
  final bool enabled;

  const _ActionTile({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    final effectiveColor = enabled ? color : AppTheme.textSecondary;
    return SizedBox(
      width: 148,
      height: 86,
      child: Material(
        color: effectiveColor.withValues(alpha: enabled ? 0.1 : 0.05),
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Icon(icon, color: effectiveColor),
                Text(
                  label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: effectiveColor,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _QueueActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback? onPressed;

  const _QueueActionButton({
    required this.icon,
    required this.label,
    required this.color,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 32,
      child: OutlinedButton.icon(
        onPressed: onPressed,
        icon: Icon(icon, size: 15),
        label: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
        style: OutlinedButton.styleFrom(
          foregroundColor: color,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          visualDensity: VisualDensity.compact,
        ),
      ),
    );
  }
}

class _QueueDateSwitcher extends StatelessWidget {
  final DateTime selectedDate;
  final Future<void> Function(DateTime date) onSelected;

  const _QueueDateSwitcher({
    required this.selectedDate,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    final today = _dateOnly(DateTime.now());
    final days = [
      today,
      today.add(const Duration(days: 1)),
      today.add(const Duration(days: 2)),
    ];
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final day in days) ...[
            ChoiceChip(
              label: Text(switch (day.difference(today).inDays) {
                0 => 'Today',
                1 => 'Tomorrow',
                _ => 'Following day',
              }),
              selected: _dateOnly(selectedDate) == day,
              onSelected: (_) => onSelected(day),
            ),
            const SizedBox(width: 8),
          ],
          OutlinedButton.icon(
            onPressed: () async {
              final picked = await showDatePicker(
                context: context,
                initialDate: selectedDate,
                firstDate: today.subtract(const Duration(days: 30)),
                lastDate: today.add(const Duration(days: 180)),
              );
              if (picked != null) await onSelected(picked);
            },
            icon: const Icon(Icons.event_outlined, size: 18),
            label: Text(DateFormat('d MMM').format(selectedDate)),
            style: OutlinedButton.styleFrom(
              visualDensity: VisualDensity.compact,
              minimumSize: const Size(0, 36),
            ),
          ),
        ],
      ),
    );
  }
}

class _DateTimeButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

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
      label: Align(
        alignment: Alignment.centerLeft,
        child: Text(label, overflow: TextOverflow.ellipsis),
      ),
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(50),
        alignment: Alignment.centerLeft,
      ),
    );
  }
}

class _EmptyLine extends StatelessWidget {
  final IconData icon;
  final String text;

  const _EmptyLine({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Icon(icon, color: AppTheme.textSecondary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(color: AppTheme.textSecondary)),
          ),
        ],
      ),
    );
  }
}

String _digitsOnly(String value) => value.replaceAll(RegExp(r'\D'), '');

String _formatTime(TimeOfDay time) {
  final hour = time.hour.toString().padLeft(2, '0');
  final minute = time.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}

String _admissionAdviceNote(Map<String, dynamic>? row) {
  if (row == null) return '';
  return _firstText([
    row['advised_for_admission_note'],
    row['admission_advice_note'],
    row['advice_note'],
    row['reason'],
    row['notes'],
  ]);
}

String _admissionAdviceDate(Map<String, dynamic> row) {
  final raw = _firstText([
    row['advised_for_admission_at'],
    row['advisedAt'],
    row['updated_at'],
    row['created_at'],
  ]);
  final date = DateTime.tryParse(raw)?.toLocal();
  if (date == null) return '';
  return DateFormat('dd MMM, HH:mm').format(date);
}

String _admissionAdviceSummary(Map<String, dynamic> row) {
  final id = frontOfficeAdmissionAdviceIdFrom(row);
  final advisedAt = _admissionAdviceDate(row);
  final note = _admissionAdviceNote(row);
  return [
    'OPD admission advice',
    if (id != null) '#$id',
    if (advisedAt.isNotEmpty) advisedAt,
    if (note.isNotEmpty) note,
  ].join(' - ');
}

int? _appointmentId(Map<String, dynamic> row) =>
    _intFrom(row['id'] ?? row['appointment_id']);

String _appointmentStatus(Map<String, dynamic> row) {
  final status = _text(row['status']).toUpperCase();
  return status.isEmpty ? 'SCHEDULED' : status;
}

String _queuePatientName(Map<String, dynamic> row) {
  final patient = _patientFromQueueRow(row);
  final name = _text(patient?['name'] ?? row['patient_name'] ?? row['name']);
  if (name.isNotEmpty) return name;
  final phone = _text(
    patient?['phone'] ?? row['patient_phone'] ?? row['phone'],
  );
  return phone.isEmpty ? 'Patient' : phone;
}

String _queueDoctorName(Map<String, dynamic> row) {
  return _firstText([
    row['doctor_name'],
    row['doctorName'],
    row['consultant_name'],
    row['consultantName'],
    row['staff_name'],
    row['provider_name'],
  ]);
}

String _queueDepartment(Map<String, dynamic> row) {
  return _firstText([
    row['department'],
    row['doctor_department'],
    row['specialty'],
    row['specialization'],
  ]);
}

DateTime? _appointmentDate(Map<String, dynamic> row) {
  final raw = _firstText([
    row['appointment_date'],
    row['date'],
    row['scheduled_date'],
  ]);
  if (raw.isEmpty) return null;
  return DateTime.tryParse(raw)?.toLocal();
}

TimeOfDay? _appointmentTime(Map<String, dynamic> row) {
  final raw = _firstText([row['appointment_time'], row['time'], row['slot']]);
  final match = RegExp(r'^(\d{1,2}):(\d{2})').firstMatch(raw);
  if (match == null) return null;
  final hour = int.tryParse(match.group(1) ?? '');
  final minute = int.tryParse(match.group(2) ?? '');
  if (hour == null || minute == null) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return TimeOfDay(hour: hour, minute: minute);
}

String _queueAppointmentDateTimeLabel(Map<String, dynamic> row) {
  final date = _appointmentDate(row);
  final time = _appointmentTime(row);
  final parts = [
    if (date != null) DateFormat('dd MMM').format(date),
    if (time != null)
      '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}',
  ];
  if (parts.isNotEmpty) return parts.join(' ');
  return _firstText([row['appointment_time'], row['time'], row['slot']]);
}

Color _appointmentStatusColor(String status) {
  switch (status.toUpperCase()) {
    case 'CONFIRMED':
      return AppTheme.primaryTeal;
    case 'IN_PROGRESS':
      return AppTheme.primaryBlue;
    case 'COMPLETED':
      return AppTheme.successGreen;
    case 'NO_SHOW':
      return AppTheme.textSecondary;
    case 'RESCHEDULED':
      return AppTheme.primaryBlue;
    case 'CANCELLED':
      return AppTheme.errorRed;
    default:
      return AppTheme.warningAmber;
  }
}

String _patientAdmissionQuery(Map<String, dynamic> patient) {
  for (final key in [
    'uid',
    'hospital_number',
    'patient_hospital_number',
    'phone',
    'name',
  ]) {
    final value = _text(patient[key]);
    if (value.isNotEmpty) return value;
  }
  return '';
}

Map<String, dynamic>? _patientFromQueueRow(Map<String, dynamic> row) {
  final nested =
      _mapFromAny(row['patient']) ??
      _mapFromAny(row['patient_details']) ??
      _mapFromAny(row['patientDetail']) ??
      const <String, dynamic>{};
  final uid = _firstText([
    nested['uid'],
    nested['patient_uid'],
    nested['patientUid'],
    row['patient_uid'],
    row['patientUid'],
  ]);
  final id = _intFrom(
    nested['id'] ??
        nested['patient_id'] ??
        row['patient_id'] ??
        row['patientId'],
  );
  final name = _firstText([
    nested['name'],
    nested['patient_name'],
    nested['full_name'],
    row['patient_name'],
    row['patientName'],
    row['name'],
  ]);
  final phone = _firstText([
    nested['phone'],
    nested['patient_phone'],
    row['patient_phone'],
    row['patientPhone'],
    row['phone'],
  ]);
  final hospitalNumber = _firstText([
    nested['hospital_number'],
    nested['patient_hospital_number'],
    nested['hospitalNumber'],
    row['hospital_number'],
    row['patient_hospital_number'],
    row['hospitalNumber'],
  ]);
  final bloodGroup = _firstText([nested['blood_group'], row['blood_group']]);

  final patient = <String, dynamic>{
    if (uid.isNotEmpty) 'uid': uid,
    'id': ?id,
    if (name.isNotEmpty) 'name': name,
    if (phone.isNotEmpty) 'phone': phone,
    if (hospitalNumber.isNotEmpty) 'hospital_number': hospitalNumber,
    if (bloodGroup.isNotEmpty) 'blood_group': bloodGroup,
  };
  return patient.isEmpty ? null : patient;
}

Map<String, dynamic>? _bestQueuePatientMatch(
  List<Map<String, dynamic>> matches,
  Map<String, dynamic> queuePatient,
) {
  if (matches.isEmpty) return null;

  final uid = _text(queuePatient['uid']);
  if (uid.isNotEmpty) {
    for (final match in matches) {
      if (_text(match['uid']) == uid) return match;
    }
  }

  final id = _text(queuePatient['id']);
  if (id.isNotEmpty) {
    for (final match in matches) {
      if (_text(match['id']) == id) return match;
    }
  }

  final hospitalNumber = _text(queuePatient['hospital_number']).toLowerCase();
  if (hospitalNumber.isNotEmpty) {
    for (final match in matches) {
      if (_text(match['hospital_number']).toLowerCase() == hospitalNumber) {
        return match;
      }
    }
  }

  final phone = _digitsOnly(_text(queuePatient['phone']));
  if (phone.isNotEmpty) {
    for (final match in matches) {
      if (_digitsOnly(_text(match['phone'])) == phone) return match;
    }
  }

  return matches.length == 1 ? matches.first : null;
}

Map<String, dynamic>? _bestPatientLookupMatch(
  List<Map<String, dynamic>> matches,
  String query,
) {
  if (matches.isEmpty) return null;
  final normalizedQuery = query.trim().toLowerCase();
  final queryDigits = _digitsOnly(query);
  for (final match in matches) {
    final hospitalNumber = _text(match['hospital_number']).toLowerCase();
    final uid = _text(match['uid']).toLowerCase();
    final id = _text(match['id']).toLowerCase();
    final name = patientNameFrom(match, fallback: '').toLowerCase();
    final phoneDigits = _digitsOnly(patientPhoneFrom(match));
    if (normalizedQuery.isNotEmpty &&
        (normalizedQuery == hospitalNumber ||
            normalizedQuery == uid ||
            normalizedQuery == id ||
            normalizedQuery == name)) {
      return match;
    }
    if (queryDigits.length >= 10 && phoneDigits.length >= 10) {
      final queryLast10 = queryDigits.substring(queryDigits.length - 10);
      final patientLast10 = phoneDigits.substring(phoneDigits.length - 10);
      if (queryLast10 == patientLast10) return match;
    }
  }
  return null;
}

Map<String, dynamic>? _mapFromAny(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return null;
}

String _firstText(Iterable<dynamic> values) {
  for (final value in values) {
    final text = _text(value);
    if (text.isNotEmpty) return text;
  }
  return '';
}

String _normalizedPersonName(String value) {
  return value
      .trim()
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]+'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
}

String _dateText(dynamic value) {
  final text = _text(value);
  if (text.isEmpty) return '';
  return text.split('T').first;
}

Map<String, dynamic> _admissionFromResponse(Map<String, dynamic> result) {
  final admission = result['admission'];
  if (admission is Map<String, dynamic>) return admission;
  if (admission is Map) return Map<String, dynamic>.from(admission);
  return result;
}

String _apiAdmissionPriority(String priority) {
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
  return lower == 'emergency' || lower == 'critical' ? 'emergency' : 'elective';
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

int? _intFrom(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

String _text(dynamic value) => value?.toString().trim() ?? '';

int? _wardId(Map<String, dynamic>? ward) => _intFrom(ward?['id']);

String _wardLabel(Map<String, dynamic>? ward) {
  if (ward == null) return '';
  return _text(
    ward['name'] ?? ward['ward_name'] ?? ward['label'] ?? ward['floor_label'],
  );
}

int? _bedId(Map<String, dynamic>? bed) => _intFrom(bed?['id']);

String _bedLabel(Map<String, dynamic>? bed) {
  if (bed == null) return '';
  final label = _text(
    bed['bed_number'] ?? bed['bed'] ?? bed['label'] ?? bed['name'],
  );
  final ward = _text(bed['ward_name']);
  final type = _text(bed['bed_type']);
  return [
    if (label.isNotEmpty) label,
    if (ward.isNotEmpty) ward,
    if (type.isNotEmpty) type,
  ].join(' - ');
}

String _money(dynamic value) {
  final number = value is num ? value : num.tryParse(value?.toString() ?? '');
  if (number == null) return 'Rs 0';
  return 'Rs ${number.toStringAsFixed(number.truncateToDouble() == number ? 0 : 2)}';
}

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

class _InlineAlert extends StatelessWidget {
  final String message;
  final Color color;

  const _InlineAlert({required this.message, required this.color});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: color.withValues(alpha: 0.28)),
        ),
        child: Row(
          children: [
            Icon(Icons.info_outline, color: color),
            const SizedBox(width: 8),
            Expanded(child: Text(message)),
          ],
        ),
      ),
    );
  }
}
