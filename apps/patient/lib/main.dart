import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:vhhealth_core/vhhealth_core.dart' show ApiConfig;

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
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  const crashlyticsEnabled = !bool.fromEnvironment(
    'VH_DISABLE_CRASHLYTICS',
    defaultValue: false,
  );

  // When running in debug mode against a non-production backend
  // (e.g. http://127.0.0.1:5206 for local QA), disable Firebase phone-auth
  // reCAPTCHA verification. The dev hostname is not in the Firebase project's
  // authorised-domains list, so reCAPTCHA Enterprise config calls return 403
  // and the OTP entry screen stalls indefinitely.
  // appVerificationDisabledForTesting lets test phone numbers (configured
  // in the Firebase console) skip the reCAPTCHA path entirely; it is a
  // strict no-op against api.vhhealth.app where the domain is authorised.
  if (kDebugMode && ApiConfig.baseUrl.startsWith('http://')) {
    try {
      await FirebaseAuth.instance.setSettings(
        appVerificationDisabledForTesting: true,
      );
    } catch (e) {
      debugPrint('Firebase test-mode setSettings skipped: $e');
    }
  }

  // Install the Firebase-backed crash reporter so core + app code all route
  // non-fatal errors through the same abstraction.
  if (crashlyticsEnabled) {
    CrashReporter.install(const FirebaseCrashReporter());

    // Pass all uncaught Flutter framework errors to Crashlytics.
    FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;
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
      final jwt = await const FlutterSecureStorage().read(key: 'jwt');
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

  // Catch async errors not handled by Flutter framework.
  runZonedGuarded(
    () {
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
