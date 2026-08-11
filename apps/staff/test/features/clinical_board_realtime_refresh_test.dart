import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/core/services/stemi_pathway_api_service.dart';
import 'package:vhhealth_staff/features/cath_lab/screens/cath_lab_screen.dart';
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
}
