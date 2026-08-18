// Calendar appointment feed under acting-as (P4, 2026-08-18).
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
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/features/calendar/screens/calendar_screen.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    _installSecureStorageFake();
    _installPermissionGrantedFake();
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
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
        child: const CalendarScreen(),
      ),
    );
    await tester.pumpAndSettle();

    expect(requestedPaths.where((p) => p.contains('/appointments/patient/')), [
      '/api/v1/appointments/patient/55',
    ]);
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

      await tester.pumpWidget(
        _Harness(
          dependents: _FakeDependentsProvider(null),
          child: const CalendarScreen(),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        requestedPaths.where((p) => p.contains('/appointments/patient/')),
        ['/api/v1/appointments/patient/guardian-7'],
      );
    },
  );
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
