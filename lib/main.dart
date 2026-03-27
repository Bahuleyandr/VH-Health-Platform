import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'package:firebase_core/firebase_core.dart';

// Firebase Options
import 'firebase_options.dart';

// Core App Providers
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';

// App Router
import 'package:vhhealth/core/navigation/app_router.dart';

// Core Services
import 'package:vhhealth/core/services/api_client.dart';

// App Utilities
import 'package:vhhealth/generated/app_localizations.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform,
  );

  // Wire 401 handler: when any API call returns Unauthorized, redirect to login.
  ApiClient.onSessionExpired = (message) {
    AppRouter.clearUserData();
    AppRouter.router.go('/login');
  };

  runApp(const VHRoot());
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