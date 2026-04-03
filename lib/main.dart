import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';

// Firebase Options
import 'firebase_options.dart';

// Core App Providers
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';

// App Router
import 'package:vhhealth/core/navigation/app_router.dart';

// Core Services
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/connectivity_service.dart';
import 'package:vhhealth/core/services/websocket_service.dart';

// App Utilities
import 'package:vhhealth/generated/app_localizations.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform,
  );

  // Pass all uncaught Flutter framework errors to Crashlytics.
  FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;

  // Wire 401 handler: when any API call returns Unauthorized, redirect to login.
  ApiClient.onSessionExpired = (message) {
    AppRouter.clearUserData();
    AppRouter.router.go('/login');
  };

  // Start network connectivity monitoring.
  ConnectivityService.startMonitoring();

  // Connect the WebSocket service for real-time updates.
  WebSocketService.instance.connect();

  // Catch async errors not handled by Flutter framework.
  runZonedGuarded(() {
    runApp(const VHRoot());
  }, (error, stack) {
    FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
  });
}

class VHRoot extends StatelessWidget {
  const VHRoot({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ChangeNotifierProvider(create: (_) => LanguageProvider()),
        ChangeNotifierProvider(create: (_) => NotificationProvider()),
        ChangeNotifierProvider(create: (_) => UserProvider()),
        ChangeNotifierProvider(create: (_) => WebSocketProvider()..listen()),
      ],
      child: Consumer2<ThemeProvider, LanguageProvider>(
        builder: (context, themeProv, langProv, _) {
          return MaterialApp.router(
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
          );
        },
      ),
    );
  }
}