import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/outage/patient_readiness.dart';
import 'package:vhhealth/features/medications/screens/medication_reminders_screen.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late PatientOutageController outageController;

  setUp(() async {
    _installSecureStorageFake();
    // ApiClient gates live reads behind the patient readiness controller;
    // give the tests an `available` controller so screen loads reach the
    // mocked HTTP client instead of being answered by the outage gate.
    outageController = await _availableOutageController();
    PatientOutageController.setForTesting(outageController);
  });

  tearDown(() {
    PatientOutageController.resetAfterTesting();
    outageController.dispose();
    VHHttpClient.resetClientForTesting();
  });

  const remindersJson =
      '{"data":['
      '{"id":1,"medication_name":"Amoxicillin","dosage":"500mg",'
      '"frequency":"twice_daily","reminder_times":["09:00","21:00"],'
      '"start_date":"2026-08-15","end_date":"2026-08-22","is_active":true,'
      '"source":"medication_reminder"},'
      '{"id":2,"medication_name":"Metformin","dosage":"850mg",'
      '"frequency":"once_daily","reminder_times":["08:00"],'
      '"start_date":"2026-08-01","is_active":false,'
      '"source":"medication_reminder"},'
      '{"id":1000000042,"medication_name":"Iron (100mg)","dosage":"100mg",'
      '"frequency":"once_daily","reminder_times":["09:00"],'
      '"start_date":"2026-08-01","is_active":true,'
      '"source":"anc_supplement"}'
      ']}';

  testWidgets('lists inactive reminders dimmed with a Paused chip and an '
      'off switch', (tester) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/reminders/medication'));
        expect(request.url.queryParameters['include_inactive'], 'true');
        return http.Response(remindersJson, 200);
      }),
    );
    final notifications = _RecordingNotifications();

    await tester.pumpWidget(_harness(notifications));
    await tester.pumpAndSettle();

    expect(find.text('Amoxicillin'), findsOneWidget);
    expect(find.text('Metformin'), findsOneWidget);
    expect(find.text('Paused'), findsOneWidget);

    // ANC rows are read-only — only the two patient-owned rows get a
    // switch, and the paused row's switch is off.
    final switches = tester.widgetList<Switch>(find.byType(Switch)).toList();
    expect(switches, hasLength(2));
    expect(switches[0].value, isTrue);
    expect(switches[1].value, isFalse);

    // The load resynced local notifications with the full roster.
    expect(notifications.resyncs, hasLength(1));
    expect(notifications.resyncs.single.map((r) => r['id']).toList(), [
      1,
      2,
      1000000042,
    ]);
  });

  testWidgets('toggling an active reminder off PUTs is_active:false and '
      'cancels its local notifications', (tester) async {
    final putBodies = <Map<String, dynamic>>[];
    var putPath = '';
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        if (request.method == 'PUT') {
          putPath = request.url.path;
          putBodies.add(jsonDecode(request.body) as Map<String, dynamic>);
          return http.Response('{"data":{"id":1,"is_active":false}}', 200);
        }
        return http.Response(remindersJson, 200);
      }),
    );
    final notifications = _RecordingNotifications();

    await tester.pumpWidget(_harness(notifications));
    await tester.pumpAndSettle();

    await tester.tap(find.byType(Switch).first);
    await tester.pumpAndSettle();

    expect(putPath, endsWith('/reminders/medication/1'));
    expect(putBodies, [
      {'is_active': false},
    ]);
    expect(notifications.cancelled, [1]);
  });

  testWidgets('toggling a paused reminder back on PUTs is_active:true '
      'without cancelling notifications', (tester) async {
    final putBodies = <Map<String, dynamic>>[];
    var putPath = '';
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        if (request.method == 'PUT') {
          putPath = request.url.path;
          putBodies.add(jsonDecode(request.body) as Map<String, dynamic>);
          return http.Response('{"data":{"id":2,"is_active":true}}', 200);
        }
        return http.Response(remindersJson, 200);
      }),
    );
    final notifications = _RecordingNotifications();

    await tester.pumpWidget(_harness(notifications));
    await tester.pumpAndSettle();

    await tester.tap(find.byType(Switch).at(1));
    await tester.pumpAndSettle();

    expect(putPath, endsWith('/reminders/medication/2'));
    expect(putBodies, [
      {'is_active': true},
    ]);
    expect(notifications.cancelled, isEmpty);
    // Reload after the toggle resyncs the local schedule.
    expect(notifications.resyncs.length, greaterThanOrEqualTo(2));
  });

  testWidgets('a failed toggle surfaces the backend message in a snackbar', (
    tester,
  ) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        if (request.method == 'PUT') {
          return http.Response('{"message":"Reminder update rejected"}', 403);
        }
        return http.Response(remindersJson, 200);
      }),
    );
    final notifications = _RecordingNotifications();

    await tester.pumpWidget(_harness(notifications));
    await tester.pumpAndSettle();

    await tester.tap(find.byType(Switch).first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.textContaining('Reminder update rejected'), findsOneWidget);
    expect(notifications.cancelled, isEmpty);
  });

  testWidgets('a failed delete surfaces an error snackbar', (tester) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        if (request.method == 'DELETE') {
          return http.Response('{"message":"Delete rejected"}', 403);
        }
        return http.Response(remindersJson, 200);
      }),
    );
    final notifications = _RecordingNotifications();

    await tester.pumpWidget(_harness(notifications));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Delete reminder').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.textContaining('Delete rejected'), findsOneWidget);
    expect(notifications.cancelled, isEmpty);
  });
}

Widget _harness(MedicationReminderNotifications notifications) {
  return MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: MedicationRemindersScreen(notifications: notifications),
  );
}

class _RecordingNotifications implements MedicationReminderNotifications {
  final List<List<Map<String, dynamic>>> resyncs = [];
  final List<int> cancelled = [];

  @override
  Future<void> resync(List<Map<String, dynamic>> reminders) async {
    resyncs.add(reminders);
  }

  @override
  Future<void> cancelReminder(int id) async {
    cancelled.add(id);
  }
}

Future<PatientOutageController> _availableOutageController() async {
  final now = DateTime.utc(2026, 8, 18, 12);
  final controller = PatientOutageController.forTesting(
    request: () async => ApiResponse(
      statusCode: 200,
      isSuccess: true,
      data: <String, dynamic>{
        'readinessContractVersion': PatientReadinessConfig.contractVersion,
        'readinessPurpose': PatientReadinessConfig.purpose,
        'ready': true,
        'endpointId': PatientReadinessConfig.endpointId,
        'routeKind': 'public',
        'tenantId': 'tenant-a',
        'database': 'ready',
        'serverTime': now.toIso8601String(),
      },
    ),
    authentication: () async => 'test-jwt',
    tenantId: () async => 'tenant-a',
    maxClockSkew: const Duration(seconds: 5),
    clock: () => now,
    delay: (_) async {},
    confirmSession: (_, _, _) async => true,
  );
  await controller.probeNow();
  return controller;
}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{'jwt': 'test-jwt', 'user_id': 'patient-1'};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key']] = args['value'] as String;
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
