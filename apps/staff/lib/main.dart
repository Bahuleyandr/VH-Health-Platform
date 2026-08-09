import 'dart:async';
import 'dart:io' show Platform;
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:screen_protector/screen_protector.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:sentry_flutter/sentry_flutter.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart' as sqflite_ffi;
import 'firebase_options.dart';
import 'core/config/c0a_reconciliation_config.dart';
import 'core/platform_info.dart';
import 'core/config/observability_config.dart';
import 'core/navigation/app_router.dart';
import 'core/providers/clinical_inbox_provider.dart';
import 'core/providers/message_unread_provider.dart';
import 'core/providers/notification_provider.dart';
import 'core/providers/locale_provider.dart';
import 'core/providers/theme_provider.dart';
import 'core/utils/font_scale.dart';
import 'core/providers/session_timeout_provider.dart';
import 'core/providers/websocket_provider.dart';
import 'core/services/code_blue_notifier.dart';
import 'core/services/composite_crash_reporter.dart';
import 'core/services/api_client.dart';
import 'core/services/connectivity_sync_service.dart';
import 'core/services/firebase_crash_reporter.dart';
import 'core/services/phi_scrubber.dart';
import 'core/services/staff_local_notifications.dart';
import 'core/services/staff_clinical_action_gateway.dart';
import 'core/services/staff_action_policy_repository.dart';
import 'core/services/staff_action_policy_source.dart';
import 'core/services/sentry_crash_reporter.dart';
import 'core/services/windows_screen_capture.dart';
import 'core/widgets/patient_search_sheet.dart';
import 'core/widgets/logout_flow.dart';
import 'core/widgets/session_timeout_warning_layer.dart';
import 'features/emr/widgets/patient_summary_sheet.dart';
import 'features/clinical_continuity/services/staff_continuity_repository.dart';
import 'core/widgets/session_revocation_listener.dart';
import 'l10n/app_strings.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth_core/models/clinical_continuity.dart';
import 'package:vhhealth_core/config/client_readiness_config.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/clinical_continuity_facility_context.dart';
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

final _staffScaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();

@pragma('vm:entry-point')
Future<void> _fcmBackgroundHandler(RemoteMessage message) async {
  if (message.data['type'] != 'code_blue') return;
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  await CodeBlueNotifier.instance.initialize();
  await CodeBlueNotifier.instance.showForMessage(message);
}

void _handleServerSessionExpired() {
  SessionTimeoutProvider? timeout;
  final navigatorContext = rootNavigatorKey.currentContext;
  if (navigatorContext != null) {
    try {
      timeout = navigatorContext.read<SessionTimeoutProvider>();
    } catch (_) {}
  }

  unawaited(
    ForcedLogoutFlow.run(
      stopSessionTracking: timeout?.stopTracking,
      navigateToLogin: () => appRouter.go('/login'),
      reportPreservedItems: _reportPreservedOfflineItems,
    ).catchError((Object error, StackTrace stack) {
      if (kDebugMode) {
        debugPrint('Forced session-expiry cleanup failed: $error');
      }
    }),
  );
}

void _reportPreservedOfflineItems(int count) {
  void show() {
    final messenger = _staffScaffoldMessengerKey.currentState;
    if (messenger == null) return;
    final strings = AppStrings.of(messenger.context);
    messenger
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          content: Text(strings.sessionRevocationPreservedItems(count)),
          duration: const Duration(seconds: 6),
        ),
      );
  }

  if (_staffScaffoldMessengerKey.currentState == null) {
    WidgetsBinding.instance.addPostFrameCallback((_) => show());
  } else {
    show();
  }
}

Future<void> main() async {
  // Assigned during setup inside the guarded zone; declared out here so the
  // zone's error handler can read it (mirrors the patient app's main).
  var crashReportingEnabled = false;

  await runZonedGuarded<Future<void>>(
    () async {
      // The binding must be initialised in the same zone that later calls
      // runApp — splitting them across zones trips BindingBase.debugCheckZone
      // and surfaced as "Early crashes" in Crashlytics.
      WidgetsFlutterBinding.ensureInitialized();
      C0AReconciliationConfig.registerBeforeQueueStartup();
      ApiClient.onSessionExpired = (_) => _handleServerSessionExpired();
      // Fail fast on misconfigured production builds (audit finding H7): throws
      // when PRODUCTION=true but CERT_PIN_HASHES is missing/malformed, so an
      // unpinned clinical build can never ship.
      SecurityConfig.verifyOrWarn();
      // Fail fast on a build stamped for a tenant it cannot match. ClientReadiness
      // Service compares the server's tenant to TenantConfig.id with a strict ==,
      // so a mis-stamp pins the client in a readiness outage against a healthy
      // backend. Refusing to launch is the louder, safer failure.
      TenantConfig.verifyOrThrow();
      // Production builds must carry the owner-approved readiness clock-skew
      // tolerance. Without this call the guard was dead code and a build with the
      // wrong value silently fell back to the bundled default, so the
      // owner-approved bound was never actually enforced on the artifact.
      ClientReadinessConfig.verifyOrThrow();
      VHHttpClient.deviceTypeProvider = () => currentDeviceType;

      // One-screen patient summary (roadmap E5): the global patient search
      // (magnifier on every app bar / Ctrl+K) offers a summary shortcut per
      // result row. Injected here so the core widget stays feature-free.
      PatientSearchSheet.summaryOpener =
          (context, {required patientUid, patientName}) =>
              PatientSummarySheet.show(
                context,
                patientUid: patientUid,
                patientName: patientName,
              );

      // Desktop platforms (Windows/Linux/macOS) need the sqflite FFI bridge
      // wired before any DB-touching code runs (OfflineQueue, ConnectivitySync-
      // Service, etc.). Mobile (Android/iOS) uses the default native plugin
      // and skips this. Web isn't supported by sqflite at all — kIsWeb gate.
      if (!kIsWeb &&
          (Platform.isWindows || Platform.isLinux || Platform.isMacOS)) {
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

        // Activate Firebase App Check so Firebase-backed surfaces (FCM,
        // Crashlytics) can attest that requests come from a genuine, unmodified
        // build. Mirrors the patient app's PAT-1 activation.
        // - Release builds: Play Integrity (Android) / DeviceCheck (iOS).
        // - Debug AND profile builds (staging App Distribution ships
        //   debug-signed profile APKs that cannot pass real attestation):
        //   DebugProvider — register the printed token in the Firebase
        //   console under App Check → Apps → Manage debug tokens.
        // - Web (a real shipping target: dart2js CI lane + Dockerfile.web): a
        //   reCAPTCHA Enterprise site key must be supplied via
        //   --dart-define=VH_RECAPTCHA_SITE_KEY=... (see
        //   docs/runbooks/FIREBASE_KEY_ROTATION.md). Without one, activation is
        //   skipped entirely rather than attesting with a bogus key.
        // NOTE: release-mode Android/iOS attestation will not mint tokens until
        // the staff package/bundle IDs are registered as their own Firebase apps
        // (they currently reuse the patient registrations — see
        // firebase_options.dart and the runbook). Debug providers work regardless.
        const recaptchaSiteKey = String.fromEnvironment(
          'VH_RECAPTCHA_SITE_KEY',
        );
        if (kIsWeb && recaptchaSiteKey.isEmpty) {
          debugPrint(
            'FirebaseAppCheck.activate skipped on web: '
            'VH_RECAPTCHA_SITE_KEY dart-define is not set.',
          );
        } else {
          // Wrapped in try/catch so a provider misconfiguration never blocks
          // startup — App Check failures surface server-side once enforcement is
          // enabled in the Firebase console.
          try {
            await FirebaseAppCheck.instance.activate(
              providerAndroid: kReleaseMode
                  ? const AndroidPlayIntegrityProvider()
                  : const AndroidDebugProvider(),
              providerApple: kReleaseMode
                  ? const AppleDeviceCheckProvider()
                  : const AppleDebugProvider(),
              providerWeb: kIsWeb
                  ? ReCaptchaEnterpriseProvider(recaptchaSiteKey)
                  : null,
            );
            // Attach the attestation token to every backend API request —
            // only wired here, where activation actually ran (not desktop,
            // not web without a site key). Core's resolver is fail-open.
            VHHttpClient.appCheckTokenProvider = () =>
                FirebaseAppCheck.instance.getToken();
          } catch (e) {
            debugPrint('FirebaseAppCheck.activate skipped: $e');
          }
        }
      }
      // Crashlytics is disabled when explicitly opted out, in debug sessions
      // (debug-only framework asserts would otherwise be uploaded as fatal
      // crashes), OR on any desktop build (no platform implementation) —
      // folding all three into one flag means every `!disableCrashlytics`
      // guard below covers them automatically.
      final disableCrashlytics =
          const bool.fromEnvironment('VH_DISABLE_CRASHLYTICS') ||
          kDebugMode ||
          isDesktopPlatform;

      // Mirror the flag into the native Crashlytics SDK so natively-captured
      // events respect it too — and so collection turns off on debug devices
      // where a previous install left it enabled. firebase_crashlytics has no
      // desktop or web implementation, hence the platform gate.
      if (!isDesktopPlatform && !kIsWeb) {
        try {
          await FirebaseCrashlytics.instance.setCrashlyticsCollectionEnabled(
            !disableCrashlytics,
          );
        } catch (e) {
          debugPrint('Crashlytics collection toggle skipped: $e');
        }
      }

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
      crashReportingEnabled = crashReporters.isNotEmpty;

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
                      const Icon(
                        Icons.error_outline,
                        size: 48,
                        color: Colors.red,
                      ),
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
                        style: const TextStyle(
                          fontSize: 12,
                          color: Colors.grey,
                        ),
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

      StaffActionPolicyRepository.instance = StaffActionPolicyRepository(
        source: CompositeStaffActionPolicySource([
          BackendStaffActionPolicySource(),
          VerifiedPackStaffActionPolicySource(
            verifiedSetProvider: () =>
                StaffContinuityRepository.instance.currentSet,
            trustedClockProvider: () =>
                StaffContinuityRepository.instance.trustedClockAssessment,
          ),
        ]),
      );

      // Install the fail-closed signed-action decision before the queue can
      // inspect a prepared command. Delivery remains inert until AF has issued a
      // verified facility context or a complete v2 pack set is already verified.
      ConnectivitySyncService.instance.registerPreparedDrainGate(
        StaffClinicalActionGateway.instance.preparedDrainDecision,
      );

      // Start connectivity monitoring and sync any queued offline writes.
      ConnectivitySyncService.instance.startListening();
      unawaited(ConnectivitySyncService.instance.syncPending());

      final app = enableSentry
          ? SentryWidget(child: const VHHealthStaffApp())
          : const VHHealthStaffApp();
      runApp(app);
    },
    (error, stack) {
      // Catches async errors not handled by the Flutter framework.
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
  static const _policyRetryCeilings = <Duration>[
    Duration(seconds: 5),
    Duration(seconds: 15),
    Duration(seconds: 30),
    Duration(minutes: 1),
    Duration(minutes: 5),
  ];
  final Random _policyRefreshRandom = Random.secure();
  Timer? _policyPeriodicTimer;
  Timer? _policyRetryTimer;
  int _policyRetryIndex = 0;
  // Direct reference to the provider created in build's MultiProvider. The
  // State's own context sits ABOVE that MultiProvider, so
  // context.read<RealtimeProvider>() from lifecycle callbacks throws
  // ProviderNotFoundException — use this reference instead.
  RealtimeProvider? _realtimeProvider;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // STF-1: block screenshots and suppress the app-switcher thumbnail
    // so clinical PHI cannot leak via Android recents or iOS Exposé.
    _applyScreenProtection();
    unawaited(_refreshActionPolicy());
    _scheduleActionPolicyRefresh();
  }

  Future<void> _refreshActionPolicy() async {
    final context = await const ClinicalContinuityFacilityContextClient()
        .current();
    if (context == null) {
      _policyRetryTimer?.cancel();
      _policyRetryIndex = 0;
      StaffActionPolicyRepository.instance.invalidate(
        'facility_context_unavailable',
      );
      return;
    }
    final refreshed = await StaffActionPolicyRepository.instance.refresh(
      audience: ClinicalContinuityAudience(
        tenantId: context.tenantId,
        facilityId: context.facilityId,
      ),
    );
    if (refreshed) {
      _policyRetryTimer?.cancel();
      _policyRetryIndex = 0;
    } else if (StaffActionPolicyRepository.instance.retryableFailure) {
      _scheduleActionPolicyRetry();
    }
  }

  void _scheduleActionPolicyRefresh() {
    _policyPeriodicTimer?.cancel();
    final minutes = 13 + _policyRefreshRandom.nextInt(5);
    _policyPeriodicTimer = Timer(Duration(minutes: minutes), () {
      unawaited(_refreshActionPolicy());
      _scheduleActionPolicyRefresh();
    });
  }

  void _scheduleActionPolicyRetry() {
    if (_policyRetryTimer?.isActive ?? false) return;
    final ceiling =
        _policyRetryCeilings[min(
          _policyRetryIndex,
          _policyRetryCeilings.length - 1,
        )];
    _policyRetryIndex = min(
      _policyRetryIndex + 1,
      _policyRetryCeilings.length - 1,
    );
    final serverDelay = StaffActionPolicyRepository.instance.retryAfter;
    final delay =
        serverDelay ??
        Duration(
          milliseconds: _policyRefreshRandom.nextInt(
            ceiling.inMilliseconds + 1,
          ),
        );
    _policyRetryTimer = Timer(delay, () {
      _policyRetryTimer = null;
      unawaited(_refreshActionPolicy());
    });
  }

  Future<void> _applyScreenProtection() async {
    // Cross-platform plugin: covers Android (FLAG_SECURE) and iOS (recents
    // blur). It has NO Windows/Linux/macOS implementation.
    try {
      await ScreenProtector.protectDataLeakageOn();
      await ScreenProtector.preventScreenshotOn();
    } catch (e) {
      if (kDebugMode) debugPrint('ScreenProtector init skipped: $e');
    }

    // Windows desktop (audit 2026-06-18, STF-1): `screen_protector` is a no-op
    // on Windows, so apply native capture exclusion via our method channel.
    // Do NOT silently swallow a no-op — if protection cannot be applied on a
    // platform that handles PHI, log it loudly so the gap is visible.
    if (WindowsScreenCapture.isSupported) {
      final applied = await WindowsScreenCapture.enable();
      if (!applied) {
        debugPrint(
          'SECURITY WARNING: Windows screen-capture protection could NOT be '
          'applied — this PHI workbench is screenshot-able on this device.',
        );
        await CrashReporter.instance.recordError(
          StateError('Windows screen-capture protection unavailable'),
          StackTrace.current,
          context: 'screen-capture protection',
          fatal: false,
        );
      }
    } else if (!kIsWeb && (Platform.isLinux || Platform.isMacOS)) {
      // Known, accepted gap: no native capture exclusion implemented for
      // Linux/macOS desktop yet. Surface it rather than failing silently.
      debugPrint(
        'NOTE: screen-capture protection is not implemented on this desktop '
        'platform (${Platform.operatingSystem}); PHI may be screenshot-able.',
      );
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _policyPeriodicTimer?.cancel();
    _policyRetryTimer?.cancel();
    StaffActionPolicyRepository.instance.invalidate(
      'action_policy_repository_disposed',
    );
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    StaffLocalNotifications.instance.setWindowFocused(
      state == AppLifecycleState.resumed,
    );
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      ConnectivitySyncService.instance.stopListening();
      _policyPeriodicTimer?.cancel();
      _policyRetryTimer?.cancel();
      StaffActionPolicyRepository.instance.invalidate(
        'application_backgrounded',
      );
    } else if (state == AppLifecycleState.resumed) {
      ConnectivitySyncService.instance.startListening();
      unawaited(_refreshActionPolicy());
      _scheduleActionPolicyRefresh();
      unawaited(_realtimeProvider?.ensureConnected());
    }
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ChangeNotifierProvider(create: (_) => LocaleProvider()),
        ChangeNotifierProvider(create: (_) => NotificationProvider()),
        // Realtime fabric lifecycle owner. Widgets should listen via
        // `context.read<RealtimeProvider>().events(channel)` instead of
        // calling `RealtimeClient.instance.connect()` directly.
        ChangeNotifierProvider(
          create: (_) => _realtimeProvider = RealtimeProvider(
            onSessionExpired: _handleServerSessionExpired,
          )..ensureConnected(),
        ),
        ChangeNotifierProxyProvider<RealtimeProvider, WebSocketProvider>(
          create: (_) => WebSocketProvider(),
          update: (_, realtime, provider) =>
              (provider ?? WebSocketProvider())..bind(realtime),
        ),
        ChangeNotifierProvider(create: (_) => MessageUnreadProvider()..start()),
        ChangeNotifierProvider(create: (_) => ClinicalInboxProvider()..start()),
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
                    scaffoldMessengerKey: _staffScaffoldMessengerKey,
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
                            child: SessionTimeoutWarningLayer(
                              child: child ?? const SizedBox.shrink(),
                            ),
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
