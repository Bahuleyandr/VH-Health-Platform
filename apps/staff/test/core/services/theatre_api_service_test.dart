import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/theatre_api_service.dart';

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

  void respond(Object? body, {int status = 200}) {
    VHHttpClient.setClientForTesting(
      MockClient((_) async => http.Response(jsonEncode(body), status)),
    );
  }

  test(
    'canonical schedule array preserves filters and authenticated transport',
    () async {
      final schedule = {
        'id': 42,
        'procedure_name': 'Appendectomy',
        'status': 'pre_op',
        'pre_op_checklist': {'consent_obtained': true, 'blood_arranged': false},
        'cssd_warnings': <String>[],
      };
      var requests = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          requests++;
          expect(request.method, 'GET');
          expect(request.url.path, endsWith('/theatre/today'));
          expect(request.url.queryParameters, {
            'date': '2026-09-11',
            'ot_room': 'OT-1',
            'status': 'pre_op',
          });
          expect(request.headers['authorization'], 'Bearer staff-access-token');
          expect(request.headers['x-device-type'], 'tablet');
          expect(request.headers['x-firebase-appcheck'], 'app-check-token');
          return http.Response(
            jsonEncode({
              'success': true,
              'data': [schedule],
            }),
            200,
          );
        }),
      );

      expect(
        await TheatreApiService.getTodaySchedule(
          date: '2026-09-11',
          otRoom: 'OT-1',
          status: 'pre_op',
        ),
        [schedule],
      );
      expect(requests, 1);
    },
  );

  test('canonical empty schedule array is a valid empty result', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.queryParameters, isEmpty);
        return http.Response(jsonEncode({'success': true, 'data': []}), 200);
      }),
    );
    expect(await TheatreApiService.getTodaySchedule(), isEmpty);
  });

  for (final entry in <String, Object?>{
    'null': null,
    'object': <String, dynamic>{},
    'nested schedules': {'schedules': []},
    'string': 'not a schedule',
    'number': 42,
    'null row': [null],
    'string row': ['not a row'],
    'mixed rows': [
      {'id': 42},
      false,
    ],
    'list checklist': [
      {'id': 42, 'pre_op_checklist': []},
    ],
    'string checklist': [
      {'id': 42, 'pre_op_checklist': 'not a checklist'},
    ],
    'boolean checklist': [
      {'id': 42, 'pre_op_checklist': true},
    ],
  }.entries) {
    test('rejects malformed schedule data: ${entry.key}', () async {
      respond({'success': true, 'data': entry.value});
      await expectLater(
        TheatreApiService.getTodaySchedule(),
        throwsA(isA<FormatException>()),
      );
    });
  }

  test('missing schedule data is not a valid empty result', () async {
    respond({'success': true});
    await expectLater(
      TheatreApiService.getTodaySchedule(),
      throwsA(isA<FormatException>()),
    );
  });

  for (final status in [200, 401, 403, 500]) {
    test('server failure $status is not a valid empty result', () async {
      respond({
        'success': false,
        'message': 'Theatre request denied',
      }, status: status);
      await expectLater(TheatreApiService.getTodaySchedule(), throwsException);
    });
  }

  test('malformed JSON response is not a valid empty result', () async {
    VHHttpClient.setClientForTesting(
      MockClient((_) async => http.Response('not-json', 200)),
    );
    await expectLater(TheatreApiService.getTodaySchedule(), throwsException);
  });

  test(
    'object-returning writes preserve their requests and response data',
    () async {
      final requests = <http.Request>[];
      final response = {'id': 42, 'status': 'pre_op'};
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          requests.add(request);
          expect(request.headers['authorization'], 'Bearer staff-access-token');
          return http.Response(
            jsonEncode({'success': true, 'data': response}),
            request.method == 'POST' ? 201 : 200,
          );
        }),
      );
      expect(
        await TheatreApiService.scheduleSurgery({'procedure_name': 'Review'}),
        response,
      );
      expect(await TheatreApiService.updateStatus(42, 'pre_op'), response);
      expect(
        await TheatreApiService.updateChecklist(42, {'blood_arranged': false}),
        response,
      );
      expect(
        await TheatreApiService.recordSafetyPhase(42, 'sign_in', {
          'status': 'incomplete',
          'all_items_confirmed': false,
        }),
        response,
      );
      expect(await TheatreApiService.cancelSurgery(42), response);
      expect(requests.map((request) => request.method), [
        'POST',
        'PUT',
        'PUT',
        'PUT',
        'DELETE',
      ]);
      expect(
        requests.map((request) => request.url.path.split('/api/v1').last),
        [
          '/theatre/schedule',
          '/theatre/42/status',
          '/theatre/42/checklist',
          '/surgical/safety/42/sign_in',
          '/theatre/42',
        ],
      );
      expect(jsonDecode(requests[0].body), {'procedure_name': 'Review'});
      expect(jsonDecode(requests[1].body), {'status': 'pre_op'});
      expect(jsonDecode(requests[2].body), {
        'checklist': {'blood_arranged': false},
      });
      expect(jsonDecode(requests[3].body), {
        'status': 'incomplete',
        'all_items_confirmed': false,
      });
    },
  );

  test(
    'canonical availability preserves room names and date occupancy',
    () async {
      final roomSchedules = [
        {
          'ot_room': 'OT-1',
          'surgery_count': 1,
          'times': ['10:00:00'],
          'statuses': ['scheduled'],
        },
        {
          'ot_room': 'OT-2',
          'surgery_count': 1,
          'times': ['08:00:00'],
          'statuses': ['completed'],
        },
      ];
      var requests = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          requests++;
          expect(request.method, 'GET');
          expect(request.url.path, endsWith('/theatre/availability'));
          expect(request.url.queryParameters, {'date': '2026-09-11'});
          expect(request.headers['authorization'], 'Bearer staff-access-token');
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'date': '2026-09-11',
                'booked_rooms': ['OT-1'],
                'room_schedules': roomSchedules,
              },
            }),
            200,
          );
        }),
      );
      expect(await TheatreApiService.getAvailability('2026-09-11'), [
        {...roomSchedules[0], 'name': 'OT-1', 'available': false},
        {...roomSchedules[1], 'name': 'OT-2', 'available': true},
      ]);
      expect(requests, 1);
    },
  );

  test('empty room summaries do not invent available rooms', () async {
    respond({
      'success': true,
      'data': {'date': '2026-09-11', 'booked_rooms': [], 'room_schedules': []},
    });
    expect(await TheatreApiService.getAvailability('2026-09-11'), isEmpty);
  });

  for (final entry in <String, Object?>{
    'missing lists': <String, dynamic>{},
    'legacy rooms': {'rooms': []},
    'missing booked rooms': {'room_schedules': []},
    'missing room schedules': {'booked_rooms': []},
    'non-list booked rooms': {'booked_rooms': 'OT-1', 'room_schedules': []},
    'invalid booked room': {
      'booked_rooms': [null],
      'room_schedules': [],
    },
    'non-list room schedules': {'booked_rooms': [], 'room_schedules': {}},
    'invalid room row': {
      'booked_rooms': [],
      'room_schedules': [null],
    },
    'missing room name': {
      'booked_rooms': [],
      'room_schedules': [{}],
    },
    'empty room name': {
      'booked_rooms': [],
      'room_schedules': [
        {'ot_room': ''},
      ],
    },
  }.entries) {
    test('rejects malformed availability data: ${entry.key}', () async {
      respond({'success': true, 'data': entry.value});
      await expectLater(
        TheatreApiService.getAvailability('2026-09-11'),
        throwsA(isA<FormatException>()),
      );
    });
  }

  test('availability server failure is not an empty room result', () async {
    respond({
      'success': false,
      'message': 'Theatre request denied',
    }, status: 403);
    await expectLater(
      TheatreApiService.getAvailability('2026-09-11'),
      throwsException,
    );
  });
}
