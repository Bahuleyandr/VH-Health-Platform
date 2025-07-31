import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'package:firebase_core/firebase_core.dart';

// Firebase Options (do not modify)
import 'firebase_options.dart';

// Core App Providers
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';

// App Utilities
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/app/routes.dart';

// Screens
import 'package:vhhealth/features/splash/screens/splash_screen.dart';

// Optional: for direct OTP testing during development
// import 'otp_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform,
  );
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
      ],
      child: Consumer2<ThemeProvider, LanguageProvider>(
        builder: (context, themeProv, langProv, _) {
          return MaterialApp(
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
            initialRoute: '/',
            routes: appRoutes,
            onGenerateInitialRoutes: (_) =>
                [MaterialPageRoute(builder: (_) => const SplashScreen())],
            onUnknownRoute: (_) => MaterialPageRoute(
              builder: (_) => const Scaffold(
                body: Center(child: Text('404 - Page not found')),
              ),
            ),
          );
        },
      ),
    );
  }
}
