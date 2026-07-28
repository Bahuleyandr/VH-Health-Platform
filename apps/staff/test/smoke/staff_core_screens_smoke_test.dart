import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:vhhealth_core/services/auth_service.dart' as core_auth;
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/offline_queue.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_staff/core/providers/clinical_inbox_provider.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/core/providers/websocket_provider.dart';
import 'package:vhhealth_staff/core/services/auth_service.dart' as staff_auth;
import 'package:vhhealth_staff/core/services/clinical_inbox_api_service.dart';
import 'package:vhhealth_staff/features/auth/screens/login_screen.dart';
import 'package:vhhealth_staff/features/beds/screens/bed_board_screen.dart';
import 'package:vhhealth_staff/features/clinical_inbox/screens/clinical_inbox_screen.dart';
import 'package:vhhealth_staff/features/dashboard/screens/dashboard_screen.dart';
import 'package:vhhealth_staff/features/doctor/screens/prescriptions_screen.dart';
import 'package:vhhealth_staff/features/ipd/screens/drug_chart_screen.dart';
import 'package:vhhealth_staff/features/nursing/screens/due_meds_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

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

class _SmokeClinicalInboxApi extends ClinicalInboxApi {
  const _SmokeClinicalInboxApi();

  @override
  Future<ClinicalInboxResult> listInboxTasks({int limit = 100}) async {
    return const ClinicalInboxResult(tasks: [], count: 0);
  }

  @override
  Future<ClinicalInboxTask> acknowledgeTask(String id, {int? breakGlassId}) {
    throw UnimplementedError('Smoke test has no inbox tasks to acknowledge');
  }
}

class _SmokeApi {
  var loginPosts = 0;
  var emrOrderPosts = 0;
  Map<String, dynamic>? lastEmrOrderBody;

  http.Response handle(http.Request request) {
    final path = request.url.path;
    final method = request.method;

    if (method == 'POST' && path.endsWith('/auth/staff/login')) {
      loginPosts++;
      return _ok({
        'accessToken':
            'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzdGFmZi11aWQiLCJyb2xlIjoiTlVSU0lOR19TVEFGRiJ9.sig',
        'refreshToken': 'refresh-token',
        'staff': {
          '_id': 'staff-1',
          'id': 'staff-1',
          'uid': 'staff-uid-1',
          'role': 'NURSING_STAFF',
          'phone': '9999999999',
        },
      });
    }

    if (method == 'GET' && path.endsWith('/config/campus-locations')) {
      return _ok({
        'campusLat': 13.02936,
        'campusLng': 80.24409,
        'campusRadius': 200,
      });
    }
    if (method == 'GET' && path.endsWith('/auth/staff/attendance/today')) {
      return _ok({'status': 'not-checked-in', 'isCheckedIn': false});
    }
    if (method == 'GET' && path.endsWith('/appointments/list')) {
      return _ok({
        'appointments': [],
        'pagination': {'total': 0},
      });
    }
    if (method == 'GET' && path.endsWith('/notifications/my')) {
      return _ok({'notifications': []});
    }
    if (method == 'GET' && path.endsWith('/clinical/mar/due')) {
      return _ok([]);
    }
    if (method == 'GET' && path.endsWith('/admissions/command-board')) {
      return _ok({
        'board': {
          'counts': {'total': 0},
        },
        'admissions': [],
      });
    }
    if (method == 'GET' && path.endsWith('/wards')) {
      return _ok({
        'wards': [
          {
            'id': 1,
            'name': 'Ward A',
            'bed_count': 0,
            'occupied_count': 0,
            'total_beds': 0,
          },
        ],
      });
    }
    if (method == 'GET' && path.endsWith('/beds/ward/1')) {
      return _ok({'beds': []});
    }
    if (method == 'GET' && path.endsWith('/clinical/drug-chart/admission/42')) {
      return _ok({
        'admission': {
          'patient_name': 'Demo Patient',
          'patient_uid': 'patient-uid-1',
          'encounter_id': 'enc-1',
        },
        'medication_orders': [],
        'permissions': {'can_prescribe': true, 'can_administer': true},
      });
    }
    if (method == 'POST' && path.endsWith('/emr/orders')) {
      emrOrderPosts++;
      lastEmrOrderBody = jsonDecode(request.body) as Map<String, dynamic>;
      return _ok({'id': 77});
    }
    if (method == 'GET' && path.endsWith('/prescriptions/all')) {
      return _ok([]);
    }
    if (method == 'GET' && path.endsWith('/messaging/unread-count')) {
      return _ok({'unread_count': 0});
    }
    if (method == 'GET' && path.endsWith('/clinical-ai/clinical/reviews')) {
      return _ok({'reviews': [], 'items': []});
    }
    if (method == 'GET' && path.endsWith('/clinical-ai/modules/op-assist')) {
      return _ok({'modules': []});
    }

    return _ok({});
  }

  http.Response _ok(Object? data) {
    return http.Response(
      jsonEncode({'success': true, 'data': data}),
      200,
      headers: {'content-type': 'application/json'},
    );
  }
}

GoRouter _smokeRouter() {
  return GoRouter(
    initialLocation: '/login',
    routes: [
      GoRoute(
        path: '/login',
        pageBuilder: (context, state) =>
            const NoTransitionPage(child: LoginScreen()),
      ),
      GoRoute(
        path: '/dashboard',
        pageBuilder: (context, state) =>
            const NoTransitionPage(child: DashboardScreen()),
      ),
      GoRoute(
        path: '/beds',
        pageBuilder: (context, state) =>
            const NoTransitionPage(child: BedBoardScreen()),
      ),
      GoRoute(
        path: '/mar/due',
        pageBuilder: (context, state) =>
            const NoTransitionPage(child: DueMedsScreen()),
      ),
      GoRoute(
        path: '/drug-chart/:admissionId',
        pageBuilder: (context, state) {
          final admissionId =
              int.tryParse(state.pathParameters['admissionId'] ?? '') ?? 0;
          return NoTransitionPage(
            child: DrugChartScreen(
              admissionId: admissionId,
              patientName: state.uri.queryParameters['name'],
            ),
          );
        },
      ),
      GoRoute(
        path: '/clinical-inbox',
        pageBuilder: (context, state) =>
            const NoTransitionPage(child: ClinicalInboxScreen()),
      ),
      GoRoute(
        path: '/prescriptions',
        pageBuilder: (context, state) =>
            const NoTransitionPage(child: PrescriptionsScreen()),
      ),
    ],
  );
}

Widget _smokeApp(GoRouter router) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider(create: (_) => ThemeProvider()),
      ChangeNotifierProvider(create: (_) => WebSocketProvider()),
      ChangeNotifierProvider(
        create: (_) => ClinicalInboxProvider(
          api: const _SmokeClinicalInboxApi(),
          pollInterval: const Duration(hours: 1),
        ),
      ),
      ChangeNotifierProvider(
        create: (_) =>
            SessionTimeoutProvider(timeoutDuration: const Duration(hours: 1)),
      ),
    ],
    child: Consumer<ThemeProvider>(
      builder: (context, theme, _) {
        return MaterialApp.router(
          debugShowCheckedModeBanner: false,
          theme: theme.lightTheme,
          darkTheme: theme.darkTheme,
          themeMode: theme.themeMode,
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          supportedLocales: AppStrings.supportedLocales,
          routerConfig: router,
        );
      },
    ),
  );
}

Finder _fieldWithLabel(String label) {
  return find.widgetWithText(TextFormField, label);
}

Future<void> _pumpUntilFound(WidgetTester tester, Finder finder) async {
  for (var i = 0; i < 40; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) return;
  }
}

Future<void> _expectScreen(
  WidgetTester tester,
  GoRouter router,
  String route,
  String expectedText,
) async {
  router.go(route);
  await _pumpUntilFound(tester, find.text(expectedText));
  expect(find.text(expectedText), findsWidgets);
  expect(tester.takeException(), isNull);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  setUp(() async {
    _installSecureStorageFake();
    SharedPreferences.setMockInitialValues({});
    OfflineQueue.debugDbFileNameOverride = 'staff_core_screens_smoke.db';
    await OfflineQueue.deleteTestDatabase();
    staff_auth.AuthService.debugDisablePostLoginSync = true;
  });

  tearDown(() async {
    await RealtimeClient.instance.disconnect();
    await OfflineQueue.resetForTesting();
    OfflineQueue.debugDbFileNameOverride = null;
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
    staff_auth.AuthService.debugDisablePostLoginSync = false;
    await core_auth.AuthService.clearSessionIdentity();
    await ConnectivitySyncService.instance.resetForTesting();
    const channel = MethodChannel(
      'plugins.it_nomads.com/flutter_secure_storage',
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  testWidgets(
    'SMOKE: login, dashboard, and five core clinical screens render',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1400, 1000);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final api = _SmokeApi();
      VHHttpClient.setClientForTesting(
        MockClient((request) async => api.handle(request)),
      );
      final router = _smokeRouter();

      await tester.pumpWidget(_smokeApp(router));
      await _pumpUntilFound(tester, find.text('Sign In with Password'));

      await tester.enterText(_fieldWithLabel('Employee ID'), '1001');
      await tester.enterText(_fieldWithLabel('Password'), 'Password1!');
      await tester.tap(find.text('Sign In with Password'));

      await _pumpUntilFound(tester, find.textContaining('Welcome back'));
      expect(api.loginPosts, 1);
      expect(find.textContaining('Welcome back'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await core_auth.AuthService.clearJwt();
      await RealtimeClient.instance.disconnect();

      await _expectScreen(tester, router, '/beds', 'Bed Board');
      await _expectScreen(tester, router, '/mar/due', 'Due Medications');
      await _expectScreen(
        tester,
        router,
        '/drug-chart/42?name=Demo%20Patient',
        'Drug Chart',
      );
      await _expectScreen(
        tester,
        router,
        '/clinical-inbox',
        'No pending critical results',
      );
      await _expectScreen(tester, router, '/prescriptions', 'E-Prescriptions');
    },
  );

  testWidgets('drug chart draft save still uses the existing order path', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1800, 1000);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _SmokeApi();
    VHHttpClient.setClientForTesting(
      MockClient((request) async => api.handle(request)),
    );
    final router = _smokeRouter();
    await tester.pumpWidget(_smokeApp(router));

    router.go('/drug-chart/42?name=Demo%20Patient');
    await _pumpUntilFound(tester, find.text('Drug Chart'));
    await _pumpUntilFound(tester, find.text('Add row'));
    await tester.tap(find.text('Add row').first);
    await tester.pumpAndSettle();

    await tester.enterText(find.widgetWithText(TextField, 'Drug'), 'Aspirin');
    await tester.enterText(find.widgetWithText(TextField, 'Dose'), '75 mg');
    final saveButton = find.widgetWithText(FilledButton, 'Save');
    await _pumpUntilFound(tester, saveButton);
    await tester.ensureVisible(saveButton);
    await tester.pumpAndSettle();
    await tester.tap(saveButton);
    await tester.pumpAndSettle();

    expect(api.emrOrderPosts, 1);
    final details = api.lastEmrOrderBody?['details'] as Map<String, dynamic>?;
    expect(details?['medication_name'], 'Aspirin');
    expect(details?['dose'], '75 mg');
  });
}
