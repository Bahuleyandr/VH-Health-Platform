import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/core/services/stemi_pathway_api_service.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_readiness_models.dart';
import 'package:vhhealth_staff/features/cath_lab/screens/cath_lab_screen.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_readiness_checklist.dart';
import 'package:vhhealth_staff/features/emergency/screens/ambulance_tracking_screen.dart';
import 'package:vhhealth_staff/features/emergency/screens/ed_trauma_workbench_screen.dart';
import 'package:vhhealth_staff/features/emr/screens/patient_command_board_screen.dart';
import 'package:vhhealth_staff/features/investigations/screens/lab_bookings_screen.dart';
import 'package:vhhealth_staff/features/theatre/screens/theatre_screen.dart';

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(
          call.arguments as Map? ?? const {},
        );
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key'] as String] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
}

RealtimeEvent _event(String channel, String type) {
  return RealtimeEvent(
    channel: channel,
    data: <String, dynamic>{'type': type},
    at: DateTime(2026, 7, 4),
  );
}

Future<void> _pumpTheatre(WidgetTester tester, TheatreScreen screen) async {
  await tester.pumpWidget(MaterialApp(home: screen));
  await tester.pumpAndSettle();
}

Future<void> _pumpLabBookings(
  WidgetTester tester,
  LabBookingsScreen screen,
) async {
  SharedPreferences.setMockInitialValues({});
  await tester.pumpWidget(
    ChangeNotifierProvider(
      create: (_) => ThemeProvider(),
      child: MaterialApp(home: screen),
    ),
  );
  await tester.pumpAndSettle();
}

/// The readiness checklist loads on mount; these tests are about the
/// worklist and its tabs, so they hand it an empty case payload rather
/// than letting it reach for the network.
final _noReadiness = CathReadinessDependencies(
  loadReadiness: (_) async =>
      CathCaseReadiness.fromJson(const <String, dynamic>{}),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    _installSecureStorageFake();
  });

  tearDown(() async {
    const channel = MethodChannel(
      'plugins.it_nomads.com/flutter_secure_storage',
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    await RealtimeClient.instance.disconnect();
  });

  testWidgets(
    'theatre board subscribes to staff:or-board and debounces nudges',
    (tester) async {
      var channelName = '';
      var cancelled = false;
      var loads = 0;
      final controller = StreamController<RealtimeEvent>.broadcast(
        onCancel: () => cancelled = true,
      );
      addTearDown(controller.close);

      await _pumpTheatre(
        tester,
        TheatreScreen(
          loadSchedule: ({required String date}) async {
            loads += 1;
            return <Map<String, dynamic>>[];
          },
          loadAvailability: (_) async => <Map<String, dynamic>>[],
          realtimeEvents: (channel) {
            channelName = channel;
            return controller.stream;
          },
        ),
      );

      expect(channelName, 'staff:or-board');
      expect(loads, 1);

      controller.add(_event('staff:or-board', 'scheduled'));
      controller.add(_event('staff:or-board', 'status-changed'));
      await tester.pump(const Duration(milliseconds: 399));
      expect(loads, 1);

      await tester.pump(const Duration(milliseconds: 2));
      await tester.pumpAndSettle();
      expect(loads, 2);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      expect(cancelled, isTrue);

      controller.add(_event('staff:or-board', 'cancelled'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(loads, 2);
    },
  );

  testWidgets(
    'theatre background refresh retains data on failure and clears the error on recovery',
    (tester) async {
      var loads = 0;
      final controller = StreamController<RealtimeEvent>.broadcast();
      addTearDown(controller.close);

      await _pumpTheatre(
        tester,
        TheatreScreen(
          loadSchedule: ({required String date}) async {
            loads += 1;
            if (loads == 2) throw Exception('transient theatre outage');
            return <Map<String, dynamic>>[
              {
                'id': loads,
                'procedure_name': loads == 1
                    ? 'Retained theatre case'
                    : 'Recovered theatre case',
                'status': 'scheduled',
              },
            ];
          },
          loadAvailability: (_) async => <Map<String, dynamic>>[],
          realtimeEvents: (_) => controller.stream,
        ),
      );

      expect(find.text('Retained theatre case'), findsOneWidget);
      controller.add(_event('staff:or-board', 'status-changed'));
      await tester.pump(const Duration(milliseconds: 401));
      await tester.pump();
      expect(find.text('Retained theatre case'), findsOneWidget);
      expect(find.textContaining('transient theatre outage'), findsNothing);

      controller.add(_event('staff:or-board', 'status-changed'));
      await tester.pump(const Duration(milliseconds: 401));
      await tester.pumpAndSettle();
      expect(find.text('Recovered theatre case'), findsOneWidget);
    },
  );

  testWidgets('lab bookings subscribes to staff:lab and debounces nudges', (
    tester,
  ) async {
    var channelName = '';
    var cancelled = false;
    var loads = 0;
    final controller = StreamController<RealtimeEvent>.broadcast(
      onCancel: () => cancelled = true,
    );
    addTearDown(controller.close);

    await _pumpLabBookings(
      tester,
      LabBookingsScreen(
        loadBookings: () async {
          loads += 1;
          return <String, dynamic>{'data': <Map<String, dynamic>>[]};
        },
        realtimeEvents: (channel) {
          channelName = channel;
          return controller.stream;
        },
      ),
    );

    expect(channelName, 'staff:lab');
    expect(loads, 1);

    controller.add(_event('staff:lab', 'result-pending'));
    controller.add(_event('staff:lab', 'alert-fired'));
    await tester.pump(const Duration(milliseconds: 399));
    expect(loads, 1);

    await tester.pump(const Duration(milliseconds: 2));
    await tester.pumpAndSettle();
    expect(loads, 2);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    expect(cancelled, isTrue);

    controller.add(_event('staff:lab', 'result-signed'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(loads, 2);
  });

  testWidgets('lab background refresh retains the last-known booking', (
    tester,
  ) async {
    var loads = 0;
    final controller = StreamController<RealtimeEvent>.broadcast();
    addTearDown(controller.close);

    await _pumpLabBookings(
      tester,
      LabBookingsScreen(
        loadBookings: () async {
          loads += 1;
          if (loads == 2) throw Exception('transient lab outage');
          return <String, dynamic>{
            'data': <Map<String, dynamic>>[
              {
                'id': 91,
                'status': 'BOOKED',
                'patient_name': 'Retained Lab Patient',
                'test_names': <String>['CBC'],
              },
            ],
          };
        },
        realtimeEvents: (_) => controller.stream,
      ),
    );

    expect(find.text('Retained Lab Patient'), findsOneWidget);
    controller.add(_event('staff:lab', 'result-pending'));
    await tester.pump(const Duration(milliseconds: 401));
    await tester.pump();
    expect(find.text('Retained Lab Patient'), findsOneWidget);
    expect(find.textContaining('transient lab outage'), findsNothing);
  });

  testWidgets(
    'Cath board subscribes to staff:code-stemi and debounces durable reloads',
    (tester) async {
      var channelName = '';
      var cancelled = false;
      var loads = 0;
      final controller = StreamController<RealtimeEvent>.broadcast(
        onCancel: () => cancelled = true,
      );
      addTearDown(controller.close);

      await tester.pumpWidget(
        MaterialApp(
          home: CathLabScreen(
            readinessDependencies: _noReadiness,
            currentStaffUid: 'staff-1',
            loadCases: (_) async => const [],
            loadStemiActivations: () async {
              loads += 1;
              return const <StemiActivationSummary>[];
            },
            realtimeEvents: (channel) {
              channelName = channel;
              return controller.stream;
            },
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(channelName, 'staff:code-stemi');
      expect(loads, 1);

      controller.add(_event('staff:code-stemi', 'activated'));
      controller.add(_event('staff:code-stemi', 'team-notified'));
      await tester.pump(const Duration(milliseconds: 399));
      expect(loads, 1);

      await tester.pump(const Duration(milliseconds: 2));
      await tester.pump();
      expect(loads, 2);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      expect(cancelled, isTrue);

      controller.add(_event('staff:code-stemi', 'acknowledged'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(loads, 2);
    },
  );

  testWidgets(
    'ED trauma workbench subscribes to staff:ed-board, debounces, and '
    'cancels on dispose',
    (tester) async {
      var channelName = '';
      var cancelled = false;
      var handoffLoads = 0;
      final controller = StreamController<RealtimeEvent>.broadcast(
        onCancel: () => cancelled = true,
      );
      addTearDown(controller.close);

      await tester.pumpWidget(
        MaterialApp(
          home: EdTraumaWorkbenchScreen(
            loadPolicy: () async => const {
              'active': true,
              'canonical_triage_scale': 'esi',
            },
            loadDestinationHandoffs: () async {
              handoffLoads += 1;
              return const <Map<String, dynamic>>[];
            },
            realtimeEvents: (channel) {
              channelName = channel;
              return controller.stream;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(channelName, edBoardRealtimeChannel);
      expect(handoffLoads, 1);

      controller.add(_event(edBoardRealtimeChannel, 'arrival'));
      controller.add(_event(edBoardRealtimeChannel, 'transition'));
      await tester.pump(const Duration(milliseconds: 399));
      expect(handoffLoads, 1);

      await tester.pump(const Duration(milliseconds: 2));
      await tester.pumpAndSettle();
      expect(handoffLoads, 2);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      expect(cancelled, isTrue);

      controller.add(_event(edBoardRealtimeChannel, 'priority'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(handoffLoads, 2);
    },
  );

  testWidgets(
    'ambulance tracking refreshes from staff:ambulance-tracking and keeps a '
    'full-rate backstop poll for crews the channel never covers',
    (tester) async {
      var channelName = '';
      var cancelled = false;
      var loads = 0;
      final controller = StreamController<RealtimeEvent>.broadcast(
        onCancel: () => cancelled = true,
      );
      addTearDown(controller.close);

      await tester.pumpWidget(
        MaterialApp(
          home: AmbulanceTrackingScreen(
            pollInterval: const Duration(seconds: 30),
            loadActive: () async {
              loads += 1;
              return const {'enabled': true, 'count': 0, 'requests': []};
            },
            realtimeEvents: (channel) {
              channelName = channel;
              return controller.stream;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(channelName, ambulanceTrackingRealtimeChannel);
      expect(loads, 1);

      controller.add(_event(ambulanceTrackingRealtimeChannel, 'position'));
      controller.add(_event(ambulanceTrackingRealtimeChannel, 'position'));
      await tester.pump(const Duration(milliseconds: 399));
      expect(loads, 1);

      await tester.pump(const Duration(milliseconds: 2));
      await tester.pumpAndSettle();
      expect(loads, 2);

      // The tick a position fix already covered is dropped - the socket
      // accelerates this list, it does not get to fetch it twice.
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(loads, 2);

      // With no fixes on the channel - the crew that never shares GPS, or a
      // dead subscription - every tick refreshes, so the backstop rate is the
      // one the screen had before the channel existed. The channel carries
      // position fixes only, so a request that leaves active transport is
      // never announced and only this poll takes it off the list.
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(loads, 3);
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(loads, 4);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      expect(cancelled, isTrue);

      controller.add(_event(ambulanceTrackingRealtimeChannel, 'position'));
      await tester.pump(const Duration(seconds: 60));
      expect(loads, 4);
    },
  );

  testWidgets(
    'patient command board subscribes to staff:icu-board, refreshes in the '
    'background, and cancels on dispose',
    (tester) async {
      var channelName = '';
      var cancelled = false;
      var loads = 0;
      var lastLimit = 0;
      final controller = StreamController<RealtimeEvent>.broadcast(
        onCancel: () => cancelled = true,
      );
      addTearDown(controller.close);

      await tester.pumpWidget(
        MaterialApp(
          home: PatientCommandBoardScreen(
            loadBoard:
                ({
                  String? ward,
                  String? patientUid,
                  int? admissionId,
                  required int limit,
                  required int offset,
                }) async {
                  loads += 1;
                  lastLimit = limit;
                  return <String, dynamic>{
                    'rows': <Map<String, dynamic>>[],
                    'board': <String, dynamic>{
                      'counts': {'total': 0, 'loaded': 0, 'has_more': false},
                    },
                  };
                },
            realtimeEvents: (channel) {
              channelName = channel;
              return controller.stream;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(channelName, patientCommandBoardRealtimeChannel);
      expect(loads, 1);

      controller.add(_event(patientCommandBoardRealtimeChannel, 'admitted'));
      controller.add(_event(patientCommandBoardRealtimeChannel, 'flowsheet'));
      await tester.pump(const Duration(milliseconds: 399));
      expect(loads, 1);

      await tester.pump(const Duration(milliseconds: 2));
      await tester.pumpAndSettle();
      expect(loads, 2);
      expect(lastLimit, 50);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      expect(cancelled, isTrue);

      controller.add(_event(patientCommandBoardRealtimeChannel, 'discharged'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(loads, 2);
    },
  );

  testWidgets(
    'patient command board nudge keeps rows paged in past one backend page',
    (tester) async {
      // Tall surface so every row card and the load-more button lay out
      // without scrolling; the board renders one non-lazy ListView.
      tester.view.physicalSize = const Size(1400, 90000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      var boardTotal = 260;
      final requests = <List<int>>[];
      final controller = StreamController<RealtimeEvent>.broadcast();
      addTearDown(controller.close);

      await tester.pumpWidget(
        MaterialApp(
          home: PatientCommandBoardScreen(
            loadBoard:
                ({
                  String? ward,
                  String? patientUid,
                  int? admissionId,
                  required int limit,
                  required int offset,
                }) async {
                  requests.add(<int>[limit, offset]);
                  final end = offset + limit > boardTotal
                      ? boardTotal
                      : offset + limit;
                  final page = <Map<String, dynamic>>[
                    for (var id = offset + 1; id <= end; id++)
                      <String, dynamic>{
                        'admission_id': id,
                        'patient': <String, dynamic>{'name': 'Patient $id'},
                      },
                  ];
                  return <String, dynamic>{
                    'rows': page,
                    'board': <String, dynamic>{
                      'counts': {
                        'total': boardTotal,
                        'returned': page.length,
                        'loaded': offset + page.length,
                        'has_more': offset + page.length < boardTotal,
                      },
                    },
                  };
                },
            realtimeEvents: (_) => controller.stream,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // 50 rows on open plus four pages of "load more" = 250 rows held, past
      // the backend's 200-row-per-request cap.
      for (var page = 0; page < 4; page++) {
        await tester.tap(
          find.byKey(const ValueKey('patient-command-board-load-more')),
        );
        await tester.pumpAndSettle();
      }
      expect(
        find.textContaining('Showing first 250 of 260 patients'),
        findsOneWidget,
      );

      requests.clear();
      controller.add(_event(patientCommandBoardRealtimeChannel, 'flowsheet'));
      await tester.pump(const Duration(milliseconds: 401));
      await tester.pumpAndSettle();

      // The nudge re-reads every page the clinician holds — one request per
      // 200-row backend page — instead of truncating the board to the first.
      expect(requests, <List<int>>[
        <int>[200, 0],
        <int>[50, 200],
      ]);
      expect(
        find.textContaining('Showing first 250 of 260 patients'),
        findsOneWidget,
      );
      expect(find.textContaining('Patient 250'), findsOneWidget);

      // A board that shrank below the held depth still collapses: rows the
      // re-read no longer returns are gone, not resurrected from the old list.
      boardTotal = 120;
      requests.clear();
      controller.add(_event(patientCommandBoardRealtimeChannel, 'discharged'));
      await tester.pump(const Duration(milliseconds: 401));
      await tester.pumpAndSettle();

      expect(requests, <List<int>>[
        <int>[200, 0],
      ]);
      expect(
        find.textContaining('Showing 120 of 120 patients'),
        findsOneWidget,
      );
      expect(find.textContaining('Patient 250'), findsNothing);
    },
  );

  testWidgets(
    'patient command board clears a stale error when an ICU nudge recovers',
    (tester) async {
      var loads = 0;
      final controller = StreamController<RealtimeEvent>.broadcast();
      addTearDown(controller.close);

      await tester.pumpWidget(
        MaterialApp(
          home: PatientCommandBoardScreen(
            loadBoard:
                ({
                  String? ward,
                  String? patientUid,
                  int? admissionId,
                  required int limit,
                  required int offset,
                }) async {
                  loads += 1;
                  if (loads == 1) throw Exception('transient ICU outage');
                  return <String, dynamic>{
                    'rows': <Map<String, dynamic>>[],
                    'board': <String, dynamic>{
                      'counts': {'total': 0, 'loaded': 0, 'has_more': false},
                    },
                  };
                },
            realtimeEvents: (_) => controller.stream,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('transient ICU outage'), findsOneWidget);

      controller.add(_event(patientCommandBoardRealtimeChannel, 'admitted'));
      await tester.pump(const Duration(milliseconds: 401));
      await tester.pumpAndSettle();

      expect(loads, 2);
      expect(find.textContaining('transient ICU outage'), findsNothing);
    },
  );
}
