import 'dart:convert';

import 'package:vhhealth/core/services/patient_session_authority.dart';

void installCurrentPatientSessionAuthority() {
  final jwt = _testJwt();
  PatientSessionAuthority.setForTesting(
    PatientSessionAuthority.forTesting(
      read: (key) async => key == 'jwt' ? jwt : null,
      write: (_, _) async {},
    ),
  );
}

String _testJwt() {
  final header = base64UrlEncode(
    utf8.encode(jsonEncode({'alg': 'HS256', 'typ': 'JWT'})),
  ).replaceAll('=', '');
  final payload = base64UrlEncode(
    utf8.encode(
      jsonEncode({
        'sub': 'cache-test-patient',
        'jti': 'cache-test-token',
        'role': 'PATIENT',
        'exp': 253402300799,
      }),
    ),
  ).replaceAll('=', '');
  return '$header.$payload.signature';
}
