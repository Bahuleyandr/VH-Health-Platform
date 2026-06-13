import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:screen_protector/screen_protector.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:vhhealth_core/vhhealth_core.dart'
    show ApiConfig, SecurityConfig;

// Firebase Options
import 'firebase_options.dart';

// Core App Providers
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/providers/session_timeout_provider.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';

// App Router
import 'package:vhhealth/core/navigation/app_router.dart';

// Core Services
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/connectivity_service.dart';
import 'package:vhhealth/core/services/firebase_crash_reporter.dart';
import 'package:vhhealth/core/services/health_sync_service.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';
import 'package:vhhealth/core/services/websocket_service.dart';
import 'package:vhhealth/core/widgets/session_revocation_listener.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth_core/vhhealth_core.dart' show RealtimeProvider;
import 'package:vhhealth/core/offline/mutation_queue.dart';

// App Utilities
import 'package:vhhealth/generated/app_localizations.dart';

Future<void> main() async {
  var crashlyticsEnabled = false;

  await runZonedGuarded<Future<void>>(
    () async {
      WidgetsFlutterBinding.ensureInitialized();
      // Fail fast on misconfigured production builds (audit finding H7):
      // throws when PRODUCTION=true but CERT_PIN_HASHES is missing/malformed,
      // so an unpinned PHI build can never reach patients.
      SecurityConfig.verifyOrWarn();
      await Firebase.initializeApp(
        options: DefaultFirebaseOptions.currentPlatform,
      );
      crashlyticsEnabled =
          !const bool.fromEnvironment(
            'VH_DISABLE_CRASHLYTICS',
            defaultValue: false,
          ) &&
          (Platform.isAndroid || Platform.isIOS);

      // Firebase phone-auth app verification is fragile on emulators and
      // sideloaded debug builds. Keep production untouched, but let local QA
      // builds choose between fictional-number test mode and a forced
      // reCAPTCHA fallback through dart-defines.
      const firebaseAuthTestMode = bool.fromEnvironment(
        'VH_FIREBASE_AUTH_TEST_MODE',
        defaultValue: false,
      );
      const firebaseForceRecaptcha = bool.fromEnvironment(
        'VH_FIREBASE_FORCE_RECAPTCHA',
        defaultValue: false,
      );
      final disableAppVerification =
          firebaseAuthTestMode ||
          (kDebugMode && ApiConfig.baseUrl.startsWith('http://'));
      final forceRecaptcha =
          !disableAppVerification && kDebugMode && firebaseForceRecaptcha;
      if (disableAppVerification || forceRecaptcha) {
        try {
          await FirebaseAuth.instance.setSettings(
            appVerificationDisabledForTesting: disableAppVerification,
            forceRecaptchaFlow: forceRecaptcha,
          );
        } catch (e) {
          debugPrint('Firebase test-mode setSettings skipped: $e');
        }
      }

      // Install the Firebase-backed crash reporter so core + app code all route
      // non-fatal errors through the same abstraction.
      if (crashlyticsEnabled) {
        CrashReporter.install(const FirebaseCrashReporter());

        // RenderFlex overflow is a layout defect, not a process crash. Keep it
        // visible in Crashlytics without inflating the fatal crash trend email.
        FlutterError.onError = _recordFlutterFrameworkError;
      }

      // Wire 401 handler: when any API call returns Unauthorized, redirect to login.
      ApiClient.onSessionExpired = (message) {
        if (UserProvider.instance?.isGuest ?? false) {
          return;
        }
        UserProvider.instance?.clear();
        AppRouter.router.go('/login');
      };

      // Local notifications: initialize the scheduler, then sync medication
      // reminders from the backend. Both run off the critical path — neither is
      // needed for the first frame (the splash screen), and even with a JWT in
      // storage a slow / unreachable backend would otherwise stall the splash for
      // the full VHHttpClient retry budget (~30s). NotificationScheduler's public
      // methods self-initialize, so any later caller (dashboard reschedule,
      // logout cancelAll) is safe even before this block finishes.
      unawaited(() async {
        try {
          await NotificationScheduler.initialize();
          final jwt = await VHSecureStorage.instance.read(key: 'jwt');
          if (jwt == null || jwt.isEmpty) return;
          final remindersResp = await ApiClient.get('/reminders/medication');
          if (remindersResp.isSuccess && remindersResp.data is List) {
            final reminders = (remindersResp.data as List)
                .cast<Map<String, dynamic>>();
            await NotificationScheduler.rescheduleAll(reminders);
          }
        } catch (e) {
          debugPrint('Medication reminder setup skipped: $e');
        }
      }());

      // Start network connectivity monitoring.
      ConnectivityService.startMonitoring();

      // Auto-replay queued mutations when connectivity is restored.
      ConnectivityService.onChange.listen((online) {
        if (online) MutationQueue.replayQueue();
      });

      // Connect the WebSocket service for real-time updates.
      WebSocketService.instance.connect();

      runApp(const VHRoot());
    },
    (error, stack) {
      if (crashlyticsEnabled) {
        FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
      } else if (kDebugMode) {
        debugPrint('Uncaught app error: $error');
      }
    },
  );
}

void _recordFlutterFrameworkError(FlutterErrorDetails details) {
  final exception = details.exceptionAsString();
  final isLayoutOverflow =
      exception.contains('RenderFlex overflowed') ||
      exception.contains('overflowed by');

  FirebaseCrashlytics.instance.recordFlutterError(
    details,
    fatal: !isLayoutOverflow,
  );
}

class VHRoot extends StatefulWidget {
  const VHRoot({super.key});

  @override
  State<VHRoot> createState() => _VHRootState();
}

class _VHRootState extends State<VHRoot> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // PAT-6: block screenshots and suppress the app-switcher thumbnail
    // so PHI cannot leak via Android recents or iOS Exposé.
    // screen_protector handles FLAG_SECURE on Android and the
    // resignActive snapshot blur on iOS; no-op on other platforms.
    _applyScreenProtection();
  }

  Future<void> _applyScreenProtection() async {
    try {
      // protectDataLeakageOn: FLAG_SECURE (Android) + screenshot blocking.
      // preventScreenshotOn: additionally blocks screenshot APIs on iOS.
      await ScreenProtector.protectDataLeakageOn();
      await ScreenProtector.preventScreenshotOn();
    } catch (e) {
      // Non-fatal — best-effort on platforms where the plugin has no impl.
      if (kDebugMode) debugPrint('ScreenProtector init skipped: $e');
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      // Save battery: disconnect WebSocket and stop connectivity polling
      WebSocketService.instance.disconnect();
      ConnectivityService.stopMonitoring();
    } else if (state == AppLifecycleState.resumed) {
      // Reconnect when the app comes back to foreground
      ConnectivityService.startMonitoring();
      WebSocketService.instance.connect();
      // HealthKit / Google Health Connect: fire-and-forget delta sync. Noop if
      // the user never granted permissions (service requests them on first call).
      unawaited(HealthSyncService.instance.syncNow());
    }
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ChangeNotifierProvider(create: (_) => LanguageProvider()),
        ChangeNotifierProvider(create: (_) => NotificationProvider()),
        ChangeNotifierProvider(create: (_) => UserProvider()),
        ChangeNotifierProvider(create: (_) => DependentsProvider()),
        ChangeNotifierProvider(create: (_) => WebSocketProvider()..listen()),
        // Realtime fabric lifecycle owner. Widgets listen via
        // `context.read<RealtimeProvider>().events(channel)` instead of
        // calling `RealtimeClient.instance.connect()` directly.
        ChangeNotifierProvider(
          create: (_) => RealtimeProvider()..ensureConnected(),
        ),
        ChangeNotifierProvider(
          create: (_) => SessionTimeoutProvider(
            timeoutDuration: const Duration(minutes: 30),
          ),
          // Don't call startTracking() here — timer should only start
          // after successful login. The router redirect starts it when
          // navigating an authenticated user to /home.
        ),
      ],
      child: Consumer2<ThemeProvider, LanguageProvider>(
        builder: (context, themeProv, langProv, _) {
          // Track user activity for idle timeout
          return Listener(
            onPointerDown: (_) {
              final user = context.read<UserProvider>();
              if (!user.isGuest) {
                context.read<SessionTimeoutProvider>().recordActivity();
              }
            },
            child: MaterialApp.router(
              debugShowCheckedModeBanner: false,
              title: 'VH Health',
              themeMode: themeProv.themeMode,
              theme: themeProv.lightTheme,
              darkTheme: themeProv.darkTheme,
              locale: langProv.locale,
              supportedLocales: AppLocalizations.supportedLocales,
              localizationsDelegates: const [
                AppLocalizations.delegate,
                GlobalMaterialLocalizations.delegate,
                GlobalWidgetsLocalizations.delegate,
                GlobalCupertinoLocalizations.delegate,
              ],
              routerConfig: AppRouter.router,
              // Listens for `session:revoked` realtime events (pushed
              // when this account just logged in elsewhere) and forces
              // a clean logout + redirect to /login. Lives in the
              // MaterialApp builder so a ScaffoldMessenger is reachable
              // for the snackbar.
              builder: (context, child) => SessionRevocationListener(
                child: child ?? const SizedBox.shrink(),
              ),
            ),
          );
        },
      ),
    );
  }
}
