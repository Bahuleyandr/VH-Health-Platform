import 'package:flutter/material.dart';

import '../config/tenant_config.dart';
import 'design_tokens.dart';

class AppTheme {
  static const Color primaryColor = VhDesignTokens.brandPrimary;
  static const Color backgroundColor = VhDesignTokens.coreBackgroundLight;
  static const Color onPrimaryColor = VhDesignTokens.brandOnPrimary;
  static const Color errorColor = VhDesignTokens.danger;

  /// W6 T3 — per-tenant seed colour for the Material 3 ColorScheme. A stamped
  /// build sets `--dart-define=VH_TENANT_PRIMARY=#RRGGBB`; an unstamped (default)
  /// build falls back to the brand [primaryColor] (NO-OP). Only the SEED is
  /// tenant-driven — the colour scheme (app bar, buttons via colorScheme.primary)
  /// follows it; the legacy const accents stay on the brand colour.
  static Color get seedColor =>
      parseHexColor(TenantConfig.primaryColorHex) ?? primaryColor;

  /// Parse `#RRGGBB` / `RRGGBB` / `#AARRGGBB` into a [Color]; null if empty/invalid.
  @visibleForTesting
  static Color? parseHexColor(String hex) {
    var h = hex.trim();
    if (h.isEmpty) return null;
    if (h.startsWith('#')) h = h.substring(1);
    if (h.length == 6) h = 'FF$h';
    if (h.length != 8) return null;
    final value = int.tryParse(h, radix: 16);
    return value == null ? null : Color(value);
  }

  static const Color surfaceColor = VhDesignTokens.surfaceLight;
  static const Color onSurfaceColor = Colors.black87;

  static const Color darkBackgroundColor = VhDesignTokens.coreBackgroundDark;
  static const Color darkSurfaceColor = VhDesignTokens.surfaceDark;
  static const Color darkOnSurfaceColor = Colors.white;

  static ThemeData getLightTheme(double baseFontSize) {
    final colorScheme =
        ColorScheme.fromSeed(
          seedColor: seedColor,
          brightness: Brightness.light,
        ).copyWith(
          surface: surfaceColor,
          onSurface: onSurfaceColor,
          // WCAG AA: the legacy danger red (#FF5252) is only 3.19:1 on white
          // surfaces; the compliant token (#C62828) reads 5.62:1 on white and
          // 4.97:1 on the mint scaffold background.
          error: VhDesignTokens.errorOnSurfaceLight,
          onError: Colors.white,
        );

    final textTheme = TextTheme(
      displayLarge: TextStyle(
        fontSize: baseFontSize + 18,
        fontWeight: FontWeight.w300,
        letterSpacing: -1.5,
        color: colorScheme.onSurface,
      ),
      displayMedium: TextStyle(
        fontSize: baseFontSize + 12,
        fontWeight: FontWeight.w300,
        letterSpacing: -0.5,
        color: colorScheme.onSurface,
      ),
      displaySmall: TextStyle(
        fontSize: baseFontSize + 8,
        fontWeight: FontWeight.w400,
        color: colorScheme.onSurface,
      ),
      headlineMedium: TextStyle(
        fontSize: baseFontSize + 6,
        fontWeight: FontWeight.w400,
        letterSpacing: 0.25,
        color: colorScheme.onSurface,
      ),
      headlineSmall: TextStyle(
        fontSize: baseFontSize + 4,
        fontWeight: FontWeight.bold,
        color: colorScheme.onSurface.withAlpha((0.9 * 255).toInt()),
      ),
      titleLarge: TextStyle(
        fontSize: baseFontSize + 2,
        fontWeight: FontWeight.w500,
        letterSpacing: 0.15,
        color: colorScheme.onSurface,
      ),
      titleMedium: TextStyle(
        fontSize: baseFontSize,
        fontWeight: FontWeight.w400,
        letterSpacing: 0.15,
        color: colorScheme.onSurface,
      ),
      titleSmall: TextStyle(
        fontSize: baseFontSize - 2,
        fontWeight: FontWeight.w500,
        letterSpacing: 0.1,
        color: colorScheme.onSurface,
      ),
      bodyLarge: TextStyle(
        fontSize: baseFontSize,
        fontWeight: FontWeight.w400,
        letterSpacing: 0.5,
        color: colorScheme.onSurface,
      ),
      bodyMedium: TextStyle(
        fontSize: baseFontSize - 2,
        fontWeight: FontWeight.w400,
        letterSpacing: 0.25,
        color: colorScheme.onSurface.withAlpha((0.85 * 255).toInt()),
      ),
      bodySmall: TextStyle(
        fontSize: baseFontSize - 4,
        fontWeight: FontWeight.w400,
        letterSpacing: 0.4,
        color: colorScheme.onSurface.withAlpha((0.7 * 255).toInt()),
      ),
      labelLarge: TextStyle(
        fontSize: baseFontSize,
        fontWeight: FontWeight.w500,
        letterSpacing: 1.25,
        color: onPrimaryColor,
      ),
      labelSmall: TextStyle(
        fontSize: baseFontSize - 6,
        fontWeight: FontWeight.w400,
        letterSpacing: 1.5,
        color: colorScheme.onSurface,
      ),
    );

    return ThemeData(
      colorScheme: colorScheme,
      extensions: <ThemeExtension<dynamic>>[
        VhDesignTokens.coreLight.copyWith(
          primary: colorScheme.primary,
          onPrimary: colorScheme.onPrimary,
          focusRing: colorScheme.primary,
          info: colorScheme.primary,
        ),
        VhDesignTokens.shape,
      ],
      primaryColor: primaryColor,
      scaffoldBackgroundColor: backgroundColor,
      appBarTheme: AppBarTheme(
        backgroundColor: colorScheme.primary,
        foregroundColor: colorScheme.onPrimary,
        // Follow the scheme's tonal onPrimary (not the hardcoded brand white)
        // so title/icon contrast holds for any tenant seed colour.
        iconTheme: IconThemeData(color: colorScheme.onPrimary),
        titleTextStyle: textTheme.titleLarge?.copyWith(
          color: colorScheme.onPrimary,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: colorScheme.primary,
          foregroundColor: colorScheme.onPrimary,
          minimumSize: const Size(double.infinity, 50),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          textStyle: textTheme.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: colorScheme.primary,
          textStyle: textTheme.labelLarge?.copyWith(
            color: colorScheme.primary,
            fontSize: baseFontSize - 1,
          ),
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
          borderSide: BorderSide(
            color: primaryColor.withAlpha((0.3 * 255).toInt()),
          ),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: BorderSide(
            color: primaryColor.withAlpha((0.5 * 255).toInt()),
          ),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: const BorderSide(color: primaryColor, width: 2.0),
        ),
        labelStyle: textTheme.bodyLarge?.copyWith(
          color: primaryColor.withAlpha((0.8 * 255).toInt()),
        ),
        hintStyle: textTheme.bodyMedium?.copyWith(color: Colors.grey[500]),
        prefixIconColor: primaryColor.withAlpha((0.7 * 255).toInt()),
      ),
      textTheme: textTheme,
      iconTheme: IconThemeData(
        color: primaryColor.withAlpha((0.7 * 255).toInt()),
      ),
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
    final colorScheme =
        ColorScheme.fromSeed(
          seedColor: seedColor,
          brightness: Brightness.dark,
        ).copyWith(
          surface: darkSurfaceColor,
          onSurface: darkOnSurfaceColor,
          error: errorColor,
          onError: Colors.white,
        );

    final textTheme = TextTheme(
      displayLarge: TextStyle(
        fontSize: baseFontSize + 18,
        fontWeight: FontWeight.w300,
        letterSpacing: -1.5,
        color: colorScheme.onSurface,
      ),
      displayMedium: TextStyle(
        fontSize: baseFontSize + 12,
        fontWeight: FontWeight.w300,
        letterSpacing: -0.5,
        color: colorScheme.onSurface,
      ),
      displaySmall: TextStyle(
        fontSize: baseFontSize + 8,
        fontWeight: FontWeight.w400,
        color: colorScheme.onSurface,
      ),
      headlineMedium: TextStyle(
        fontSize: baseFontSize + 6,
        fontWeight: FontWeight.w400,
        letterSpacing: 0.25,
        color: colorScheme.onSurface,
      ),
      headlineSmall: TextStyle(
        fontSize: baseFontSize + 4,
        fontWeight: FontWeight.bold,
        color: colorScheme.onSurface.withAlpha((0.9 * 255).toInt()),
      ),
      titleLarge: TextStyle(
        fontSize: baseFontSize + 2,
        fontWeight: FontWeight.w500,
        letterSpacing: 0.15,
        color: colorScheme.onSurface,
      ),
      titleMedium: TextStyle(
        fontSize: baseFontSize,
        fontWeight: FontWeight.w400,
        letterSpacing: 0.15,
        color: colorScheme.onSurface,
      ),
      titleSmall: TextStyle(
        fontSize: baseFontSize - 2,
        fontWeight: FontWeight.w500,
        letterSpacing: 0.1,
        color: colorScheme.onSurface,
      ),
      bodyLarge: TextStyle(
        fontSize: baseFontSize,
        fontWeight: FontWeight.w400,
        letterSpacing: 0.5,
        color: colorScheme.onSurface,
      ),
      bodyMedium: TextStyle(
        fontSize: baseFontSize - 2,
        fontWeight: FontWeight.w400,
        letterSpacing: 0.25,
        color: colorScheme.onSurface.withAlpha((0.85 * 255).toInt()),
      ),
      bodySmall: TextStyle(
        fontSize: baseFontSize - 4,
        fontWeight: FontWeight.w400,
        letterSpacing: 0.4,
        color: colorScheme.onSurface.withAlpha((0.7 * 255).toInt()),
      ),
      labelLarge: TextStyle(
        fontSize: baseFontSize,
        fontWeight: FontWeight.w500,
        letterSpacing: 1.25,
        color: onPrimaryColor,
      ),
      labelSmall: TextStyle(
        fontSize: baseFontSize - 6,
        fontWeight: FontWeight.w400,
        letterSpacing: 1.5,
        color: colorScheme.onSurface,
      ),
    );

    return ThemeData(
      colorScheme: colorScheme,
      extensions: <ThemeExtension<dynamic>>[
        VhDesignTokens.coreDark.copyWith(
          primary: colorScheme.primary,
          onPrimary: colorScheme.onPrimary,
          focusRing: colorScheme.primary,
          info: colorScheme.primary,
        ),
        VhDesignTokens.shape,
      ],
      scaffoldBackgroundColor: darkBackgroundColor,
      appBarTheme: AppBarTheme(
        backgroundColor: colorScheme.primary,
        foregroundColor: colorScheme.onPrimary,
        // WCAG AA fix: the hardcoded brand white was 1.70:1 over the light
        // mint dark-mode primary. The scheme's tonal onPrimary is dark and
        // guaranteed readable over primary for any tenant seed colour.
        iconTheme: IconThemeData(color: colorScheme.onPrimary),
        titleTextStyle: textTheme.titleLarge?.copyWith(
          color: colorScheme.onPrimary,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: colorScheme.primary,
          foregroundColor: colorScheme.onPrimary,
          minimumSize: const Size(double.infinity, 50),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          textStyle: textTheme.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: colorScheme.primary,
          textStyle: textTheme.labelLarge?.copyWith(
            color: colorScheme.primary,
            fontSize: baseFontSize - 1,
          ),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: BorderSide(
            color: primaryColor.withAlpha((0.7 * 255).toInt()),
          ),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: BorderSide(
            color: primaryColor.withAlpha((0.7 * 255).toInt()),
          ),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8.0),
          borderSide: const BorderSide(color: primaryColor, width: 2.0),
        ),
        labelStyle: textTheme.bodyLarge?.copyWith(
          color: primaryColor.withAlpha((0.8 * 255).toInt()),
        ),
        hintStyle: textTheme.bodyMedium?.copyWith(color: Colors.grey[600]),
        prefixIconColor: primaryColor.withAlpha((0.8 * 255).toInt()),
        fillColor: darkSurfaceColor,
        filled: true,
      ),
      textTheme: textTheme,
      iconTheme: IconThemeData(
        color: primaryColor.withAlpha((0.8 * 255).toInt()),
      ),
      cardTheme: CardThemeData(
        elevation: 1,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        color: darkSurfaceColor,
      ),
    );
  }
}
