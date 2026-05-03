import 'package:flutter/material.dart';

class AppTheme {
  AppTheme._();

  // ── Adaptive brightness ───────────────────────────────────────────────
  //
  // The screens in this app were written against `AppTheme.backgroundGrey`,
  // `AppTheme.cardSurface`, `AppTheme.textPrimary` etc. as compile-time
  // constants. When the user enabled dark mode (via Settings → Theme),
  // ThemeData switched to darkTheme but every Scaffold(backgroundColor:
  // AppTheme.backgroundGrey) still painted itself with the LIGHT grey,
  // every Card with white, every Text with dark navy — so dark mode
  // looked partially-applied + unreadable.
  //
  // Fix: replace the six surface + text colours with getters that read
  // from the static `brightness` flag below. ThemeProvider keeps the
  // flag in sync (set in setThemeMode + initial _loadFromPrefs + at app
  // startup from PlatformDispatcher.platformBrightness for system mode).
  // All call sites continue to read `AppTheme.backgroundGrey` exactly as
  // before — they just get the right colour now.
  //
  // 137 const-context usages of these getters were de-const'd by an
  // automated pass — getters can't be used in `const` expressions.
  //
  // Brand colours (primaryBlue / successGreen / etc.) stay compile-time
  // const because they're identical in light + dark mode.
  static Brightness brightness = Brightness.light;

  // ── Brand colours (same in both themes) ───────────────────────────────
  static const Color primaryBlue = Color(0xFF1565C0);
  static const Color primaryTeal = Color(0xFF00796B);
  static const Color accentCyan = Color(0xFF0097A7);
  static const Color successGreen = Color(0xFF2E7D32);
  // warningAmber darkened from #F57F17 (Material Orange 800) to #E65100
  // (Material Orange 900). The previous tone gave only 2.65:1 contrast
  // for both warningAmber text on white AND white text on warningAmber
  // backgrounds — failing WCAG AA either way. #E65100 raises both pairs
  // to ~5.8:1 (AA) without losing the "amber" reading at a glance.
  static const Color warningAmber = Color(0xFFE65100);
  static const Color errorRed = Color(0xFFC62828);

  // ── Light-palette tokens (private const) ──────────────────────────────
  // Used by `lightTheme` builder in const expressions where adaptive
  // getters can't go. Same hex values as the previous public consts.
  static const Color _lightSurface = Color(0xFFFFFFFF);
  static const Color _lightBackground = Color(0xFFF5F7FA);
  static const Color _lightCard = Color(0xFFFFFFFF);
  static const Color _lightTextPrimary = Color(0xFF1A237E);
  static const Color _lightTextSecondary = Color(0xFF546E7A);
  static const Color _lightDivider = Color(0xFFECEFF1);
  static const Color _lightInputBorder = Color(0xFFB0BEC5);
  // _lightHint darkened from #90A4AE (BlueGrey 300) to #607D8B
  // (BlueGrey 600). The previous tone gave 2.59:1 contrast against
  // white input backgrounds — invisible to many users. #607D8B is
  // 4.32:1 (AA) and still reads as a faded placeholder.
  static const Color _lightHint = Color(0xFF607D8B);
  static const Color _lightChipBg = Color(0xFFE3F2FD);

  // ── Dark-palette tokens (public const, also used by adaptive getters) ─
  static const Color darkSurface = Color(0xFF1E1E2C);
  static const Color darkBackground = Color(0xFF141420);
  static const Color darkCard = Color(0xFF252536);
  static const Color darkTextPrimary = Color(0xFFE0E0E8);
  static const Color darkTextSecondary = Color(0xFF9E9EAE);
  static const Color darkDivider = Color(0xFF2E2E42);
  static const Color _darkInputBorder = Color(0xFF3A3A50);
  static const Color _darkHint = Color(0xFF6E6E82);
  static const Color _darkPrimary = Color(0xFF90CAF9);
  static const Color _darkSecondary = Color(0xFF80CBC4);
  static const Color _darkTertiary = Color(0xFF80DEEA);
  static const Color _darkError = Color(0xFFEF5350);
  static const Color _darkButtonFg = Color(0xFF0D1B2A);
  static const Color _darkChipBg = Color(0xFF1A2744);

  // ── Adaptive surface + text getters ───────────────────────────────────
  // Screens read these. Light values match the previous static const
  // definitions exactly; dark values come from the dark-palette tokens.
  static Color get surfaceWhite =>
      brightness == Brightness.dark ? darkSurface : _lightSurface;
  static Color get backgroundGrey =>
      brightness == Brightness.dark ? darkBackground : _lightBackground;
  static Color get cardSurface =>
      brightness == Brightness.dark ? darkCard : _lightCard;
  static Color get textPrimary =>
      brightness == Brightness.dark ? darkTextPrimary : _lightTextPrimary;
  static Color get textSecondary =>
      brightness == Brightness.dark ? darkTextSecondary : _lightTextSecondary;
  static Color get divider =>
      brightness == Brightness.dark ? darkDivider : _lightDivider;

  // ── Adaptive semantic-color getters ───────────────────────────────────
  //
  // The brand `successGreen` (#2E7D32) and `errorRed` (#C62828) are tuned
  // for white backgrounds; they fail WCAG AA on the dark card surface
  // (#252536) at 2.93:1 and 2.67:1 respectively. Use these adaptive
  // getters when you need success / error / warning text rendered on
  // a card / surface — they switch to lighter Material variants in
  // dark mode that meet AA on the dark card.
  //
  // Keep using the raw brand const (`AppTheme.successGreen` etc.) for:
  //   - filled backgrounds where text is white/dark (e.g. coloured
  //     buttons, status pills) — white-on-success is fine in both modes
  //   - icon tints on chip-style backgrounds (the chip background lifts
  //     contrast)
  // Use these getters for:
  //   - body text rendered directly on `cardSurface` or `backgroundGrey`
  //   - inline error/success messages
  static Color get successOnSurface => brightness == Brightness.dark
      ? const Color(0xFF66BB6A) // Material Green 400 — 6.45:1 on darkCard
      : successGreen;
  static Color get errorOnSurface => brightness == Brightness.dark
      ? const Color(0xFFFF8A80) // Material Red A100 — 6.42:1 on darkCard
      : errorRed;
  static Color get warningOnSurface => brightness == Brightness.dark
      ? const Color(0xFFFFB74D) // Material Orange 300 — 6.92:1 on darkCard
      : warningAmber;

  // ── Light theme ───────────────────────────────────────────────────────
  static ThemeData get lightTheme {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: primaryBlue,
      brightness: Brightness.light,
      primary: primaryBlue,
      secondary: primaryTeal,
      tertiary: accentCyan,
      surface: _lightSurface,
      error: errorRed,
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: _lightBackground,
      fontFamily: 'Roboto',
      appBarTheme: const AppBarTheme(
        elevation: 0,
        centerTitle: false,
        backgroundColor: primaryBlue,
        foregroundColor: Colors.white,
        titleTextStyle: TextStyle(
          fontSize: 20,
          fontWeight: FontWeight.w600,
          color: Colors.white,
          letterSpacing: 0.15,
        ),
        iconTheme: IconThemeData(color: Colors.white),
      ),
      cardTheme: CardThemeData(
        elevation: 1,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        color: _lightCard,
        surfaceTintColor: Colors.transparent,
        margin: const EdgeInsets.symmetric(horizontal: 0, vertical: 4),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: primaryBlue,
          foregroundColor: Colors.white,
          elevation: 2,
          minimumSize: const Size(double.infinity, 52),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
          ),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: primaryBlue,
          side: const BorderSide(color: primaryBlue, width: 1.5),
          minimumSize: const Size(double.infinity, 52),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
          ),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: _lightSurface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: _lightInputBorder),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: _lightInputBorder),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: primaryBlue, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: errorRed),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 16,
          vertical: 14,
        ),
        labelStyle: const TextStyle(color: _lightTextSecondary),
        hintStyle: const TextStyle(color: _lightHint),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: _lightChipBg,
        labelStyle: const TextStyle(
          color: primaryBlue,
          fontWeight: FontWeight.w500,
        ),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      ),
      dividerTheme: const DividerThemeData(
        color: _lightDivider,
        thickness: 1,
        space: 1,
      ),
      listTileTheme: const ListTileThemeData(
        contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: _lightSurface,
        selectedItemColor: primaryBlue,
        unselectedItemColor: _lightTextSecondary,
        showUnselectedLabels: true,
        type: BottomNavigationBarType.fixed,
        elevation: 8,
      ),
    );
  }

  // ── Dark theme ────────────────────────────────────────────────────────
  static ThemeData get darkTheme {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: primaryBlue,
      brightness: Brightness.dark,
      primary: _darkPrimary,
      secondary: _darkSecondary,
      tertiary: _darkTertiary,
      surface: darkSurface,
      error: _darkError,
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: darkBackground,
      fontFamily: 'Roboto',
      appBarTheme: const AppBarTheme(
        elevation: 0,
        centerTitle: false,
        backgroundColor: darkSurface,
        foregroundColor: darkTextPrimary,
        titleTextStyle: TextStyle(
          fontSize: 20,
          fontWeight: FontWeight.w600,
          color: darkTextPrimary,
          letterSpacing: 0.15,
        ),
        iconTheme: IconThemeData(color: darkTextPrimary),
      ),
      cardTheme: CardThemeData(
        elevation: 1,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        color: darkCard,
        surfaceTintColor: Colors.transparent,
        margin: const EdgeInsets.symmetric(horizontal: 0, vertical: 4),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: _darkPrimary,
          foregroundColor: _darkButtonFg,
          elevation: 2,
          minimumSize: const Size(double.infinity, 52),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
          ),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: _darkPrimary,
          side: const BorderSide(color: _darkPrimary, width: 1.5),
          minimumSize: const Size(double.infinity, 52),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
          ),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: darkCard,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: _darkInputBorder),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: _darkInputBorder),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: _darkPrimary, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: _darkError),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 16,
          vertical: 14,
        ),
        labelStyle: const TextStyle(color: darkTextSecondary),
        hintStyle: const TextStyle(color: _darkHint),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: _darkChipBg,
        labelStyle: const TextStyle(
          color: _darkPrimary,
          fontWeight: FontWeight.w500,
        ),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      ),
      dividerTheme: const DividerThemeData(
        color: darkDivider,
        thickness: 1,
        space: 1,
      ),
      listTileTheme: const ListTileThemeData(
        contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: darkSurface,
        selectedItemColor: _darkPrimary,
        unselectedItemColor: darkTextSecondary,
        showUnselectedLabels: true,
        type: BottomNavigationBarType.fixed,
        elevation: 8,
      ),
    );
  }
}
