import 'dart:async';

import 'package:flutter/material.dart';
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
import '../../../core/widgets/staff_scaffold.dart';
import '../widgets/billing_document_actions.dart';
import '../widgets/billing_payment_dialog.dart';

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
  final query = rawQuery.trim();
  final queryDigits = _digitsOnly(query);
  final phoneLikeQuery =
      queryDigits.isNotEmpty && RegExp(r'^[\d\s()+.-]+$').hasMatch(query);
  if (!phoneLikeQuery) return true;
  if (queryDigits.length < 10) return false;

  final patientDigits = _digitsOnly(_text(patient['phone']));
  if (patientDigits.length < 10) return false;

  final normalizedDigits = queryDigits.length == 10
      ? '91$queryDigits'
      : queryDigits;
  final nationalDigits =
      normalizedDigits.startsWith('91') && normalizedDigits.length == 12
      ? normalizedDigits.substring(2)
      : queryDigits;
  final patientNationalDigits =
      patientDigits.startsWith('91') && patientDigits.length == 12
      ? patientDigits.substring(2)
      : patientDigits;

  return patientDigits == normalizedDigits ||
      patientDigits == nationalDigits ||
      patientNationalDigits == nationalDigits;
}

@visibleForTesting
bool frontOfficePhoneMeetsMinimum(String value) {
  return _digitsOnly(value).length >= 10;
}

bool _frontOfficePhoneLikeQuery(String value) {
  final query = value.trim();
  final queryDigits = _digitsOnly(query);
  return queryDigits.isNotEmpty && RegExp(r'^[\d\s()+.-]+$').hasMatch(query);
}

@visibleForTesting
bool frontOfficeLookupQueryReady(String value) {
  final query = value.trim();
  if (query.length < 2) return false;
  if (_frontOfficePhoneLikeQuery(query)) {
    return frontOfficePhoneMeetsMinimum(query);
  }
  return true;
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
  final params = <String, String>{...queryParameters};
  final uid = _text(patient?['uid']);
  final id = _text(patient?['id']);
  final name = _text(patient?['name']);
  final phone = _text(patient?['phone']);
  final hospitalNumber = _text(patient?['hospital_number']);
  if (uid.isNotEmpty) params['patient_uid'] = uid;
  if (id.isNotEmpty) params['patient_id'] = id;
  if (name.isNotEmpty) params['name'] = name;
  if (phone.isNotEmpty) params['phone'] = phone;
  if (hospitalNumber.isNotEmpty) params['hospital_number'] = hospitalNumber;
  final query = Uri(queryParameters: params).query;
  return query.isEmpty ? path : '$path?$query';
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
  const FrontOfficeWorkbenchScreen({super.key});

  @override
  State<FrontOfficeWorkbenchScreen> createState() =>
      _FrontOfficeWorkbenchScreenState();
}

class _FrontOfficeWorkbenchScreenState
    extends State<FrontOfficeWorkbenchScreen> {
  final _searchCtrl = TextEditingController();
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
  bool get _canAdmitIp =>
      _role == StaffRole.admin ||
      _role == StaffRole.superAdmin ||
      _role == StaffRole.medicalSuperintendent ||
      _role == StaffRole.receptionist ||
      _role == StaffRole.receptionIncharge ||
      _role == StaffRole.billingStaff ||
      _role == StaffRole.billingIncharge ||
      _role == StaffRole.financeIncharge ||
      _role == StaffRole.admissionOfficer ||
      _role == StaffRole.insuranceCoordinator ||
      _role == StaffRole.ipdCounsellor;

  @override
  void initState() {
    super.initState();
    _loadInitialState();
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
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadInitialState() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (!mounted) return;
    setState(() {
      _role = role;
      _roleLoaded = true;
      _loading = false;
    });

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
        FrontOfficeQueueScope.full =>
          ScheduleApiService.getTodayAppointmentQueue(),
        FrontOfficeQueueScope.mine =>
          ScheduleApiService.getMyTodayAppointmentQueue(),
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
    if (value is Map) value = value['data'] ?? value['items'] ?? value['rows'];
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

  Future<void> _searchPatients(String value) async {
    final query = value.trim();
    if (!frontOfficeLookupQueryReady(query)) {
      setState(() {
        _patientMatches = const [];
        _lookupBusy = false;
        _lookupError = null;
      });
      return;
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
      if (!mounted || _searchCtrl.text.trim() != query) return;
      setState(() {
        _patientMatches = matches;
        _lookupBusy = false;
      });
    } catch (e) {
      if (!mounted || _searchCtrl.text.trim() != query) return;
      setState(() {
        _lookupError = e.toString();
        _lookupBusy = false;
      });
    }
  }

  Future<void> _selectPatient(Map<String, dynamic> patient) async {
    setState(() {
      _selectedPatient = patient;
      _patientMatches = const [];
      _searchCtrl.text = _patientLabel(patient);
    });
    await _loadInvoicesFor(patient);
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
    final hn = patient['hospital_number']?.toString();
    final name = patient['name']?.toString();
    final phone = patient['phone']?.toString();
    return [
      if (hn != null && hn.isNotEmpty) hn,
      if (name != null && name.isNotEmpty) name,
      if (phone != null && phone.isNotEmpty) phone,
    ].join(' - ');
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
      successMessage: 'Appointment confirmed',
      action: (id) => ScheduleApiService.confirmAppointment(id, {
        'confirmation_notes': 'Confirmed from Front Office Workbench',
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
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
              children: [
                _buildHeader(mode),
                const SizedBox(height: 12),
                if (_error != null)
                  _InlineAlert(message: _error!, color: AppTheme.errorRed),
                if (_loading) const LinearProgressIndicator(minHeight: 2),
                if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        flex: 5,
                        child: Column(
                          children: [
                            _buildPatientPanel(),
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
                            _buildQueuePanel(),
                            const SizedBox(height: 12),
                            _buildBillingPanel(),
                            const SizedBox(height: 12),
                            _buildAdmissionsPanel(),
                          ],
                        ),
                      ),
                    ],
                  )
                else ...[
                  _buildPatientPanel(),
                  const SizedBox(height: 12),
                  _buildActionPanel(),
                  const SizedBox(height: 12),
                  _buildQueuePanel(),
                  const SizedBox(height: 12),
                  _buildBillingPanel(),
                  const SizedBox(height: 12),
                  _buildAdmissionsPanel(),
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
            label: 'Today Queue',
            value: '${_todayQueue.length}',
            color: AppTheme.primaryTeal,
          ),
          _Metric(
            icon: Icons.local_hospital,
            label: 'Active IP',
            value: '$_activeAdmissionsTotal',
            color: AppTheme.primaryBlue,
          ),
          if (_canViewAdmissionHandoffs)
            _Metric(
              icon: Icons.move_down_outlined,
              label: 'IP Handoff',
              value: '${_admissionHandoffs.length}',
              color: AppTheme.warningAmber,
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
                  child: TextField(
                    controller: _searchCtrl,
                    onChanged: _queuePatientLookup,
                    onSubmitted: _searchPatients,
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
            _PatientCard(
              patient: selected,
              selected: true,
              onTap: () => context.push(
                '/emr/timeline/${selected['uid']}?name=${Uri.encodeComponent(selected['name']?.toString() ?? 'Patient')}',
              ),
            ),
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
                  icon: Icons.note_add_outlined,
                  label: 'Notes',
                  color: AppTheme.primaryBlue,
                  enabled: hasPatient,
                  onTap: () {
                    final uid = _selectedPatientUid();
                    if (uid == null) return;
                    context.push(
                      '/emr/notes/$uid?name=${Uri.encodeComponent(_selectedPatient?['name']?.toString() ?? 'Patient')}',
                    );
                  },
                ),
              if (_canClinical)
                _ActionTile(
                  icon: Icons.monitor_heart_outlined,
                  label: 'Vitals',
                  color: AppTheme.errorRed,
                  enabled: hasPatient,
                  onTap: () => context.push(_patientRoute('/vitals')),
                ),
              if (_canClinical)
                _ActionTile(
                  icon: Icons.playlist_add_check_circle_outlined,
                  label: 'Orders',
                  color: AppTheme.warningAmber,
                  enabled: hasPatient,
                  onTap: () {
                    final uid = _selectedPatientUid();
                    if (uid == null) return;
                    context.push(
                      '/emr/orders/$uid?name=${Uri.encodeComponent(_selectedPatient?['name']?.toString() ?? 'Patient')}',
                    );
                  },
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
        ? 'My OP Queue'
        : 'Today Queue';
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.event_note,
            title: title,
            trailing: TextButton.icon(
              onPressed: _refreshWorklists,
              icon: const Icon(Icons.refresh),
              label: const Text('Refresh'),
            ),
          ),
          const SizedBox(height: 8),
          if (queueScope == FrontOfficeQueueScope.none)
            const _EmptyLine(
              icon: Icons.lock_outline,
              text: 'OP queue is restricted for this role',
            )
          else if (_todayQueue.isEmpty)
            const _EmptyLine(
              icon: Icons.event_busy,
              text: 'No queue rows loaded',
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
    final status = _appointmentStatus(row);
    final time = row['appointment_time'] ?? row['time'] ?? row['slot'];
    final busy = id != null && _queueActionId == id;
    final selected = _queueRowMatchesSelectedPatient(row);
    final terminal = const {
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    }.contains(status);
    final canConfirm = _canManageOpQueue && status == 'SCHEDULED';
    final canComplete =
        _canCompleteOpQueue &&
        (status == 'CONFIRMED' || status == 'IN_PROGRESS');
    final canNoShow = _canManageOpQueue;
    final hasQueueAction =
        !terminal && (canConfirm || canComplete || canNoShow);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: ListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        leading: CircleAvatar(
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
        title: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text([?time, status].join(' - ')),
        selected: selected,
        selectedTileColor: AppTheme.primaryBlue.withValues(alpha: 0.06),
        trailing: hasQueueAction
            ? Wrap(
                spacing: 6,
                children: [
                  if (canConfirm)
                    _QueueActionButton(
                      icon: Icons.check,
                      label: 'Confirm',
                      color: AppTheme.primaryTeal,
                      onPressed: busy
                          ? null
                          : () => _confirmQueueAppointment(row),
                    ),
                  if (canComplete)
                    _QueueActionButton(
                      icon: Icons.done_all,
                      label: 'Complete',
                      color: AppTheme.successGreen,
                      onPressed: busy
                          ? null
                          : () => _completeQueueAppointment(row),
                    ),
                  if (canNoShow)
                    _QueueActionButton(
                      icon: Icons.person_off_outlined,
                      label: 'No-show',
                      color: AppTheme.textSecondary,
                      onPressed: busy ? null : () => _markQueueNoShow(row),
                    ),
                ],
              )
            : const Icon(Icons.chevron_right),
        onTap: () => _selectQueuePatient(row),
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
    final isDraft = status == 'DRAFT';
    final due = billingInvoiceAmountDue(invoice);
    final canCollect = billingInvoiceCanCollect(invoice);
    final canPrintTax = billingInvoiceCanPrintTaxInvoice(invoice);
    final canPrintReceipt = billingInvoiceCanPrintReceipt(invoice);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: ListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.receipt_long_outlined),
        title: Text(
          id.toString(),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text('${invoice['invoice_type'] ?? 'OP'} - $status'),
        trailing: Wrap(
          spacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(_money(due)),
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
                    : () => _printInvoiceDocument(
                        invoice,
                        BillingDocumentType.receipt,
                      ),
                icon: const Icon(Icons.receipt_outlined, size: 18),
              ),
            if (isDraft)
              SizedBox(
                height: 34,
                child: OutlinedButton.icon(
                  onPressed: _billingActionBusy
                      ? null
                      : () => _issueInvoice(invoice),
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
          ],
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
            title: 'Active Admissions',
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
                    'OPD Admission Handoff',
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
      child: ListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.assignment_returned_outlined),
        title: Text(
          name.isEmpty ? 'Patient advised for IP' : name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          [
            if (phone.isNotEmpty) phone,
            if (doctor.isNotEmpty) doctor,
            if (advisedAt.isNotEmpty) advisedAt,
            if (note.isNotEmpty) note,
          ].join(' - '),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: IconButton.filledTonal(
          tooltip: 'Admit IP',
          onPressed: busy ? null : () => _startAdmissionFromAdvice(row),
          icon: busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.local_hospital_outlined),
        ),
        onTap: busy ? null : () => _startAdmissionFromAdvice(row),
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

  const _Metric({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 132),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                value,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                  color: color,
                ),
              ),
              Text(label, style: TextStyle(color: AppTheme.textSecondary)),
            ],
          ),
        ],
      ),
    );
  }
}

class _PatientCard extends StatelessWidget {
  final Map<String, dynamic> patient;
  final bool selected;
  final VoidCallback onTap;

  const _PatientCard({
    required this.patient,
    required this.onTap,
    this.selected = false,
  });

  @override
  Widget build(BuildContext context) {
    final name = patient['name']?.toString() ?? 'Patient';
    final phone = patient['phone']?.toString();
    final hn = patient['hospital_number']?.toString();
    final age = patient['age']?.toString();
    final gender = patient['gender']?.toString();
    return Material(
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
                child: const Icon(Icons.person_outline),
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
                    Text(
                      [
                        if (hn != null && hn.isNotEmpty) hn,
                        if (phone != null && phone.isNotEmpty) phone,
                        if (age != null && age.isNotEmpty) '$age yrs',
                        if (gender != null && gender.isNotEmpty) gender,
                      ].join(' - '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right),
            ],
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
        label: Text(label),
        style: OutlinedButton.styleFrom(
          foregroundColor: color,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          visualDensity: VisualDensity.compact,
        ),
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
