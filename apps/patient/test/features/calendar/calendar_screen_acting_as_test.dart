// Calendar appointment feed under acting-as (P4, 2026-08-18), and the
// cache-first read that keeps the month populated without a connection.
//
// The calendar used to key /appointments/patient/:id off the GUARDIAN's
// stored user_id even while a dependent profile was active — the backend
// 403'd the mismatched identity and the calendar silently showed no
// appointments. It must thread the ACTIVE dependent's id, exactly like
// appointments_list_tab does.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/services/patient_session_authority.dart';
import 'package:vhhealth/features/appointments/services/appointment_feed_repository.dart';
import 'package:vhhealth/features/calendar/screens/calendar_screen.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

import '../../support/appointment_feed_test_repositories.dart';
import '../../support/patient_session_test_authority.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late PatientOutageController outage;

  setUp(() {
    _installSecureStorageFake();
    _installPermissionGrantedFake();
    installCurrentPatientSessionAuthority();
    outage = PatientOutageController.forTesting(
      request: () => throw StateError('readiness network must not be needed'),
      authentication: () async => 'patient-session',
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
    )..markAvailableForTesting();
    PatientOutageController.setForTesting(outage);
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    PatientOutageController.resetAfterTesting();
    PatientSessionAuthority.resetAfterTesting();
    outage.dispose();
  });

  testWidgets('keys the appointment feed off the active dependent', (
    tester,
  ) async {
    final requestedPaths = <String>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        requestedPaths.add(request.url.path);
        return http.Response('{"success":true,"data":[]}', 200);
      }),
    );

    final feed = CachedAppointmentFeedRepository();
    await tester.pumpWidget(
      _Harness(
        dependents: _FakeDependentsProvider(
          const Dependent(
            id: 55,
            uid: 'dep-uid-55',
            name: 'Anu',
            isMinor: true,
          ),
        ),
        child: CalendarScreen(feedRepository: feed),
      ),
    );
    await tester.pumpAndSettle();

    // The appointment leg now goes through the cache-first repository, so the
    // id it is keyed on is asserted there rather than on the wire; the other
    // two legs still derive the patient from the JWT.
    expect(feed.fetchedFor, ['55']);
    expect(appointmentFeedPath('55'), '/appointments/patient/55');
    expect(
      requestedPaths.where((p) => p.contains('/appointments/patient/')),
      isEmpty,
    );
  });

  testWidgets(
    'keys the appointment feed off the guardian when on own profile',
    (tester) async {
      final requestedPaths = <String>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          requestedPaths.add(request.url.path);
          return http.Response('{"success":true,"data":[]}', 200);
        }),
      );

      final feed = CachedAppointmentFeedRepository();
      await tester.pumpWidget(
        _Harness(
          dependents: _FakeDependentsProvider(null),
          child: CalendarScreen(feedRepository: feed),
        ),
      );
      await tester.pumpAndSettle();

      expect(feed.fetchedFor, ['guardian-7']);
      expect(
        requestedPaths.where((p) => p.contains('/appointments/patient/')),
        isEmpty,
      );
    },
  );

  testWidgets('a cached appointment feed still populates the month', (
    tester,
  ) async {
    // The two live legs return nothing; the appointment leg comes back from
    // the cache with an as-of time. Before this lane all three legs used the
    // plain client, so a calendar opened without a connection rendered an
    // empty month over appointments already on disk.
    VHHttpClient.setClientForTesting(
      MockClient((request) async => http.Response('{"data":[]}', 200)),
    );
    final today = DateTime.now();
    final date =
        '${today.year.toString().padLeft(4, '0')}-'
        '${today.month.toString().padLeft(2, '0')}-'
        '${today.day.toString().padLeft(2, '0')}';

    await tester.pumpWidget(
      _Harness(
        dependents: _FakeDependentsProvider(null),
        child: CalendarScreen(
          feedRepository: CachedAppointmentFeedRepository(
            cachedAtValue: DateTime.now().subtract(const Duration(hours: 3)),
            staleLabel: '3 hours ago',
            rows: [
              {
                'id': 9001,
                'department_name': 'Cardiology',
                'appointment_date': date,
              },
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // The cached appointment is on the calendar...
    expect(find.text('Cardiology'), findsWidgets);
    // ...and the month says how old the copy is rather than reading as live.
    expect(find.textContaining('Saved on this device'), findsOneWidget);
  });

  test('the default repository is the caching one', () {
    expect(
      const CalendarScreen().feedRepository,
      isA<ApiAppointmentFeedRepository>(),
    );
  });
}

/// Roster provider with a pinned active profile — the real provider only
/// activates dependents present in its backend-loaded list.
class _FakeDependentsProvider extends DependentsProvider {
  _FakeDependentsProvider(this._dep);

  final Dependent? _dep;

  @override
  Dependent? get activeDependent => _dep;

  @override
  bool get isViewingDependent => _dep != null;
}

class _Harness extends StatelessWidget {
  const _Harness({required this.dependents, required this.child});

  final DependentsProvider dependents;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<DependentsProvider>.value(
      value: dependents,
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: child,
      ),
    );
  }
}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{'user_id': 'guardian-7'};

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

/// permission_handler fake: every permission reports granted so the screen
/// goes straight to loading its feeds.
void _installPermissionGrantedFake() {
  const channel = MethodChannel('flutter.baseflow.com/permissions/methods');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        switch (call.method) {
          case 'checkPermissionStatus':
            return 1; // PermissionStatus.granted
          case 'requestPermissions':
            final permissions = (call.arguments as List).cast<int>();
            return {for (final p in permissions) p: 1};
          default:
            return null;
        }
      });
}
