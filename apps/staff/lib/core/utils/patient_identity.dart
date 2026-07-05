String patientIdentityText(dynamic value) => value?.toString().trim() ?? '';

String patientDigitsOnly(String value) => value.replaceAll(RegExp(r'\D'), '');

String patientNameFrom(
  Map<String, dynamic>? patient, {
  String fallback = 'Patient',
}) {
  final text = _firstPatientText(patient, const [
    'name',
    'patient_name',
    'patientName',
    'title',
  ]);
  return text.isEmpty ? fallback : text;
}

String patientPhoneFrom(Map<String, dynamic>? patient) {
  return _firstPatientText(patient, const [
    'phone',
    'patient_phone',
    'patientPhone',
    'mobile',
    'mobile_number',
  ]);
}

String patientHospitalNumberFrom(Map<String, dynamic>? patient) {
  return _firstPatientText(patient, const [
    'hospital_number',
    'patient_hospital_number',
    'hospitalNumber',
    'mrn',
    'uhid',
  ]);
}

String patientUidFrom(Map<String, dynamic>? patient) {
  return _firstPatientText(patient, const ['uid', 'patient_uid', 'patientUid']);
}

String patientIdFrom(Map<String, dynamic>? patient) {
  return _firstPatientText(patient, const ['id', 'patient_id', 'patientId']);
}

String patientAbhaFrom(Map<String, dynamic>? patient) {
  return _firstPatientText(patient, const ['abha_address', 'abhaAddress']);
}

String patientProfilePictureFrom(Map<String, dynamic>? patient) {
  return _firstPatientText(patient, const [
    'profile_picture',
    'profilePicture',
    'photo_url',
    'photoUrl',
    'image_url',
    'imageUrl',
  ]);
}

String patientAgeFrom(Map<String, dynamic>? patient) {
  return _firstPatientText(patient, const ['age', 'patient_age']);
}

String patientGenderFrom(Map<String, dynamic>? patient) {
  return _firstPatientText(patient, const ['gender', 'patient_gender']);
}

String patientSearchLabel(Map<String, dynamic>? patient) {
  final parts = <String>[
    patientHospitalNumberFrom(patient),
    patientNameFrom(patient, fallback: ''),
    patientPhoneFrom(patient),
  ].where((part) => part.isNotEmpty).toList(growable: false);
  return parts.isEmpty ? 'Patient' : parts.join(' - ');
}

String patientSubtitle(
  Map<String, dynamic>? patient, {
  bool includeAgeGender = false,
  bool includeAbha = false,
  bool prefixHospitalId = false,
  String separator = ' - ',
}) {
  final hospitalNumber = patientHospitalNumberFrom(patient);
  final age = patientAgeFrom(patient);
  final gender = patientGenderFrom(patient);
  final phone = patientPhoneFrom(patient);
  final abha = patientAbhaFrom(patient);
  final parts = <String>[
    if (hospitalNumber.isNotEmpty)
      prefixHospitalId ? 'Hospital ID $hospitalNumber' : hospitalNumber,
    if (phone.isNotEmpty) phone,
    if (includeAgeGender && age.isNotEmpty) '$age yrs',
    if (includeAgeGender && gender.isNotEmpty) gender,
    if (includeAbha && abha.isNotEmpty) abha,
  ];
  return parts.join(separator);
}

bool patientPhoneLikeQuery(String value) {
  final query = value.trim();
  return patientDigitsOnly(query).isNotEmpty &&
      RegExp(r'^[\d\s()+.-]+$').hasMatch(query);
}

bool patientPhoneMeetsMinimum(String value) {
  return patientDigitsOnly(value).length >= 10;
}

bool patientLookupQueryReady(String value) {
  final query = value.trim();
  if (query.length < 2) return false;
  if (patientPhoneLikeQuery(query)) return patientPhoneMeetsMinimum(query);
  return true;
}

bool patientMatchesLookupQuery(Map<String, dynamic> patient, String rawQuery) {
  final query = rawQuery.trim();
  final queryDigits = patientDigitsOnly(query);
  if (!patientPhoneLikeQuery(query)) return true;
  if (queryDigits.length < 10) return false;

  final patientDigits = patientDigitsOnly(patientPhoneFrom(patient));
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

String patientScopedRoute(
  String path, {
  Map<String, dynamic>? patient,
  Map<String, String> queryParameters = const {},
}) {
  final params = <String, String>{...queryParameters};
  final uid = patientUidFrom(patient);
  final id = patientIdFrom(patient);
  final name = patientNameFrom(patient, fallback: '');
  final phone = patientPhoneFrom(patient);
  final hospitalNumber = patientHospitalNumberFrom(patient);
  if (uid.isNotEmpty) params['patient_uid'] = uid;
  if (id.isNotEmpty) params['patient_id'] = id;
  if (name.isNotEmpty) params['name'] = name;
  if (phone.isNotEmpty) params['phone'] = phone;
  if (hospitalNumber.isNotEmpty) params['hospital_number'] = hospitalNumber;
  final query = Uri(queryParameters: params).query;
  return query.isEmpty ? path : '$path?$query';
}

String _firstPatientText(Map<String, dynamic>? patient, Iterable<String> keys) {
  if (patient == null) return '';
  for (final key in keys) {
    final text = patientIdentityText(patient[key]);
    if (text.isNotEmpty) return text;
  }
  return '';
}
