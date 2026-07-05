import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/utils/patient_identity.dart';

void main() {
  group('patient identity labels', () {
    test(
      'builds a canonical search label from hospital id, name, and phone',
      () {
        expect(
          patientSearchLabel({
            'hospital_number': 'VH-000097',
            'name': 'Test Patient',
            'phone': '+911234567890',
          }),
          'VH-000097 - Test Patient - +911234567890',
        );
      },
    );

    test('accepts patient-prefixed fields from queue and admission rows', () {
      final patient = {
        'patient_hospital_number': 'VH-000018',
        'patient_name': 'Asha Menon',
        'patient_phone': '9876543210',
        'patient_uid': 'patient-18',
        'patient_id': 18,
      };

      expect(
        patientSearchLabel(patient),
        'VH-000018 - Asha Menon - 9876543210',
      );
      expect(patientUidFrom(patient), 'patient-18');
      expect(patientIdFrom(patient), '18');
    });

    test('reads patient profile photos from backend aliases', () {
      expect(
        patientProfilePictureFrom({
          'profile_picture': 'https://cdn/patient.jpg',
        }),
        'https://cdn/patient.jpg',
      );
      expect(
        patientProfilePictureFrom({'photo_url': 'https://cdn/fallback.png'}),
        'https://cdn/fallback.png',
      );
    });

    test('builds route query params without losing patient context', () {
      final route = patientScopedRoute(
        '/patient-records',
        patient: {
          'id': 18,
          'uid': 'patient-18',
          'hospital_number': 'VH-000018',
          'name': 'Test Patient',
          'phone': '+911234567890',
        },
        queryParameters: const {'context': 'front-office'},
      );

      final uri = Uri.parse(route);
      expect(uri.path, '/patient-records');
      expect(uri.queryParameters['context'], 'front-office');
      expect(uri.queryParameters['patient_id'], '18');
      expect(uri.queryParameters['patient_uid'], 'patient-18');
      expect(uri.queryParameters['hospital_number'], 'VH-000018');
      expect(uri.queryParameters['name'], 'Test Patient');
      expect(uri.queryParameters['phone'], '+911234567890');
    });
  });

  group('patient lookup phone matching', () {
    test('requires 10 digits before phone search is ready', () {
      expect(patientLookupQueryReady('pr'), isTrue);
      expect(patientLookupQueryReady('123456789'), isFalse);
      expect(patientLookupQueryReady('1234567890'), isTrue);
      expect(patientLookupQueryReady('+91 12345 67890'), isTrue);
    });

    test('does not treat adjacent country-code digits as the same phone', () {
      expect(
        patientMatchesLookupQuery({'phone': '+911234567890'}, '1123456789'),
        isFalse,
      );
      expect(
        patientMatchesLookupQuery({'phone': '+911123456789'}, '1123456789'),
        isTrue,
      );
      expect(
        patientMatchesLookupQuery({'phone': '123456789'}, '1234566789'),
        isFalse,
      );
    });

    test(
      'leaves name and hospital id searches unfiltered after backend search',
      () {
        expect(
          patientMatchesLookupQuery({'phone': '+911234567890'}, 'test'),
          isTrue,
        );
        expect(
          patientMatchesLookupQuery({'phone': '+911234567890'}, 'VH-97'),
          isTrue,
        );
      },
    );
  });
}
