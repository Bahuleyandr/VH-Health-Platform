import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/navigation/ip_command_board_routes.dart';

void main() {
  group('ipCommandBoardRoute', () {
    test('builds focused patient command board route with encoded context', () {
      final route = ipCommandBoardRoute(
        patientUid: 'patient-123',
        admissionId: 77,
        patientName: 'Priya Iyer',
        action: 'vitals',
      );

      final uri = Uri.parse(route);
      expect(uri.path, '/patient-command-board');
      expect(uri.queryParameters, {
        'patient_uid': 'patient-123',
        'admission_id': '77',
        'action': 'vitals',
        'name': 'Priya Iyer',
      });
    });

    test('omits empty values and zero admission ids', () {
      final route = ipCommandBoardRoute(
        patientUid: ' patient-123 ',
        admissionId: 0,
        patientName: '',
      );

      final uri = Uri.parse(route);
      expect(uri.path, '/patient-command-board');
      expect(uri.queryParameters, {'patient_uid': 'patient-123'});
    });

    test('returns the board route without a trailing question mark', () {
      expect(ipCommandBoardRoute(), '/patient-command-board');
    });
  });
}
