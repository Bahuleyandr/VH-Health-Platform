import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart' as sqflite_ffi;
import 'firebase_options.dart';
import 'core/navigation/app_router.dart';
import 'core/providers/notification_provider.dart';
import 'core/providers/theme_provider.dart';
import 'core/providers/session_timeout_provider.dart';
import 'core/providers/websocket_provider.dart';
import 'core/services/code_blue_notifier.dart';
import 'core/services/connectivity_sync_service.dart';
import 'core/services/firebase_crash_reporter.dart';
import 'core/services/websocket_service.dart';
import 'core/widgets/patient_search_sheet.dart';
import 'l10n/app_strings.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth_core/vhhealth_core.dart' show RealtimeProvider;
import 'package:firebase_messaging/firebase_messaging.dart';

/// Background FCM handler for Code Blue data messages. Must be a top-level
/// function (not a closure or class method) so Flutter can spawn it in a new
/// isolate when the app is terminated. Ensures the high-importance notification
/// is shown even without a live app process.
/// Intent fired by Ctrl+K / Cmd+K — opens the global patient picker.
class _OpenPatientPickerIntent extends Intent {
  const _OpenPatientPickerIntent();
}

/// Intent fired by Esc — pops the topmost route if any (sheets, dialogs).
class _DismissTopRouteIntent extends Intent {
  const _DismissTopRouteIntent();
}

@pragma('vm:entry-point')
Future<void> _fcmBackgroundHandler(RemoteMessage message) async {
  if (message.data['type'] != 'code_blue') return;
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  await CodeBlueNotifier.instance.initialize();
  await CodeBlueNotifier.instance.showForMessage(message);
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Desktop platforms (Windows/Linux/macOS) need the sqflite FFI bridge
  // wired before any DB-touching code runs (OfflineQueue, ConnectivitySync-
  // Service, etc.). Mobile (Android/iOS) uses the default native plugin
  // and skips this. Web isn't supported by sqflite at all — kIsWeb gate.
  if (!kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS)) {
    sqflite_ffi.sqfliteFfiInit();
    sqflite_ffi.databaseFactory = sqflite_ffi.databaseFactoryFfi;
  }

  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  const disableCrashlytics = bool.fromEnvironment('VH_DISABLE_CRASHLYTICS');

  // Route non-fatal errors from core + app through the same Crashlytics-backed
  // reporter. Fatal errors are still handled via FlutterError.onError below.
  if (!disableCrashlytics) {
    CrashReporter.install(const FirebaseCrashReporter());
  }

  // Register the terminated/background Code Blue handler *before* any foreground
  // plumbing so notifications fire even if the app hasn't been opened this session.
  FirebaseMessaging.onBackgroundMessage(_fcmBackgroundHandler);
  await CodeBlueNotifier.instance.initialize();

  // Strip potential PHI from error messages before sending to Crashlytics.
  // Phone numbers, patient names, or medical data may appear in stack traces.
  if (!disableCrashlytics) {
    FlutterError.onError = (FlutterErrorDetails details) {
      final sanitised = FlutterErrorDetails(
        exception: _sanitiseForCrashlytics(details.exception),
        stack: details.stack,
        library: details.library,
        context: details.context,
        silent: details.silent,
      );
      _recordCrashlyticsFlutterFatalError(sanitised);
    };
  }

  // Global error widget — shows a friendly message instead of red screen
  ErrorWidget.builder = (FlutterErrorDetails details) {
    return Material(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Builder(
            builder: (context) {
              // We use a Builder so the AppStrings lookup happens inside a
              // localised subtree. If the error is so early that
              // localisations aren't yet attached, AppStrings falls back to
              // English values defined in code.
              final s = AppStrings.of(context);
              return Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.error_outline, size: 48, color: Colors.red),
                  const SizedBox(height: 12),
                  Text(
                    s.errorSomethingWentWrong,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    kDebugMode
                        ? details.exceptionAsString()
                        : s.errorRestartOrContact,
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 12, color: Colors.grey),
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  };

  // Start connectivity monitoring and sync any queued offline writes.
  ConnectivitySyncService.instance.startListening();
  ConnectivitySyncService.instance.syncPending();

  // Catch async errors not handled by Flutter framework.
  runZonedGuarded(
    () {
      runApp(const VHHealthStaffApp());
    },
    (error, stack) {
      if (!disableCrashlytics) {
        _recordCrashlyticsAsyncError(error, stack);
      } else if (kDebugMode) {
        debugPrint('Uncaught async error: ${_sanitiseForCrashlytics(error)}');
      }
    },
  );
}

void _recordCrashlyticsFlutterFatalError(FlutterErrorDetails details) {
  try {
    unawaited(
      FirebaseCrashlytics.instance.recordFlutterFatalError(details).catchError((
        Object e,
      ) {
        if (kDebugMode) {
          debugPrint('Crashlytics Flutter error recording failed: $e');
        }
      }),
    );
  } catch (e) {
    if (kDebugMode) {
      debugPrint('Crashlytics Flutter error recording failed: $e');
    }
  }
}

void _recordCrashlyticsAsyncError(Object error, StackTrace stack) {
  try {
    unawaited(
      FirebaseCrashlytics.instance
          .recordError(_sanitiseForCrashlytics(error), stack, fatal: true)
          .catchError((Object e) {
            if (kDebugMode) {
              debugPrint('Crashlytics async error recording failed: $e');
            }
          }),
    );
  } catch (e) {
    if (kDebugMode) {
      debugPrint('Crashlytics async error recording failed: $e');
    }
  }
}

/// Redact potential PHI (phone numbers, emails) from error messages
/// before they are sent to Firebase Crashlytics.
Object _sanitiseForCrashlytics(Object error) {
  final msg = error.toString();
  // Mask 10-digit phone numbers and common Indian formats (+91...)
  final redacted = msg
      .replaceAll(RegExp(r'\+?\d{10,13}'), '[REDACTED_PHONE]')
      .replaceAll(
        RegExp(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'),
        '[REDACTED_EMAIL]',
      );
  if (redacted == msg) return error; // nothing to redact
  return Exception(redacted);
}

class VHHealthStaffApp extends StatefulWidget {
  const VHHealthStaffApp({super.key});

  @override
  State<VHHealthStaffApp> createState() => _VHHealthStaffAppState();
}

class _VHHealthStaffAppState extends State<VHHealthStaffApp>
    with WidgetsBindingObserver {
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
      // Save battery: disconnect WebSocket when app is backgrounded
      WebSocketService.instance.disconnect();
      ConnectivitySyncService.instance.stopListening();
    } else if (state == AppLifecycleState.resumed) {
      // Reconnect when the app comes back to foreground
      ConnectivitySyncService.instance.startListening();
      WebSocketService.instance.connect();
    }
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ChangeNotifierProvider(create: (_) => NotificationProvider()),
        ChangeNotifierProvider(create: (_) => WebSocketProvider()..init()),
        // Realtime fabric lifecycle owner. Widgets should listen via
        // `context.read<RealtimeProvider>().events(channel)` instead of
        // calling `RealtimeClient.instance.connect()` directly.
        ChangeNotifierProvider(
          create: (_) => RealtimeProvider()..ensureConnected(),
        ),
        ChangeNotifierProvider(
          create: (_) => SessionTimeoutProvider(
            timeoutDuration: const Duration(minutes: 15),
          ),
          // Don't call startTracking() here — timer should only start
          // after successful login, not on the login screen.
          // The login flow should call provider.startTracking().
        ),
      ],
      child: Consumer<ThemeProvider>(
        builder: (context, themeProvider, _) {
          // Wrap in a Listener to detect user interaction for idle timeout
          return Listener(
            onPointerDown: (_) {
              context.read<SessionTimeoutProvider>().recordActivity();
            },
            // Global keyboard shortcuts. Ctrl+K (Cmd+K on macOS) opens
            // the patient picker from anywhere in the app. Esc closes
            // the topmost route (sheet / dialog) when there's something
            // to pop. F5 reloads the current route via the router. The
            // Shortcuts widget MUST sit above MaterialApp so the
            // bindings get a chance to handle the key event before
            // descendant widgets consume it.
            child: Shortcuts(
              shortcuts: <ShortcutActivator, Intent>{
                const SingleActivator(LogicalKeyboardKey.keyK, control: true):
                    const _OpenPatientPickerIntent(),
                const SingleActivator(LogicalKeyboardKey.keyK, meta: true):
                    const _OpenPatientPickerIntent(),
                const SingleActivator(LogicalKeyboardKey.escape):
                    const _DismissTopRouteIntent(),
              },
              child: Actions(
                actions: <Type, Action<Intent>>{
                  _OpenPatientPickerIntent:
                      CallbackAction<_OpenPatientPickerIntent>(
                        onInvoke: (_) {
                          final ctx = rootNavigatorKey.currentContext;
                          if (ctx != null) {
                            PatientSearchSheet.show(ctx);
                          }
                          return null;
                        },
                      ),
                  _DismissTopRouteIntent:
                      CallbackAction<_DismissTopRouteIntent>(
                        onInvoke: (_) {
                          final nav = rootNavigatorKey.currentState;
                          if (nav != null && nav.canPop()) nav.pop();
                          return null;
                        },
                      ),
                },
                child: MaterialApp.router(
                  title: 'VHHealth Staff',
                  debugShowCheckedModeBanner: false,
                  theme: themeProvider.lightTheme,
                  darkTheme: themeProvider.darkTheme,
                  themeMode: themeProvider.themeMode,
                  // Localization delegates wire built-in Material/
                  // Cupertino translations (date pickers, drawer back
                  // button, etc.) for the supported locales. App-
                  // specific strings live in `lib/l10n/app_strings.dart`
                  // and are accessed via `AppStrings.of(context)`.
                  localizationsDelegates: const [
                    GlobalMaterialLocalizations.delegate,
                    GlobalWidgetsLocalizations.delegate,
                    GlobalCupertinoLocalizations.delegate,
                  ],
                  supportedLocales: AppStrings.supportedLocales,
                  routerConfig: appRouter,
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
