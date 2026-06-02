import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/widgets/patient_search_sheet.dart';

void main() {
  const patient = {
    'id': 18,
    'uid': 'patient-18',
    'hospital_number': 'VH-000018',
    'name': 'Test Patient',
    'phone': '+911234567890',
  };

  group('patientSearchOpenRouteForRole', () {
    test('keeps front-office roles in the workbench patient context', () {
      final route = patientSearchOpenRouteForRole('RECEPTIONIST', patient);

      final uri = Uri.parse(route);
      expect(uri.path, '/front-office');
      expect(uri.queryParameters['patient_uid'], 'patient-18');
      expect(uri.queryParameters['patient_id'], '18');
      expect(uri.queryParameters['hospital_number'], 'VH-000018');
      expect(uri.queryParameters['name'], 'Test Patient');
      expect(uri.queryParameters['phone'], '+911234567890');
    });

    test('opens clinical timeline for clinical roles', () {
      final route = patientSearchOpenRouteForRole('DOCTOR', patient);

      final uri = Uri.parse(route);
      expect(uri.path, '/emr/timeline/patient-18');
      expect(uri.queryParameters['name'], 'Test Patient');
    });
  });
}
