import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'firebase_options.dart';
import 'core/navigation/app_router.dart';
import 'core/providers/notification_provider.dart';
import 'core/providers/theme_provider.dart';
import 'core/providers/session_timeout_provider.dart';
import 'core/providers/websocket_provider.dart';
import 'core/services/code_blue_notifier.dart';
import 'core/services/connectivity_sync_service.dart';
import 'core/services/websocket_service.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

/// Background FCM handler for Code Blue data messages. Must be a top-level
/// function (not a closure or class method) so Flutter can spawn it in a new
/// isolate when the app is terminated. Ensures the high-importance notification
/// is shown even without a live app process.
@pragma('vm:entry-point')
Future<void> _fcmBackgroundHandler(RemoteMessage message) async {
  if (message.data['type'] != 'code_blue') return;
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  await CodeBlueNotifier.instance.initialize();
  await CodeBlueNotifier.instance.showForMessage(message);
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);

  // Register the terminated/background Code Blue handler *before* any foreground
  // plumbing so notifications fire even if the app hasn't been opened this session.
  FirebaseMessaging.onBackgroundMessage(_fcmBackgroundHandler);
  await CodeBlueNotifier.instance.initialize();

  // Strip potential PHI from error messages before sending to Crashlytics.
  // Phone numbers, patient names, or medical data may appear in stack traces.
  FlutterError.onError = (FlutterErrorDetails details) {
    final sanitised = FlutterErrorDetails(
      exception: _sanitiseForCrashlytics(details.exception),
      stack: details.stack,
      library: details.library,
      context: details.context,
      silent: details.silent,
    );
    FirebaseCrashlytics.instance.recordFlutterFatalError(sanitised);
  };

  // Global error widget — shows a friendly message instead of red screen
  ErrorWidget.builder = (FlutterErrorDetails details) {
    return Material(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 48, color: Colors.red),
              const SizedBox(height: 12),
              const Text(
                'Something went wrong',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 4),
              Text(
                kDebugMode
                    ? details.exceptionAsString()
                    : 'Please restart the app or contact support.',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 12, color: Colors.grey),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  };

  // Start connectivity monitoring and sync any queued offline writes.
  ConnectivitySyncService.instance.startListening();
  ConnectivitySyncService.instance.syncPending();

  // Catch async errors not handled by Flutter framework.
  runZonedGuarded(() {
    runApp(const VHHealthStaffApp());
  }, (error, stack) {
    FirebaseCrashlytics.instance.recordError(
      _sanitiseForCrashlytics(error),
      stack,
      fatal: true,
    );
  });
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
            child: MaterialApp.router(
              title: 'VHHealth Staff',
              debugShowCheckedModeBanner: false,
              theme: themeProvider.lightTheme,
              darkTheme: themeProvider.darkTheme,
              themeMode: themeProvider.themeMode,
              routerConfig: appRouter,
            ),
          );
        },
      ),
    );
  }
}
