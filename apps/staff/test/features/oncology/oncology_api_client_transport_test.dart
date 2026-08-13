import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/oncology/screens/oncology_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({'jwt': 'staff-access-token'});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = () => 'tablet';
    VHHttpClient.appCheckTokenProvider = () async => 'app-check-token';
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
    VHHttpClient.appCheckTokenProvider = null;
  });

  test('all oncology reads use the shared authenticated transport', () async {
    final requests = <http.Request>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        requests.add(request);
        if (request.url.path.endsWith('/oncology/tumor-board/queue')) {
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'cases': [
                  {
                    'id': 11,
                    'patient_uid': 'patient-1',
                    'cancer_site': 'lung',
                    'question': 'Review stage',
                    'priority': 'urgent',
                    'discussion_state': 'queued',
                  },
                ],
              },
            }),
            200,
          );
        }
        expect(request.url.path, endsWith('/oncology/toxicity-events'));
        expect(request.url.queryParameters, {'limit': '25'});
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'toxicity_events': [
                {
                  'id': 22,
                  'patient_uid': 'patient-1',
                  'toxicity_term': 'nausea',
                  'ctcae_grade': 2,
                  'signoff_status': 'signed',
                },
              ],
            },
          }),
          200,
        );
      }),
    );

    const client = HttpOncologyApiClient();
    final queue = await client.fetchTumorBoardQueue();
    final toxicity = await client.fetchToxicityEvents();

    expect(queue.single.id, 11);
    expect(toxicity.single.id, 22);
    expect(requests, hasLength(2));
    for (final request in requests) {
      expect(request.method, 'GET');
      expect(request.headers['authorization'], 'Bearer staff-access-token');
      expect(request.headers['x-device-type'], 'tablet');
      expect(request.headers['x-firebase-appcheck'], 'app-check-token');
    }
  });

  test('toxicity writes carry one explicit RFC-4122 idempotency key', () async {
    String? idempotencyKey;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, endsWith('/oncology/toxicity-events'));
        idempotencyKey = request.headers['idempotency-key'];
        expect(jsonDecode(request.body), {
          'patient_uid': 'patient-1',
          'diagnosis_id': 7,
          'toxicity_term': 'neutropenia',
          'ctcae_grade': 3,
          'ctcae_source': 'CTCAE',
          'ctcae_source_version': '5.0',
          'action_taken': 'hold',
          'signoff': true,
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'toxicity_event': {
                'id': 23,
                'patient_uid': 'patient-1',
                'toxicity_term': 'neutropenia',
                'ctcae_grade': 3,
                'signoff_status': 'signed',
              },
            },
          }),
          201,
        );
      }),
    );

    final event = await const HttpOncologyApiClient().createToxicityEvent(
      const OncologyToxicityInput(
        patientUid: 'patient-1',
        diagnosisId: 7,
        term: 'neutropenia',
        grade: 3,
        source: 'CTCAE',
        sourceVersion: '5.0',
        actionTaken: 'hold',
      ),
    );

    expect(event.id, 23);
    expect(
      idempotencyKey,
      matches(
        RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        ),
      ),
    );
  });

  test('401 refresh replay preserves the oncology idempotency key', () async {
    FlutterSecureStorage.setMockInitialValues({
      'jwt': 'expired-access-token',
      'refreshToken': 'staff-refresh-token',
      'staffInstallationId': '12345678-1234-4abc-8def-1234567890ab',
    });
    final oncologyRequests = <http.Request>[];
    http.Request? refreshRequest;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        if (request.url.path.endsWith('/auth/refresh-token')) {
          refreshRequest = request;
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'accessToken': 'refreshed-access-token',
                'refreshToken': 'rotated-refresh-token',
              },
            }),
            200,
          );
        }

        expect(request.url.path, endsWith('/oncology/toxicity-events'));
        oncologyRequests.add(request);
        if (oncologyRequests.length == 1) {
          return http.Response(
            jsonEncode({'success': false, 'message': 'expired'}),
            401,
          );
        }
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'toxicity_event': {
                'id': 24,
                'patient_uid': 'patient-1',
                'toxicity_term': 'mucositis',
                'ctcae_grade': 2,
                'signoff_status': 'signed',
              },
            },
          }),
          201,
        );
      }),
    );

    final event = await const HttpOncologyApiClient().createToxicityEvent(
      const OncologyToxicityInput(
        patientUid: 'patient-1',
        term: 'mucositis',
        grade: 2,
        source: 'CTCAE',
        sourceVersion: '5.0',
        actionTaken: 'supportive care',
      ),
    );

    expect(event.id, 24);
    expect(oncologyRequests, hasLength(2));
    final firstKey = oncologyRequests.first.headers['idempotency-key'];
    expect(firstKey, isNotNull);
    expect(oncologyRequests.last.headers['idempotency-key'], firstKey);
    expect(
      oncologyRequests.first.headers['authorization'],
      'Bearer expired-access-token',
    );
    expect(
      oncologyRequests.last.headers['authorization'],
      'Bearer refreshed-access-token',
    );
    expect(jsonDecode(refreshRequest!.body), {
      'refreshToken': 'staff-refresh-token',
      'installationId': '12345678-1234-4abc-8def-1234567890ab',
    });
  });
}
