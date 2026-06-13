import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:screen_protector/screen_protector.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:sentry_flutter/sentry_flutter.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart' as sqflite_ffi;
import 'firebase_options.dart';
import 'core/platform_info.dart';
import 'core/config/observability_config.dart';
import 'core/navigation/app_router.dart';
import 'core/providers/message_unread_provider.dart';
import 'core/providers/notification_provider.dart';
import 'core/providers/locale_provider.dart';
import 'core/providers/theme_provider.dart';
import 'core/utils/font_scale.dart';
import 'core/providers/session_timeout_provider.dart';
import 'core/providers/websocket_provider.dart';
import 'core/services/code_blue_notifier.dart';
import 'core/services/composite_crash_reporter.dart';
import 'core/services/connectivity_sync_service.dart';
import 'core/services/firebase_crash_reporter.dart';
import 'core/services/phi_scrubber.dart';
import 'core/services/sentry_crash_reporter.dart';
import 'core/services/websocket_service.dart';
import 'core/widgets/patient_search_sheet.dart';
import 'features/emr/widgets/patient_summary_sheet.dart';
import 'core/widgets/session_revocation_listener.dart';
import 'l10n/app_strings.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth_core/vhhealth_core.dart'
    show RealtimeProvider, SecurityConfig, VHHttpClient;
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
  // Fail fast on misconfigured production builds (audit finding H7): throws
  // when PRODUCTION=true but CERT_PIN_HASHES is missing/malformed, so an
  // unpinned clinical build can never ship.
  SecurityConfig.verifyOrWarn();
  VHHttpClient.deviceTypeProvider = () => currentDeviceType;

  // One-screen patient summary (roadmap E5): the global patient search
  // (magnifier on every app bar / Ctrl+K) offers a summary shortcut per
  // result row. Injected here so the core widget stays feature-free.
  PatientSearchSheet.summaryOpener =
      (context, {required patientUid, patientName}) => PatientSummarySheet.show(
        context,
        patientUid: patientUid,
        patientName: patientName,
      );

  // Desktop platforms (Windows/Linux/macOS) need the sqflite FFI bridge
  // wired before any DB-touching code runs (OfflineQueue, ConnectivitySync-
  // Service, etc.). Mobile (Android/iOS) uses the default native plugin
  // and skips this. Web isn't supported by sqflite at all — kIsWeb gate.
  if (!kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS)) {
    sqflite_ffi.sqfliteFfiInit();
    sqflite_ffi.databaseFactory = sqflite_ffi.databaseFactoryFfi;
  }

  final enableSentry = ObservabilityConfig.sentryEnabled;
  if (enableSentry) {
    await SentryFlutter.init((options) {
      options.dsn = ObservabilityConfig.sentryDsn;
      options.environment = ObservabilityConfig.sentryEnvironment;
      if (ObservabilityConfig.sentryRelease.isNotEmpty) {
        options.release = ObservabilityConfig.sentryRelease;
      }
      options.tracesSampleRate = ObservabilityConfig.sentryTracesSampleRate;
      options.sendDefaultPii = false;
      options.attachStacktrace = true;
      options.attachScreenshot = false;
      options.enableUserInteractionBreadcrumbs = false;
      options.enableUserInteractionTracing = false;
      options.beforeSend = SentryCrashReporter.scrubEvent;
      options.beforeSendTransaction = SentryCrashReporter.scrubTransaction;
      options.beforeBreadcrumb = SentryCrashReporter.scrubBreadcrumb;
      options.tracePropagationTargets
        ..clear()
        ..addAll([
          'api.vhhealth.app',
          'clinical.vhhealth',
          '127.0.0.1',
          'localhost',
        ]);
    });
  }

  // Firebase (core init + messaging + crashlytics) has no Flutter desktop
  // implementation — skip the whole stack on Windows/Linux/macOS. Desktop
  // staff workstations get realtime delivery over the WebSocket fabric.
  if (!isDesktopPlatform) {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );
  }
  // Crashlytics is disabled when explicitly opted out OR on any desktop
  // build (no platform implementation) — folding both into one flag means
  // every `!disableCrashlytics` guard below covers desktop automatically.
  final disableCrashlytics =
      const bool.fromEnvironment('VH_DISABLE_CRASHLYTICS') || isDesktopPlatform;

  // Route non-fatal errors from core + app through one reporting abstraction.
  // Desktop/web builds can use Sentry; mobile builds can use Firebase
  // Crashlytics; both receive the same PHI-scrubbed payloads.
  final crashReporters = <CrashReporter>[
    if (enableSentry) const SentryCrashReporter(),
    if (!disableCrashlytics) const FirebaseCrashReporter(),
  ];
  if (crashReporters.length == 1) {
    CrashReporter.install(crashReporters.single);
  } else if (crashReporters.length > 1) {
    CrashReporter.install(CompositeCrashReporter(crashReporters));
  }
  final crashReportingEnabled = crashReporters.isNotEmpty;

  // Register the terminated/background Code Blue handler *before* any foreground
  // plumbing so notifications fire even if the app hasn't been opened this session.
  // firebase_messaging has no desktop implementation — desktop staff
  // workstations receive Code Blue over the WebSocket staff:code-blue channel.
  if (!isDesktopPlatform) {
    FirebaseMessaging.onBackgroundMessage(_fcmBackgroundHandler);
  }
  await CodeBlueNotifier.instance.initialize();

  // Strip potential PHI from error messages before sending to crash reporting.
  if (crashReportingEnabled) {
    FlutterError.onError = (FlutterErrorDetails details) {
      final sanitised = FlutterErrorDetails(
        exception: PhiScrubber.sanitizeError(details.exception),
        stack: details.stack,
        library: details.library,
        context: details.context,
        silent: details.silent,
      );
      _recordFlutterFatalError(sanitised);
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
                        ? PhiScrubber.scrubText(details.exceptionAsString())
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
      final app = enableSentry
          ? SentryWidget(child: const VHHealthStaffApp())
          : const VHHealthStaffApp();
      runApp(app);
    },
    (error, stack) {
      if (crashReportingEnabled) {
        _recordAsyncFatalError(error, stack);
      } else if (kDebugMode) {
        debugPrint('Uncaught async error: ${PhiScrubber.sanitizeError(error)}');
      }
    },
  );
}

void _recordFlutterFatalError(FlutterErrorDetails details) {
  try {
    unawaited(
      CrashReporter.instance
          .recordError(
            details.exception,
            details.stack,
            context: details.context?.toString(),
            extra: {'library': details.library},
            fatal: true,
          )
          .catchError((Object e) {
            if (kDebugMode) {
              debugPrint('Crash reporter Flutter error recording failed: $e');
            }
          }),
    );
  } catch (e) {
    if (kDebugMode) {
      debugPrint('Crash reporter Flutter error recording failed: $e');
    }
  }
}

void _recordAsyncFatalError(Object error, StackTrace stack) {
  try {
    unawaited(
      CrashReporter.instance
          .recordError(
            PhiScrubber.sanitizeError(error),
            stack,
            context: 'uncaught async error',
            fatal: true,
          )
          .catchError((Object e) {
            if (kDebugMode) {
              debugPrint('Crash reporter async error recording failed: $e');
            }
          }),
    );
  } catch (e) {
    if (kDebugMode) {
      debugPrint('Crash reporter async error recording failed: $e');
    }
  }
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
    // STF-1: block screenshots and suppress the app-switcher thumbnail
    // so clinical PHI cannot leak via Android recents or iOS Exposé.
    _applyScreenProtection();
  }

  Future<void> _applyScreenProtection() async {
    try {
      await ScreenProtector.protectDataLeakageOn();
      await ScreenProtector.preventScreenshotOn();
    } catch (e) {
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
        ChangeNotifierProvider(create: (_) => LocaleProvider()),
        ChangeNotifierProvider(create: (_) => NotificationProvider()),
        ChangeNotifierProvider(create: (_) => WebSocketProvider()..init()),
        // Realtime fabric lifecycle owner. Widgets should listen via
        // `context.read<RealtimeProvider>().events(channel)` instead of
        // calling `RealtimeClient.instance.connect()` directly.
        ChangeNotifierProvider(
          create: (_) => RealtimeProvider()..ensureConnected(),
        ),
        ChangeNotifierProvider(create: (_) => MessageUnreadProvider()..start()),
        ChangeNotifierProvider(
          create: (_) => SessionTimeoutProvider(
            timeoutDuration: sessionTimeoutForDeviceMode(currentAppDeviceMode),
          ),
          // Don't call startTracking() here — timer should only start
          // after successful login, not on the login screen.
          // The login flow should call provider.startTracking().
        ),
      ],
      child: Consumer<ThemeProvider>(
        builder: (context, themeProvider, _) {
          // Wrap in a Listener to detect user interaction for idle timeout
          final sessionTimeout = context.read<SessionTimeoutProvider>();
          void recordActivity() => sessionTimeout.recordActivity();

          return Focus(
            onKeyEvent: (_, event) {
              if (event is KeyDownEvent || event is KeyRepeatEvent) {
                recordActivity();
              }
              return KeyEventResult.ignored;
            },
            child: Listener(
              onPointerDown: (_) {
                recordActivity();
              },
              onPointerSignal: (_) {
                recordActivity();
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
                    // In-app language override (Settings → Language).
                    // null = follow the device locale, the historical
                    // behaviour (roadmap E2).
                    locale: context.watch<LocaleProvider>().locale,
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
                    // Listens for `session:revoked` realtime events (pushed
                    // when this account just logged in elsewhere) and kicks
                    // to /login immediately, rather than waiting for the
                    // next API call to 401. Lives in the MaterialApp
                    // builder so a ScaffoldMessenger is reachable for the
                    // snackbar.
                    //
                    // The MediaQuery wrapper composes the OS text scale
                    // with the in-app font-size preference (Settings →
                    // Appearance → Font size) so every text style —
                    // including hard-coded chip/pill fontSizes — scales
                    // together (roadmap E3, A11y #9).
                    builder: (context, child) {
                      final mq = MediaQuery.of(context);
                      final factor = composeTextScaleFactor(
                        systemFactor: mq.textScaler.scale(14) / 14,
                        userPt: themeProvider.fontSize,
                      );
                      return MediaQuery(
                        data: mq.copyWith(
                          textScaler: TextScaler.linear(factor),
                        ),
                        child: StaffMessageAlertListener(
                          child: SessionRevocationListener(
                            child: child ?? const SizedBox.shrink(),
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
