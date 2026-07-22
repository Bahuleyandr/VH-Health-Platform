import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/radiology_api_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  test(
    'signs a report with explicit specialist classification evidence',
    () async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, endsWith('/radiology/41/sign-off'));
          expect(request.headers['idempotency-key'], isNotEmpty);
          expect(jsonDecode(request.body), {
            'result_classification': 'indeterminate',
            'classification_basis': {
              'basis_code': 'authenticated_specialist_report_review',
              'source': 'signed_radiology_report',
            },
          });
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'id': 41,
                'result_classification': 'indeterminate',
                'report_generation_version': 1,
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final report = await RadiologyApiService.signOffReport(
        41,
        resultClassification: 'indeterminate',
      );

      expect(report['result_classification'], 'indeterminate');
      expect(report['report_generation_version'], 1);
    },
  );

  test(
    'appends a signed correction with classification and significance',
    () async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, endsWith('/radiology/42/addendum'));
          expect(request.headers['idempotency-key'], isNotEmpty);
          expect(jsonDecode(request.body), {
            'addendum': 'Correction after specialist image review.',
            'result_classification': 'normal',
            'classification_basis': {
              'basis_code': 'authenticated_specialist_addendum_review',
              'source': 'signed_radiology_addendum',
            },
            'clinical_significance': 'corrected',
          });
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'addendum': {
                  'id': 7,
                  'generation_version': 2,
                  'result_classification': 'normal',
                  'clinical_significance': 'corrected',
                },
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final report = await RadiologyApiService.appendAddendum(
        42,
        addendum: 'Correction after specialist image review.',
        resultClassification: 'normal',
        clinicalSignificance: 'corrected',
      );

      expect(report['addendum'], {
        'id': 7,
        'generation_version': 2,
        'result_classification': 'normal',
        'clinical_significance': 'corrected',
      });
    },
  );

  test('holds a structured result using its immutable generation id', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'PATCH');
        expect(
          request.url.path,
          endsWith('/diagnostic-results/release/generation-42/hold'),
        );
        expect(jsonDecode(request.body), {
          'hold': true,
          'reason': 'Complete specialist review',
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'release_state': {
                'generation_id': 'generation-42',
                'release_hold': true,
              },
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final state = await RadiologyApiService.setPatientReleaseHold(
      'generation-42',
      hold: true,
      reason: 'Complete specialist review',
    );

    expect(state['release_state']['release_hold'], isTrue);
  });

  test('explicitly releases a reviewed structured result', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.path,
          endsWith('/diagnostic-results/release/generation-43/release-now'),
        );
        expect(jsonDecode(request.body), isEmpty);
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'release_state': {
                'generation_id': 'generation-43',
                'released_to_patient_at': '2026-07-22T12:00:00.000Z',
              },
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final state = await RadiologyApiService.releaseToPatientNow(
      'generation-43',
    );

    expect(state['release_state']['released_to_patient_at'], isNotNull);
  });
}
