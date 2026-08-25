// "My Appointments" reads the SAME `/appointments/patient/:id` cache entry the
// dashboard writes. It used to read it with the plain client, so the dashboard
// listed the patient's appointments offline while this screen — the one they
// open to see them — showed a load error over data already on the device. The
// last test here is that defect, pinned.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth/core/services/patient_session_authority.dart';
import 'package:vhhealth/features/appointments/services/appointment_feed_repository.dart';
import 'package:vhhealth/features/appointments/widgets/appointments_list_tab.dart';
import 'package:vhhealth/features/dashboard/providers/dashboard_provider.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

import '../../support/appointment_feed_test_repositories.dart';
import '../../support/patient_session_test_authority.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late PatientOutageController outage;

  setUp(() {
    _installSecureStorageFake();
    installCurrentPatientSessionAuthority();
    outage = _availableController();
    PatientOutageController.setForTesting(outage);
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    PatientOutageController.resetAfterTesting();
    PatientSessionAuthority.resetAfterTesting();
    outage.dispose();
  });

  testWidgets('shows localized empty state with booking action', (
    tester,
  ) async {
    var bookTapped = false;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/appointments/patient/patient-1'));
        return http.Response('{"data":{"appointments":[]}}', 200);
      }),
    );

    await tester.pumpWidget(
      _Harness(
        child: AppointmentsListTab(
          onBookOne: () => bookTapped = true,
          feedRepository: const LiveOnlyAppointmentFeedRepository(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No appointments yet'), findsOneWidget);
    expect(find.textContaining('Book a visit'), findsOneWidget);

    await tester.tap(find.text('Book one now'));
    await tester.pump();
    expect(bookTapped, isTrue);
  });

  testWidgets('shows retryable localized error state when load fails', (
    tester,
  ) async {
    var calls = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        calls += 1;
        return http.Response('{"message":"Backend unavailable"}', 400);
      }),
    );

    await tester.pumpWidget(
      _Harness(
        child: AppointmentsListTab(
          onBookOne: () {},
          feedRepository: const LiveOnlyAppointmentFeedRepository(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('Something went wrong. Please try again.'),
      findsOneWidget,
    );
    expect(find.text('Backend unavailable'), findsOneWidget);

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(calls, 2);
  });

  testWidgets('shows reschedule action for an upcoming scheduled appointment', (
    tester,
  ) async {
    final future = DateTime.now().add(const Duration(days: 7));
    final date =
        '${future.year.toString().padLeft(4, '0')}-'
        '${future.month.toString().padLeft(2, '0')}-'
        '${future.day.toString().padLeft(2, '0')}';
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/appointments/patient/patient-1'));
        return http.Response(
          '{"data":{"appointments":[{"id":101,"doctor_name":"Dr. Meera","department":"Cardiology","appointment_date":"$date","appointment_time":"10:30","status":"SCHEDULED","reason":"Follow-up"}]}}',
          200,
        );
      }),
    );

    await tester.pumpWidget(
      _Harness(
        child: AppointmentsListTab(
          onBookOne: () {},
          feedRepository: const LiveOnlyAppointmentFeedRepository(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Dr. Meera'), findsOneWidget);
    expect(find.text('Reschedule'), findsOneWidget);

    await tester.tap(find.text('Reschedule'));
    await tester.pumpAndSettle();
    expect(find.text('Choose a new slot'), findsOneWidget);
  });

  group('production wiring (the tests above inject a repository)', () {
    test('reads the byte-identical path the dashboard caches', () {
      // The cache key IS the path. If these two spellings ever drift the
      // screens stop sharing an entry and this one silently loses its offline
      // copy again.
      expect(
        appointmentFeedPath('patient-1'),
        DashboardProvider.debugAppointmentPath('patient-1'),
      );
    });

    test('the default repository is the caching one', () {
      const widget = AppointmentsListTab(onBookOne: _noop);
      expect(widget.feedRepository, isA<ApiAppointmentFeedRepository>());

      // ...and that repository reads through the CACHING client. Injection in
      // the tests above must not be able to hide a regression to plain get().
      final source = File(
        'lib/features/appointments/services/appointment_feed_repository.dart',
      ).readAsStringSync();
      expect(
        source.contains('ApiClient.cachedGet(appointmentFeedPath(patientId))'),
        isTrue,
      );
      expect(
        RegExp(r'ApiClient\.get\(').hasMatch(source),
        isFalse,
        reason: 'the plain client is what made this screen fail offline',
      );
    });

    test('the screen no longer reads the feed with the plain client', () {
      final source = File(
        'lib/features/appointments/widgets/appointments_list_tab.dart',
      ).readAsStringSync();
      expect(source.contains("ApiClient.get('/appointments/patient/"), isFalse);
      expect(source.contains('widget.feedRepository'), isTrue);
    });
  });

  testWidgets('renders a cached list, labelled with its as-of time', (
    tester,
  ) async {
    // What the caching client hands back when the hospital is unreachable:
    // the dashboard's on-disk copy of this exact feed, plus its age. (That
    // ApiClient.cachedGet serves the cache during an outage is pinned in
    // test/core/outage/api_client_outage_test.dart; that THIS screen goes
    // through it is pinned by the production-wiring group above.)
    final future = DateTime.now().add(const Duration(days: 3));
    final date =
        '${future.year.toString().padLeft(4, '0')}-'
        '${future.month.toString().padLeft(2, '0')}-'
        '${future.day.toString().padLeft(2, '0')}';
    final repository = CachedAppointmentFeedRepository(
      cachedAtValue: DateTime.now().subtract(const Duration(hours: 2)),
      staleLabel: '2 hours ago',
      rows: [
        {
          'id': 501,
          'doctor_name': 'Dr. Cached',
          'department': 'Cardiology',
          'appointment_date': date,
          'appointment_time': '11:00',
          'status': 'SCHEDULED',
        },
      ],
    );

    // A throwing-ish client: nothing on this path may need the network.
    VHHttpClient.setClientForTesting(
      MockClient((request) async => http.Response('{}', 503)),
    );

    await tester.pumpWidget(
      _Harness(
        child: AppointmentsListTab(
          onBookOne: () {},
          feedRepository: repository,
        ),
      ),
    );
    await tester.pumpAndSettle();

    // The appointment the patient opened the screen to see — not an error page
    // rendered over data already on the device.
    expect(find.text('Dr. Cached'), findsOneWidget);
    expect(find.text('Something went wrong. Please try again.'), findsNothing);

    // ...and it does not read as live: the OfflineBanner states when this copy
    // was saved, the same treatment the dashboard gives the same feed.
    expect(find.textContaining('Saved on this device'), findsOneWidget);
    expect(repository.fetchedFor, ['patient-1']);
  });
}

void _noop() {}

PatientOutageController _availableController() =>
    PatientOutageController.forTesting(
      request: () => throw StateError('readiness network must not be needed'),
      authentication: () async => 'patient-session',
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
    )..markAvailableForTesting();

class _Harness extends StatelessWidget {
  const _Harness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => WebSocketProvider()),
        // The list tab reads the acting-as roster to label / scope a
        // dependent profile's appointments.
        ChangeNotifierProvider(create: (_) => DependentsProvider()),
      ],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(body: child),
      ),
    );
  }
}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{'user_id': 'patient-1'};

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
