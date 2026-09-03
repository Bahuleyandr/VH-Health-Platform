// test/core/services/logout_teardown_paths_test.dart
//
// The patient app has SIX logout paths, and every one of them must run the
// SAME full teardown (LogoutService.logout) — a partial teardown on any path
// leaks the prior account's realtime channels, FCM registration, dependents
// roster (PHI + the acting-as header), caches, or Firebase session to the
// next account on the device:
//
//   1. Manual logout — LogoutButton.confirmAndLogout
//      (lib/core/widgets/logout_button.dart)
//   2. Idle session timeout — SessionTimeoutProvider
//      (lib/core/providers/session_timeout_provider.dart)
//   3. 401 session expiry after a failed refresh —
//      LogoutService.handleSessionExpired, wired to ApiClient.onSessionExpired
//      in main.dart
//   4. Server-side session revocation ("logged in elsewhere") —
//      SessionRevocationListener (lib/core/widgets/session_revocation_listener.dart)
//   5. Backend login failure during OTP sign-in — OtpWidget
//      (lib/features/auth/widgets/otp_widget.dart)
//   6. Account deletion — SettingsController.deleteAccount
//      (lib/features/settings/controllers/settings_controller.dart)
//   7. Realtime 4001 auth close after a failed refresh —
//      RealtimeClient.onSessionExpired → handlePatientSessionExpired,
//      wired onto RealtimeProvider in main.dart
//      (lib/core/services/patient_session_expiry.dart)
//
// Each test drives the REAL trigger for its path with LogoutService's
// dependencies swapped for recorders, then asserts the COMPLETE ordered
// teardown ran. If a new teardown step is added to LogoutServiceDependencies,
// update [fullTeardown] here — every path inherits it automatically because
// they all funnel through the one service.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_core/services/realtime_provider.dart';

import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/session_timeout_provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/logout_service.dart';
import 'package:vhhealth/core/services/patient_realtime_lifecycle.dart';
import 'package:vhhealth/core/services/patient_session_expiry.dart';
import 'package:vhhealth/core/widgets/logout_button.dart';
import 'package:vhhealth/core/widgets/session_revocation_listener.dart';
import 'package:vhhealth/features/auth/services/otp_service.dart';
import 'package:vhhealth/features/auth/widgets/otp_widget.dart';
import 'package:vhhealth/features/settings/controllers/settings_controller.dart';
import 'package:vhhealth/features/settings/services/account_deletion_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/generated/app_localizations_en.dart';

/// The complete teardown, in order. Every logout path must produce exactly
/// this sequence — nothing skipped, nothing reordered.
const List<String> fullTeardown = [
  'firebase-server-revoke',
  'device-unregister',
  'vh-server-revoke',
  'realtime',
  'push-user',
  'fcm-token',
  'notifications',
  'health-sync',
  'api-cache',
  'secure-storage',
  'file-cache',
  'doc-staging',
  'cycle-tracker',
  'dependents',
  'user-provider',
  'firebase-signout',
  'realtime',
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    _installSecureStorageFake();
    SharedPreferences.setMockInitialValues(<String, Object>{});
    // LogoutService's final realtime fence runs through the process-wide
    // PatientRealtimeLifecycle singleton, which serializes work on a stored
    // future. That future belongs to the async zone that created it, and each
    // testWidgets body gets a fresh FakeAsync zone — so without this reset the
    // second and later widget tests queue their teardown behind a future from
    // an already-dead zone and logout() never completes.
    PatientRealtimeLifecycle.instance.debugReset();
  });

  tearDown(() {
    LogoutService.debugResetDependencies();
    PatientRealtimeLifecycle.instance.debugReset();
    UserProvider.instance = null;
  });

  test('path 2: idle session timeout runs the full shared teardown', () async {
    final calls = <String>[];
    LogoutService.debugSetDependencies(_recordingDependencies(calls));

    final provider = SessionTimeoutProvider(
      timeoutDuration: const Duration(milliseconds: 20),
    );
    addTearDown(provider.dispose);
    provider.startTracking();

    await Future<void>.delayed(const Duration(milliseconds: 200));

    expect(provider.isSessionExpired, isTrue);
    expect(calls, fullTeardown);
  });

  test(
    'path 3: 401 expiry runs the full shared teardown and redirects',
    () async {
      final calls = <String>[];
      final signOutGate = Completer<void>();
      LogoutService.debugSetDependencies(
        _recordingDependencies(calls, signOutGate: signOutGate),
      );

      final user = UserProvider();
      await user.setUser('9876543210', 'Test Patient');

      var redirected = false;
      LogoutService.handleSessionExpired(
        redirectToLogin: () => redirected = true,
      );
      await Future<void>.delayed(Duration.zero);

      // Do not expose the login screen while the old teardown can still wipe
      // credentials written by a fast re-login.
      expect(redirected, isFalse);
      signOutGate.complete();
      await Future<void>.delayed(Duration.zero);

      expect(redirected, isTrue);
      expect(calls, fullTeardown);
    },
  );

  test('path 7: a realtime 4001 close whose refresh fails runs the full shared '
      'teardown and redirects', () async {
    // THE regression test for the server-side-revocation gap. The backend
    // closes the identity's live sockets with 4001 on "signed out
    // everywhere", admin revocation, password change and account deletion.
    // RealtimeClient then attempts one refresh; when that is rejected it
    // clears both tokens and fires onSessionExpired. main.dart used to build
    // `RealtimeProvider()` with NO callback, so that fired into a null and
    // every byte of local PHI — encrypted API cache, downloaded documents,
    // staged plaintext, cycle data, dependents roster, Firebase session, FCM
    // registration — survived on the device.
    final calls = <String>[];
    LogoutService.debugSetDependencies(_recordingDependencies(calls));

    final harness = await _RevokingWsHarness.start();
    addTearDown(harness.close);
    RealtimeClient.setWsUrlForTesting(harness.wsUrl);
    RealtimeClient.setReconnectBackoffForTesting(initialMs: 20, maxMs: 40);
    addTearDown(() async {
      await RealtimeClient.instance.disconnect();
      RealtimeClient.instance.onSessionExpired = null;
      RealtimeClient.setWsUrlForTesting(null);
      RealtimeClient.setReconnectBackoffForTesting();
      VHHttpClient.resetClientForTesting();
      await AuthService.clearSessionIdentity();
    });

    await AuthService.setJwt('revoked-access');
    await AuthService.setRefreshToken('revoked-refresh');
    final user = UserProvider();
    await user.setUser('9876543210', 'Test Patient');

    // The refresh the client tries before giving up — rejected, because the
    // whole identity was revoked server-side.
    var refreshCalls = 0;
    VHHttpClient.setClientForTesting(
      MockClient((_) async {
        refreshCalls++;
        return http.Response(
          jsonEncode({'success': false, 'message': 'Revoked'}),
          HttpStatus.unauthorized,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    var redirected = false;
    // Exactly the wiring main.dart installs, with only the navigation
    // injected so this test's assertion does not depend on AppRouter.
    final realtime = RealtimeProvider(
      onSessionExpired: () =>
          handlePatientSessionExpired(redirectToLogin: () => redirected = true),
    );
    addTearDown(realtime.dispose);

    await realtime.ensureConnected();
    await _waitFor(
      () => redirected,
      reason: 'the 4001 close to drive the patient logout',
    );

    expect(refreshCalls, 1);
    expect(calls, fullTeardown);
    // The client's own token drop is NOT the wipe — it is what used to be
    // mistaken for one.
    expect(await AuthService.getJwt(), isNull);
    expect(await AuthService.getRefreshToken(), isNull);
    expect(RealtimeClient.instance.isConnected, isFalse);
  });

  test('path 3: a pre-hydration 401 with a persisted session runs the full '
      'shared teardown (a dead session must not read as guest)', () async {
    final calls = <String>[];
    LogoutService.debugSetDependencies(_recordingDependencies(calls));

    // The token was revoked while the app was closed: on the next cold start
    // main.dart fires an authenticated GET BEFORE the splash hydrates
    // UserProvider, so the in-memory provider still looks like a guest
    // (phone empty) when the 401 lands — but a real session is persisted.
    final user = UserProvider();
    expect(user.isGuest, isTrue, reason: 'not yet hydrated');
    await VHSecureStorage.instance.write(
      key: 'user_phone',
      value: '9876543210',
    );
    await VHSecureStorage.instance.write(key: 'jwt', value: 'revoked-jwt');

    var redirected = false;
    LogoutService.handleSessionExpired(
      redirectToLogin: () => redirected = true,
    );
    await _waitFor(
      () => redirected,
      reason: 'the pre-hydration expiry to run the full teardown',
    );

    expect(calls, fullTeardown);
  });

  test('path 3: a fresh install with no persisted session trace skips the '
      'teardown', () async {
    final calls = <String>[];
    LogoutService.debugSetDependencies(_recordingDependencies(calls));

    // Unhydrated provider AND nothing persisted: this device never held a
    // patient credential, so there is no PHI to tear down and the user must
    // not be bounced to /login.
    final user = UserProvider();
    expect(user.isGuest, isTrue);

    var redirected = false;
    LogoutService.handleSessionExpired(
      redirectToLogin: () => redirected = true,
    );
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(redirected, isFalse);
    expect(calls, isEmpty);
  });

  test('path 3: 401 expiry is a no-op for guest sessions', () async {
    final calls = <String>[];
    LogoutService.debugSetDependencies(_recordingDependencies(calls));

    final user = UserProvider();
    await user.setGuest();

    var redirected = false;
    LogoutService.handleSessionExpired(
      redirectToLogin: () => redirected = true,
    );
    await Future<void>.delayed(Duration.zero);

    expect(redirected, isFalse);
    expect(calls, isEmpty);
  });

  testWidgets(
    'path 4: session revocation kick runs the full shared teardown and lands on /login',
    (tester) async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(_recordingDependencies(calls));

      final events = StreamController<RealtimeEvent>.broadcast();
      addTearDown(events.close);
      final realtime = _FakeRealtimeProvider(events);
      addTearDown(realtime.dispose);

      final router = _testRouter(
        home: const Scaffold(body: Text('home-screen')),
      );

      await tester.pumpWidget(
        ChangeNotifierProvider<RealtimeProvider>.value(
          value: realtime,
          child: MaterialApp.router(
            routerConfig: router,
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            builder: (context, child) => SessionRevocationListener(
              // Production defaults to AppRouter.router; injected here so the
              // test's own router observes the redirect.
              redirectToLogin: () => router.go('/login'),
              child: child ?? const SizedBox.shrink(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      events.add(
        RealtimeEvent(
          channel: 'session:revoked',
          data: <String, dynamic>{'reason': 'new_login_elsewhere'},
          at: DateTime.now(),
        ),
      );
      await tester.pumpAndSettle();

      expect(calls, fullTeardown);
      expect(find.text('login-screen'), findsOneWidget);
    },
  );

  testWidgets(
    'path 1: manual logout button runs the full shared teardown and lands on /login',
    (tester) async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(_recordingDependencies(calls));

      final router = _testRouter(home: const Scaffold(body: LogoutButton()));

      await tester.pumpWidget(
        MaterialApp.router(
          routerConfig: router,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byType(ListTile));
      await tester.pumpAndSettle();

      // Confirm in the dialog (the only ElevatedButton on screen).
      await tester.tap(
        find.widgetWithText(
          ElevatedButton,
          AppLocalizationsEn().settingsLogout,
        ),
      );
      await tester.pumpAndSettle();

      expect(calls, fullTeardown);
      expect(find.text('login-screen'), findsOneWidget);
    },
  );

  testWidgets(
    'path 1: manual logout shows a blocking progress indicator until the '
    'teardown finishes, then dismisses it before landing on /login',
    (tester) async {
      final calls = <String>[];
      final gate = Completer<void>();
      LogoutService.debugSetDependencies(
        _recordingDependencies(calls, signOutGate: gate),
      );

      final router = _testRouter(home: const Scaffold(body: LogoutButton()));
      await tester.pumpWidget(
        MaterialApp.router(
          routerConfig: router,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byType(ListTile));
      await tester.pumpAndSettle();
      await tester.tap(
        find.widgetWithText(
          ElevatedButton,
          AppLocalizationsEn().settingsLogout,
        ),
      );
      await tester.pump();
      await tester.pump();

      // Teardown is still running (held open at its final step): the
      // blocking progress dialog must be up so a slow network reads as
      // "signing out" instead of a frozen app the user force-kills —
      // force-killing here is what used to skip the local PHI wipe.
      expect(find.text('Signing out…'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      gate.complete();
      await tester.pumpAndSettle();

      expect(find.text('Signing out…'), findsNothing);
      expect(calls, fullTeardown);
      expect(find.text('login-screen'), findsOneWidget);
    },
  );

  testWidgets(
    'path 1: failed server revocation warning survives auth redirect disposal',
    (tester) async {
      final calls = <String>[];
      final signOutGate = Completer<void>();
      final atLogin = ValueNotifier<bool>(false);
      addTearDown(atLogin.dispose);
      LogoutService.debugSetDependencies(
        _recordingDependencies(
          calls,
          firebaseSessionRevoked: false,
          signOutGate: signOutGate,
          onSignOutFirebase: () => atLogin.value = true,
        ),
      );

      await tester.pumpWidget(
        MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: ValueListenableBuilder<bool>(
            valueListenable: atLogin,
            builder: (context, isAtLogin, child) => Scaffold(
              body: isAtLogin
                  ? const Text('login-screen')
                  : const LogoutButton(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byType(ListTile));
      await tester.pumpAndSettle();
      await tester.tap(
        find.widgetWithText(
          ElevatedButton,
          AppLocalizationsEn().settingsLogout,
        ),
      );
      await tester.pump();
      await tester.pump();

      // Firebase sign-out has already redirected and disposed the route that
      // owned LogoutButton, while LogoutService is still awaiting its final
      // step. The warning must not depend on that dead BuildContext.
      expect(find.text('login-screen'), findsOneWidget);
      expect(find.byType(LogoutButton), findsNothing);

      signOutGate.complete();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));

      expect(calls, fullTeardown);
      // Asserted through the production selector rather than a copied string
      // literal, so the test cannot silently drift out of sync with the copy
      // it is guarding. This scenario is specifically the branch with NO retry
      // queued: the Firebase revoke failed and no session token was captured.
      const outcome = LogoutOutcome(
        firebaseSessionRevoked: false,
        vhSessionRevoked: true,
      );
      expect(outcome.revocationRetryQueued, isFalse);
      expect(
        find.text(
          LogoutButton.logoutWarningMessage(outcome, AppLocalizationsEn())!,
        ),
        findsOneWidget,
      );
      // And it must NOT be the "we will retry for you" copy — there is no
      // retry handle on this device.
      expect(
        find.text(
          LogoutButton.logoutWarningMessage(
            const LogoutOutcome(
              firebaseSessionRevoked: false,
              vhSessionRevoked: true,
              revocationRetryQueued: true,
            ),
            AppLocalizationsEn(),
          )!,
        ),
        findsNothing,
      );

      await tester.pump(const Duration(seconds: 9));
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'path 5: failed backend login during OTP sign-in runs the full shared teardown',
    (tester) async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(_recordingDependencies(calls));

      await tester.pumpWidget(
        MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: SingleChildScrollView(
              child: OtpWidget(
                phoneNumber: '+919876543210',
                onSuccess: () {},
                otpService: OtpService(verifyPhoneNumber: _neverVerify),
              ),
            ),
          ),
        ),
      );
      // Bounded pumps — the widget shows an indefinite "sending OTP" spinner
      // (the fake verify never calls back), so pumpAndSettle would time out.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      // The teardown entry point for this path (the surrounding
      // Firebase sign-in cannot run without a Firebase app).
      final dynamic state = tester.state(find.byType(OtpWidget));
      await state.teardownFailedBackendLogin();
      await tester.pump();

      expect(calls, fullTeardown);
    },
  );

  testWidgets(
    'path 6: account deletion runs the full shared teardown and lands on /login',
    (tester) async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(_recordingDependencies(calls));

      final controller = SettingsController(
        '9876543210',
        'Test Patient',
        () {},
        accountDeletionService: _FakeAccountDeletionService(),
      );

      final router = _testRouter(home: _DeletionHost(controller: controller));

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider(create: (_) => ThemeProvider()),
            ChangeNotifierProvider(create: (_) => LanguageProvider()),
          ],
          child: MaterialApp.router(
            routerConfig: router,
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('delete-account'));
      await tester.pumpAndSettle();

      // Consequences dialog → Continue. The fake deletion service then
      // auto-verifies the fresh OTP, so the OTP dialog resolves itself.
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      // Final confirmation dialog → Delete.
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      expect(calls, fullTeardown);
      expect(find.text('login-screen'), findsOneWidget);
    },
  );
}

/// A loopback WebSocket endpoint that answers every `auth` frame with a real
/// 4001 close — the server-side revocation the backend performs in
/// `wsServer.pushSessionRevoked` / `deliverUserLocal`'s `isRevocation` branch.
class _RevokingWsHarness {
  _RevokingWsHarness._(this._server);

  final HttpServer _server;

  String get wsUrl => 'ws://127.0.0.1:${_server.port}/ws';

  static Future<_RevokingWsHarness> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      if (request.uri.path != '/ws') {
        request.response.statusCode = HttpStatus.notFound;
        await request.response.close();
        return;
      }
      final socket = await WebSocketTransformer.upgrade(request);
      socket.listen((raw) {
        final message = jsonDecode(raw as String) as Map<String, dynamic>;
        if (message['action'] == 'auth') {
          unawaited(socket.close(4001, 'revoked'));
        }
      });
    });
    return _RevokingWsHarness._(server);
  }

  Future<void> close() => _server.close(force: true);
}

Future<void> _waitFor(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 10),
  String reason = 'condition',
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) fail('timed out waiting for $reason');
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

GoRouter _testRouter({required Widget home}) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (context, state) => home),
      GoRoute(
        path: '/login',
        builder: (context, state) => const Scaffold(body: Text('login-screen')),
      ),
    ],
  );
}

LogoutServiceDependencies _recordingDependencies(
  List<String> calls, {
  bool firebaseSessionRevoked = true,
  bool vhSessionRevoked = true,
  Completer<void>? signOutGate,
  VoidCallback? onSignOutFirebase,
}) {
  LogoutStep step(String name) =>
      () => calls.add(name);

  return LogoutServiceDependencies(
    revokeFirebaseSession: () {
      calls.add('firebase-server-revoke');
      return firebaseSessionRevoked;
    },
    unregisterDevice: step('device-unregister'),
    revokeVhSession: () {
      calls.add('vh-server-revoke');
      return vhSessionRevoked;
    },
    disconnectRealtime: step('realtime'),
    clearPushSignedInUser: step('push-user'),
    deleteFcmToken: step('fcm-token'),
    cancelNotifications: step('notifications'),
    clearHealthSyncState: step('health-sync'),
    clearSecureStorage: step('secure-storage'),
    clearApiCache: step('api-cache'),
    clearDownloadedFileCache: step('file-cache'),
    purgeDocumentStaging: step('doc-staging'),
    clearCycleTracker: step('cycle-tracker'),
    clearDependentsProvider: step('dependents'),
    clearUserProvider: step('user-provider'),
    signOutFirebase: () async {
      calls.add('firebase-signout');
      onSignOutFirebase?.call();
      await signOutGate?.future;
    },
  );
}

/// A [RealtimeProvider] whose event stream is driven by the test instead of
/// the real RealtimeClient socket.
class _FakeRealtimeProvider extends RealtimeProvider {
  _FakeRealtimeProvider(this._events);

  final StreamController<RealtimeEvent> _events;

  @override
  Stream<RealtimeEvent> events(String channel, {bool broadcastChannel = true}) {
    return _events.stream;
  }
}

/// Deletion service that never touches Firebase: the fresh-OTP dialog is
/// auto-verified immediately and the backend delete succeeds.
class _FakeAccountDeletionService extends AccountDeletionService {
  @override
  Future<void> sendFreshOtp({
    required String phoneNumber,
    required ValueChanged<String> onCodeSent,
    required ValueChanged<String> onAutoVerified,
    required ValueChanged<String> onError,
  }) async {
    onAutoVerified('fresh-token');
  }

  @override
  Future<void> deleteAccount({required String freshFirebaseIdToken}) async {}
}

class _DeletionHost extends StatelessWidget {
  const _DeletionHost({required this.controller});

  final SettingsController controller;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: () {
            controller.initialize(context);
            controller.deleteAccount();
          },
          child: const Text('delete-account'),
        ),
      ),
    );
  }
}

Future<void> _neverVerify({
  required String phoneNumber,
  required PhoneVerificationCompleted verificationCompleted,
  required PhoneVerificationFailed verificationFailed,
  required PhoneCodeSent codeSent,
  required PhoneCodeAutoRetrievalTimeout codeAutoRetrievalTimeout,
  int? forceResendingToken,
}) async {}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = call.arguments == null
            ? <String, dynamic>{}
            : Map<String, dynamic>.from(call.arguments as Map);
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
