part of '../front_office_workbench_screen.dart';

DateTime _dateOnly(DateTime value) =>
    DateTime(value.year, value.month, value.day);

String _dateParam(DateTime value) => DateFormat('yyyy-MM-dd').format(value);

@visibleForTesting
String frontOfficeQueueDateLabel(DateTime date, {DateTime? now}) {
  return frontOfficeQueueDateLabelForStrings(
    AppStrings.forLocale(const Locale('en')),
    date,
    now: now,
  );
}

String frontOfficeQueueDateLabelForStrings(
  AppStrings s,
  DateTime date, {
  DateTime? now,
}) {
  final today = _dateOnly(now ?? DateTime.now());
  final day = _dateOnly(date);
  final offset = day.difference(today).inDays;
  if (offset == 0) return s.frontOfficeQueueTodayOp;
  if (offset == 1) return s.frontOfficeQueueTomorrowOp;
  if (offset == 2) return s.frontOfficeQueueFollowingDayOp;
  return s.frontOfficeQueueDatedOp(DateFormat('EEE, d MMM').format(day));
}

String frontOfficeQuickQueueDateLabel(AppStrings s, int offset) {
  return switch (offset) {
    0 => s.frontOfficeQueueToday,
    1 => s.frontOfficeQueueTomorrow,
    _ => s.frontOfficeQueueFollowingDay,
  };
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
  return AppStrings.forLocale(
    const Locale('en'),
  ).frontOfficeAppointmentStatusLabel(status);
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
Map<String, dynamic> frontOfficeSupervisedKioskCheckinPayload({
  required int appointmentId,
  String? department,
  Map<String, dynamic>? profileDelta,
}) {
  final body = <String, dynamic>{
    'appointmentId': appointmentId,
    if (_text(department).isNotEmpty) 'department': _text(department),
    if (profileDelta != null && profileDelta.isNotEmpty)
      'profileDelta': Map<String, dynamic>.from(profileDelta),
    'acknowledgements': const ['front_office_arrival_confirmed'],
  };
  return body;
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

String _admissionAdviceSummary(AppStrings s, Map<String, dynamic> row) {
  final id = frontOfficeAdmissionAdviceIdFrom(row);
  final advisedAt = _admissionAdviceDate(row);
  final note = _admissionAdviceNote(row);
  return [
    s.lookup('s4.lib.front_office_workbench.opd_admission_advice'),
    if (id != null) '#$id',
    if (advisedAt.isNotEmpty) advisedAt,
    if (note.isNotEmpty) note,
  ].join(' - ');
}

String _frontOfficeAdmissionPriorityLabel(AppStrings s, String value) {
  return switch (value.toLowerCase()) {
    'urgent' => s.admissionPriorityUrgent,
    'emergency' => s.admissionPriorityEmergency,
    'critical' => s.admissionPriorityCritical,
    _ => s.admissionPriorityRoutine,
  };
}

String _frontOfficeCodeStatusLabel(AppStrings s, String value) {
  return switch (value.toLowerCase()) {
    'dnr' => s.admissionCodeDnr,
    'dnr/dni' => s.admissionCodeDnrDni,
    'comfort care' => s.admissionCodeComfort,
    _ => s.admissionCodeFull,
  };
}

String _frontOfficeOpAppointmentsTodayLabel(AppStrings s, int count) {
  return s.format(
    count == 1
        ? 's4.dynamic.front_office_workbench.op_appointment_today'
        : 's4.dynamic.front_office_workbench.op_appointments_today',
    {'count': count},
  );
}

String _frontOfficeBillsDueLabel(AppStrings s, int count, String amount) {
  return s.format(
    count == 1
        ? 's4.dynamic.front_office_workbench.bill_due'
        : 's4.dynamic.front_office_workbench.bills_due',
    {'count': count, 'amount': amount},
  );
}

int? _appointmentId(Map<String, dynamic> row) =>
    _intFrom(row['id'] ?? row['appointment_id']);

String _appointmentStatus(Map<String, dynamic> row) {
  final status = _text(row['status']).toUpperCase();
  return status.isEmpty ? 'SCHEDULED' : status;
}

String _queuePatientName(Map<String, dynamic> row, {AppStrings? strings}) {
  final patient = _patientFromQueueRow(row);
  final name = _text(patient?['name'] ?? row['patient_name'] ?? row['name']);
  if (name.isNotEmpty) return name;
  final phone = _text(
    patient?['phone'] ?? row['patient_phone'] ?? row['phone'],
  );
  return phone.isEmpty
      ? (strings ?? AppStrings.forLocale(const Locale('en'))).lookup(
          's4.lib.front_office_workbench.patient',
        )
      : phone;
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
