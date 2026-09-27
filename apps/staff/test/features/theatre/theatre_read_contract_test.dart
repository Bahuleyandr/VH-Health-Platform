import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_staff/core/widgets/states/empty_state.dart';
import 'package:vhhealth_staff/core/widgets/states/error_state.dart';
import 'package:vhhealth_staff/features/theatre/screens/theatre_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final requests = <http.Request>[];
  final checklist = {
    'consent_obtained': true,
    'blood_arranged': false,
    'equipment_checked': true,
    'patient_identified': false,
  };
  Object? responseChecklist;

  setUp(() {
    responseChecklist = checklist;
    requests.clear();
    FlutterSecureStorage.setMockInitialValues({'jwt': 'staff-access-token'});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = () => 'tablet';
    VHHttpClient.appCheckTokenProvider = () async => 'app-check-token';
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        requests.add(request);
        expect(request.headers['authorization'], 'Bearer staff-access-token');
        if (request.method == 'GET') {
          expect(request.url.path, endsWith('/theatre/today'));
          expect(request.url.queryParameters.keys, ['date']);
          return http.Response(
            jsonEncode({
              'success': true,
              'data': [
                {
                  'id': 42,
                  'procedure_name': 'Appendectomy',
                  'patient_uid': '11111111-1111-4111-8111-111111111111',
                  'ot_room': 'OT-1',
                  'scheduled_date': request.url.queryParameters['date'],
                  'scheduled_time': '10:00',
                  'estimated_duration': 60,
                  'status': 'scheduled',
                  'pre_op_checklist': responseChecklist,
                  'checklist': {
                    'consent_obtained': false,
                    'blood_arranged': true,
                  },
                },
              ],
            }),
            200,
          );
        }
        expect(request.method, 'PUT');
        expect(request.url.path, endsWith('/theatre/42/checklist'));
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'id': 42,
              'pre_op_checklist': jsonDecode(request.body)['checklist'],
            },
          }),
          200,
        );
      }),
    );
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
    VHHttpClient.appCheckTokenProvider = null;
  });

  Future<AppStrings> openChecklist(
    WidgetTester tester, {
    List<bool> expectedValues = const [true, false, true, false],
  }) async {
    await tester.binding.setSurfaceSize(const Size(1000, 1200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: TheatreScreen(
          realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Appendectomy'), findsOneWidget);
    final strings = AppStrings.of(tester.element(find.byType(TheatreScreen)));
    await tester.tap(find.text('Appendectomy'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(strings.theatrePreOpChecklist));
    await tester.pumpAndSettle();
    expect(
      tester
          .widgetList<SwitchListTile>(find.byType(SwitchListTile))
          .map((tile) => tile.value),
      expectedValues,
    );
    return strings;
  }

  testWidgets(
    'default adapter loads canonical checklist without writing on dismiss',
    (tester) async {
      await openChecklist(tester);
      expect(requests, hasLength(1));
      Navigator.of(tester.element(find.byType(SwitchListTile).first)).pop();
      await tester.pumpAndSettle();
      expect(find.byType(SwitchListTile), findsNothing);
      expect(requests.map((request) => request.method), ['GET']);
    },
  );

  testWidgets(
    'explicit checklist submission preserves hydrated values and edits',
    (tester) async {
      final strings = await openChecklist(tester);
      expect(find.text(strings.theatreChecklistReadOnly), findsNothing);
      expect(
        tester.widgetList<SwitchListTile>(find.byType(SwitchListTile)),
        everyElement(
          isA<SwitchListTile>().having(
            (tile) => tile.onChanged,
            'onChanged',
            isNotNull,
          ),
        ),
      );
      await tester.tap(find.byType(SwitchListTile).at(1));
      await tester.pump();
      expect(requests, hasLength(1));
      await tester.tap(find.text(strings.theatreSubmitChecklist));
      await tester.pumpAndSettle();
      expect(requests.map((request) => request.method), ['GET', 'PUT', 'GET']);
      expect(jsonDecode(requests[1].body), {
        'checklist': {
          'consent_obtained': true,
          'blood_arranged': true,
          'equipment_checked': true,
          'patient_identified': false,
        },
      });
    },
  );

  testWidgets(
    'only explicit boolean true hydrates a confirmed checklist item',
    (tester) async {
      responseChecklist = {
        'consent_obtained': 'true',
        'blood_arranged': 1,
        'equipment_checked': false,
        'patient_identified': null,
      };
      final strings = await openChecklist(
        tester,
        expectedValues: [false, false, false, false],
      );
      expect(find.text(strings.theatreChecklistReadOnly), findsOneWidget);
      expect(find.text(strings.theatreSubmitChecklist), findsNothing);
      expect(
        tester
            .widgetList<SwitchListTile>(find.byType(SwitchListTile))
            .every((tile) => tile.onChanged == null),
        isTrue,
      );
      expect(
        jsonDecode(
          tester.widget<SelectableText>(find.byType(SelectableText)).data!,
        ),
        responseChecklist,
      );
      expect(requests.map((request) => request.method), ['GET']);
    },
  );

  for (final entry in <String, Map<String, dynamic>>{
    'unknown field': {'future_field': false},
    'clinical records': {
      'antibiotic_prophylaxis': 'Synthetic antibiotic note',
      'last_vitals': {'bp': '120/80', 'hr': 72},
      'known_allergies': ['Synthetic allergy'],
      'diabetic_protocol_note': 'Synthetic protocol — review only',
    },
    'readiness assertion': {'ot_ready': true},
    'system warnings': {'readiness_warnings': []},
  }.entries) {
    testWidgets('additional ${entry.key} restricts the checklist to viewing', (
      tester,
    ) async {
      responseChecklist = {...checklist, ...entry.value};
      final strings = await openChecklist(tester);
      expect(find.text(strings.theatreChecklistReadOnly), findsOneWidget);
      expect(find.text(strings.theatreSubmitChecklist), findsNothing);
      final tiles = tester.widgetList<SwitchListTile>(
        find.byType(SwitchListTile),
      );
      expect(tiles.every((tile) => tile.onChanged == null), isTrue);
      expect(
        jsonDecode(
          tester.widget<SelectableText>(find.byType(SelectableText)).data!,
        ),
        responseChecklist,
      );
      await tester.tap(find.byType(SwitchListTile).first);
      await tester.pump();
      expect(requests.map((request) => request.method), ['GET']);
      await tester.ensureVisible(find.text(strings.actionClose));
      await tester.tap(find.text(strings.actionClose));
      await tester.pumpAndSettle();
      expect(find.byType(SwitchListTile), findsNothing);
      expect(requests.map((request) => request.method), ['GET']);
    });
  }

  for (final key in checklist.keys) {
    for (final malformed in <Object?>['true', 1, null, [], {}]) {
      testWidgets('present non-boolean $key=$malformed cannot be submitted', (
        tester,
      ) async {
        responseChecklist = {...checklist, key: malformed};
        final expected = checklist.entries
            .map((entry) => entry.key != key && entry.value == true)
            .toList();
        final strings = await openChecklist(tester, expectedValues: expected);
        expect(find.text(strings.theatreChecklistReadOnly), findsOneWidget);
        expect(find.text(strings.theatreSubmitChecklist), findsNothing);
        expect(
          tester
              .widgetList<SwitchListTile>(find.byType(SwitchListTile))
              .every((tile) => tile.onChanged == null),
          isTrue,
        );
        expect(
          jsonDecode(
            tester.widget<SelectableText>(find.byType(SelectableText)).data!,
          ),
          responseChecklist,
        );
        await tester.ensureVisible(find.text(strings.actionClose));
        await tester.tap(find.text(strings.actionClose));
        await tester.pumpAndSettle();
        expect(requests.map((request) => request.method), ['GET']);
      });
    }
  }

  for (final locale in ['en', 'hi', 'ta', 'te', 'ml']) {
    test('read-only notice has explicit source copy for $locale', () {
      expect(
        AppStrings.forLocale(Locale(locale)).theatreChecklistReadOnly,
        'Read only: this checklist contains additional or unsupported data that this editor cannot safely update.',
      );
    });
  }

  testWidgets('missing checklist has no confirmed items', (tester) async {
    responseChecklist = null;
    await openChecklist(tester, expectedValues: [false, false, false, false]);
    expect(requests.map((request) => request.method), ['GET']);
  });

  testWidgets('malformed stored checklist shows a read error', (tester) async {
    responseChecklist = 'not a checklist';
    await tester.pumpWidget(
      MaterialApp(
        home: TheatreScreen(
          realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(ErrorState), findsOneWidget);
    expect(find.text('Appendectomy'), findsNothing);
    expect(find.byType(SwitchListTile), findsNothing);
    expect(requests.map((request) => request.method), ['GET']);
  });

  Future<AppStrings> openAvailability(
    WidgetTester tester,
    Map<String, dynamic> availability,
  ) async {
    String? scheduleDate;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        requests.add(request);
        expect(request.method, 'GET');
        expect(request.headers['authorization'], 'Bearer staff-access-token');
        expect(request.url.queryParameters.keys, ['date']);
        if (request.url.path.endsWith('/theatre/today')) {
          scheduleDate = request.url.queryParameters['date'];
          return http.Response(jsonEncode({'success': true, 'data': []}), 200);
        }
        expect(request.url.path, endsWith('/theatre/availability'));
        expect(request.url.queryParameters['date'], scheduleDate);
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'date': scheduleDate, ...availability},
          }),
          200,
        );
      }),
    );
    await tester.binding.setSurfaceSize(const Size(1000, 1200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: TheatreScreen(
          realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final strings = AppStrings.of(tester.element(find.byType(TheatreScreen)));
    await tester.tap(find.text(strings.theatreTabAvailability));
    await tester.pumpAndSettle();
    return strings;
  }

  testWidgets('availability renders canonical rooms and their date occupancy', (
    tester,
  ) async {
    final strings = await openAvailability(tester, {
      'booked_rooms': ['OT-1'],
      'room_schedules': [
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
      ],
    });
    for (final room in {
      'OT-1': strings.theatreOccupied,
      'OT-2': strings.theatreAvailable,
    }.entries) {
      final card = find.ancestor(
        of: find.text(room.key),
        matching: find.byType(Card),
      );
      expect(card, findsOneWidget);
      expect(
        find.descendant(of: card, matching: find.text(room.value)),
        findsOneWidget,
      );
    }
    expect(find.byType(EmptyState), findsNothing);
    expect(find.byType(ErrorState), findsNothing);
    expect(requests.map((request) => request.method), ['GET', 'GET']);
  });

  testWidgets('canonical availability overrides contradictory legacy status', (
    tester,
  ) async {
    final strings = await openAvailability(tester, {
      'booked_rooms': ['OT-1'],
      'room_schedules': [
        {'ot_room': 'OT-1', 'status': 'available'},
        {'ot_room': 'OT-2', 'status': 'occupied'},
      ],
    });
    for (final room in {
      'OT-1': strings.theatreOccupied,
      'OT-2': strings.theatreAvailable,
    }.entries) {
      final card = find.ancestor(
        of: find.text(room.key),
        matching: find.byType(Card),
      );
      expect(card, findsOneWidget);
      expect(
        find.descendant(of: card, matching: find.text(room.value)),
        findsOneWidget,
      );
    }
    expect(requests.map((request) => request.method), ['GET', 'GET']);
  });

  for (final malformed in [false, true]) {
    testWidgets(
      'availability distinguishes empty room summaries from malformed=$malformed',
      (tester) async {
        await openAvailability(tester, {
          if (!malformed) 'booked_rooms': [],
          'room_schedules': [],
        });
        expect(
          find.byType(ErrorState),
          malformed ? findsOneWidget : findsNothing,
        );
        expect(
          find.byType(EmptyState),
          malformed ? findsNothing : findsOneWidget,
        );
        expect(requests.map((request) => request.method), ['GET', 'GET']);
      },
    );
  }

  for (final malformed in [false, true]) {
    testWidgets(
      'default adapter distinguishes empty schedule from malformed=$malformed',
      (tester) async {
        VHHttpClient.setClientForTesting(
          MockClient((request) async {
            expect(request.method, 'GET');
            expect(request.url.path, endsWith('/theatre/today'));
            return http.Response(
              jsonEncode({
                'success': true,
                'data': malformed ? <String, dynamic>{} : <dynamic>[],
              }),
              200,
            );
          }),
        );
        await tester.pumpWidget(
          MaterialApp(
            home: TheatreScreen(
              realtimeEvents: (_) => const Stream<RealtimeEvent>.empty(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byType(ErrorState),
          malformed ? findsOneWidget : findsNothing,
        );
        expect(
          find.byType(EmptyState),
          malformed ? findsNothing : findsOneWidget,
        );
      },
    );
  }
}
