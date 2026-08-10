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
//
// Each test drives the REAL trigger for its path with LogoutService's
// dependencies swapped for recorders, then asserts the COMPLETE ordered
// teardown ran. If a new teardown step is added to LogoutServiceDependencies,
// update [fullTeardown] here — every path inherits it automatically because
// they all funnel through the one service.

import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_core/services/realtime_provider.dart';

import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/session_timeout_provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/logout_service.dart';
import 'package:vhhealth/core/widgets/logout_button.dart';
import 'package:vhhealth/core/widgets/session_revocation_listener.dart';
import 'package:vhhealth/features/auth/services/otp_service.dart';
import 'package:vhhealth/features/auth/widgets/otp_widget.dart';
import 'package:vhhealth/features/settings/controllers/settings_controller.dart';
import 'package:vhhealth/features/settings/services/account_deletion_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';

/// The complete teardown, in order. Every logout path must produce exactly
/// this sequence — nothing skipped, nothing reordered.
const List<String> fullTeardown = [
  'firebase-server-revoke',
  'device-unregister',
  'vh-server-revoke',
  'websocket',
  'realtime',
  'push-user',
  'fcm-token',
  'notifications',
  'secure-storage',
  'api-cache',
  'file-cache',
  'doc-staging',
  'cycle-tracker',
  'dependents',
  'user-provider',
  'firebase-signout',
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    _installSecureStorageFake();
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

  tearDown(() {
    LogoutService.debugResetDependencies();
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
      await tester.tap(find.widgetWithText(ElevatedButton, 'Logout'));
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
      await tester.tap(find.widgetWithText(ElevatedButton, 'Logout'));
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
      await tester.tap(find.widgetWithText(ElevatedButton, 'Logout'));
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
      expect(
        find.text(
          'Signed out on this device. We could not reach the server, so '
          'other devices may stay signed in until you retry.',
        ),
        findsOneWidget,
      );

      await tester.pump(const Duration(seconds: 7));
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
    disconnectWebSocket: step('websocket'),
    disconnectRealtime: step('realtime'),
    clearPushSignedInUser: step('push-user'),
    deleteFcmToken: step('fcm-token'),
    cancelNotifications: step('notifications'),
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
