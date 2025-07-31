import 'package:flutter/material.dart';
import 'package:vhhealth/core/theme/app_theme.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/app/routes.dart';

class VHApp extends StatelessWidget {
  final ThemeMode themeMode;
  final double fontSize;
  final Locale? forcedLocale;

  const VHApp({
    super.key,
    required this.themeMode,
    required this.fontSize,
    this.forcedLocale,
  });

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'VH Health',
      debugShowCheckedModeBanner: false,
      themeMode: themeMode,
      theme: AppTheme.getLightTheme(fontSize),
      darkTheme: AppTheme.getDarkTheme(fontSize),

      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      locale: forcedLocale,
      localeResolutionCallback: (locale, supported) =>
          supported.contains(locale) ? locale : const Locale('en'),

      initialRoute: '/',
      routes: appRoutes,
    );
  }
}
