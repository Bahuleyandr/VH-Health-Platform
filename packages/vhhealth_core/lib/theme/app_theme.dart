import 'package:flutter/material.dart';

class AppTheme {
  static const Color primaryColor = Color(0xFF007A64);
  static const Color backgroundColor = Color(0xFFE0F5F6);
  static const Color onPrimaryColor = Colors.white;
  static const Color errorColor = Colors.redAccent;

  static const Color surfaceColor = Colors.white;
  static const Color onSurfaceColor = Colors.black87;

  static const Color darkBackgroundColor = Color(0xFF121212);
  static const Color darkSurfaceColor = Color(0xFF1E1E1E);
  static const Color darkOnSurfaceColor = Colors.white;

  static ThemeData getLightTheme(double baseFontSize) {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: primaryColor,
      brightness: Brightness.light,
    ).copyWith(
      surface: surfaceColor,
      onSurface: onSurfaceColor,
      error: errorColor,
      onError: Colors.white,
    );

    final textTheme = TextTheme(
      displayLarge: TextStyle(fontSize: baseFontSize + 18, fontWeight: FontWeight.w300, letterSpacing: -1.5, color: colorScheme.onSurface),
      displayMedium: TextStyle(fontSize: baseFontSize + 12, fontWeight: FontWeight.w300, letterSpacing: -0.5, color: colorScheme.onSurface),
      displaySmall: TextStyle(fontSize: baseFontSize + 8, fontWeight: FontWeight.w400, color: colorScheme.onSurface),
      headlineMedium: TextStyle(fontSize: baseFontSize + 6, fontWeight: FontWeight.w400, letterSpacing: 0.25, color: colorScheme.onSurface),
      headlineSmall: TextStyle(fontSize: baseFontSize + 4, fontWeight: FontWeight.bold, color: colorScheme.onSurface.withAlpha((0.9 * 255).toInt())),
      titleLarge: TextStyle(fontSize: baseFontSize + 2, fontWeight: FontWeight.w500, letterSpacing: 0.15, color: colorScheme.onSurface),
      titleMedium: TextStyle(fontSize: baseFontSize, fontWeight: FontWeight.w400, letterSpacing: 0.15, color: colorScheme.onSurface),
      titleSmall: TextStyle(fontSize: baseFontSize - 2, fontWeight: FontWeight.w500, letterSpacing: 0.1, color: colorScheme.onSurface),
      bodyLarge: TextStyle(fontSize: baseFontSize, fontWeight: FontWeight.w400, letterSpacing: 0.5, color: colorScheme.onSurface),
      bodyMedium: TextStyle(fontSize: baseFontSize - 2, fontWeight: FontWeight.w400, letterSpacing: 0.25, color: colorScheme.onSurface.withAlpha((0.85 * 255).toInt())),
      bodySmall: TextStyle(fontSize: baseFontSize - 4, fontWeight: FontWeight.w400, letterSpacing: 0.4, color: colorScheme.onSurface.withAlpha((0.7 * 255).toInt())),
      labelLarge: TextStyle(fontSize: baseFontSize, fontWeight: FontWeight.w500, letterSpacing: 1.25, color: onPrimaryColor),
      labelSmall: TextStyle(fontSize: baseFontSize - 6, fontWeight: FontWeight.w400, letterSpacing: 1.5, color: colorScheme.onSurface),
    );

    return ThemeData(
      colorScheme: colorScheme,
      primaryColor: primaryColor,
      scaffoldBackgroundColor: backgroundColor,
      appBarTheme: AppBarTheme(
        backgroundColor: colorScheme.primary,
        foregroundColor: colorScheme.onPrimary,
        iconTheme: const IconThemeData(color: onPrimaryColor),
        titleTextStyle: textTheme.titleLarge?.copyWith(color: onPrimaryColor),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: colorScheme.primary,
          foregroundColor: colorScheme.onPrimary,
          minimumSize: const Size(double.infinity, 50),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: textTheme.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: colorScheme.primary,
          textStyle: textTheme.labelLarge?.copyWith(color: colorScheme.primary, fontSize: baseFontSize - 1),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: errorColor,
        foregroundColor: onPrimaryColor,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: BorderSide(color: primaryColor.withAlpha((0.3 * 255).toInt())),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: BorderSide(color: primaryColor.withAlpha((0.5 * 255).toInt())),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: const BorderSide(color: primaryColor, width: 2.0),
        ),
        labelStyle: textTheme.bodyLarge?.copyWith(color: primaryColor.withAlpha((0.8 * 255).toInt())),
        hintStyle: textTheme.bodyMedium?.copyWith(color: Colors.grey[500]),
        prefixIconColor: primaryColor.withAlpha((0.7 * 255).toInt()),
      ),
      textTheme: textTheme,
      iconTheme: IconThemeData(color: primaryColor.withAlpha((0.7 * 255).toInt())),
      cardTheme: CardThemeData(
        elevation: 2,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        color: surfaceColor,
        surfaceTintColor: Colors.transparent,
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: surfaceColor,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        titleTextStyle: textTheme.headlineSmall,
        contentTextStyle: textTheme.bodyMedium,
      ),
    );
  }

  static ThemeData getDarkTheme(double baseFontSize) {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: primaryColor,
      brightness: Brightness.dark,
    ).copyWith(
      surface: darkSurfaceColor,
      onSurface: darkOnSurfaceColor,
      error: errorColor,
      onError: Colors.white,
    );

    final textTheme = TextTheme(
      displayLarge: TextStyle(fontSize: baseFontSize + 18, fontWeight: FontWeight.w300, letterSpacing: -1.5, color: colorScheme.onSurface),
      displayMedium: TextStyle(fontSize: baseFontSize + 12, fontWeight: FontWeight.w300, letterSpacing: -0.5, color: colorScheme.onSurface),
      displaySmall: TextStyle(fontSize: baseFontSize + 8, fontWeight: FontWeight.w400, color: colorScheme.onSurface),
      headlineMedium: TextStyle(fontSize: baseFontSize + 6, fontWeight: FontWeight.w400, letterSpacing: 0.25, color: colorScheme.onSurface),
      headlineSmall: TextStyle(fontSize: baseFontSize + 4, fontWeight: FontWeight.bold, color: colorScheme.onSurface.withAlpha((0.9 * 255).toInt())),
      titleLarge: TextStyle(fontSize: baseFontSize + 2, fontWeight: FontWeight.w500, letterSpacing: 0.15, color: colorScheme.onSurface),
      titleMedium: TextStyle(fontSize: baseFontSize, fontWeight: FontWeight.w400, letterSpacing: 0.15, color: colorScheme.onSurface),
      titleSmall: TextStyle(fontSize: baseFontSize - 2, fontWeight: FontWeight.w500, letterSpacing: 0.1, color: colorScheme.onSurface),
      bodyLarge: TextStyle(fontSize: baseFontSize, fontWeight: FontWeight.w400, letterSpacing: 0.5, color: colorScheme.onSurface),
      bodyMedium: TextStyle(fontSize: baseFontSize - 2, fontWeight: FontWeight.w400, letterSpacing: 0.25, color: colorScheme.onSurface.withAlpha((0.85 * 255).toInt())),
      bodySmall: TextStyle(fontSize: baseFontSize - 4, fontWeight: FontWeight.w400, letterSpacing: 0.4, color: colorScheme.onSurface.withAlpha((0.7 * 255).toInt())),
      labelLarge: TextStyle(fontSize: baseFontSize, fontWeight: FontWeight.w500, letterSpacing: 1.25, color: onPrimaryColor),
      labelSmall: TextStyle(fontSize: baseFontSize - 6, fontWeight: FontWeight.w400, letterSpacing: 1.5, color: colorScheme.onSurface),
    );

    return ThemeData(
      colorScheme: colorScheme,
      scaffoldBackgroundColor: darkBackgroundColor,
      appBarTheme: AppBarTheme(
        backgroundColor: colorScheme.primary,
        foregroundColor: colorScheme.onPrimary,
        iconTheme: const IconThemeData(color: onPrimaryColor),
        titleTextStyle: textTheme.titleLarge?.copyWith(color: onPrimaryColor),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: colorScheme.primary,
          foregroundColor: colorScheme.onPrimary,
          minimumSize: const Size(double.infinity, 50),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: textTheme.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: colorScheme.primary,
          textStyle: textTheme.labelLarge?.copyWith(color: colorScheme.primary, fontSize: baseFontSize - 1),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: BorderSide(color: primaryColor.withAlpha((0.7 * 255).toInt())),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: BorderSide(color: primaryColor.withAlpha((0.7 * 255).toInt())),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: const BorderSide(color: primaryColor, width: 2.0),
        ),
        labelStyle: textTheme.bodyLarge?.copyWith(color: primaryColor.withAlpha((0.8 * 255).toInt())),
        hintStyle: textTheme.bodyMedium?.copyWith(color: Colors.grey[600]),
        prefixIconColor: primaryColor.withAlpha((0.8 * 255).toInt()),
        fillColor: darkSurfaceColor,
        filled: true,
      ),
      textTheme: textTheme,
      iconTheme: IconThemeData(color: primaryColor.withAlpha((0.8 * 255).toInt())),
      cardTheme: CardThemeData(
        elevation: 1,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        color: darkSurfaceColor,
      ),
    );
  }
}
