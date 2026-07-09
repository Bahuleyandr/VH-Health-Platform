import 'dart:ui' show lerpDouble;

import 'package:flutter/material.dart';

@immutable
class VhColorTokens extends ThemeExtension<VhColorTokens> {
  const VhColorTokens({
    required this.primary,
    required this.onPrimary,
    required this.background,
    required this.surface,
    required this.card,
    required this.textPrimary,
    required this.textSecondary,
    required this.border,
    required this.inputBorder,
    required this.focusRing,
    required this.success,
    required this.successOnSurface,
    required this.warning,
    required this.warningOnSurface,
    required this.error,
    required this.errorOnSurface,
    required this.info,
  });

  final Color primary;
  final Color onPrimary;
  final Color background;
  final Color surface;
  final Color card;
  final Color textPrimary;
  final Color textSecondary;
  final Color border;
  final Color inputBorder;
  final Color focusRing;
  final Color success;
  final Color successOnSurface;
  final Color warning;
  final Color warningOnSurface;
  final Color error;
  final Color errorOnSurface;
  final Color info;

  @override
  VhColorTokens copyWith({
    Color? primary,
    Color? onPrimary,
    Color? background,
    Color? surface,
    Color? card,
    Color? textPrimary,
    Color? textSecondary,
    Color? border,
    Color? inputBorder,
    Color? focusRing,
    Color? success,
    Color? successOnSurface,
    Color? warning,
    Color? warningOnSurface,
    Color? error,
    Color? errorOnSurface,
    Color? info,
  }) {
    return VhColorTokens(
      primary: primary ?? this.primary,
      onPrimary: onPrimary ?? this.onPrimary,
      background: background ?? this.background,
      surface: surface ?? this.surface,
      card: card ?? this.card,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      border: border ?? this.border,
      inputBorder: inputBorder ?? this.inputBorder,
      focusRing: focusRing ?? this.focusRing,
      success: success ?? this.success,
      successOnSurface: successOnSurface ?? this.successOnSurface,
      warning: warning ?? this.warning,
      warningOnSurface: warningOnSurface ?? this.warningOnSurface,
      error: error ?? this.error,
      errorOnSurface: errorOnSurface ?? this.errorOnSurface,
      info: info ?? this.info,
    );
  }

  @override
  VhColorTokens lerp(ThemeExtension<VhColorTokens>? other, double t) {
    if (other is! VhColorTokens) return this;
    return VhColorTokens(
      primary: Color.lerp(primary, other.primary, t)!,
      onPrimary: Color.lerp(onPrimary, other.onPrimary, t)!,
      background: Color.lerp(background, other.background, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      card: Color.lerp(card, other.card, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      border: Color.lerp(border, other.border, t)!,
      inputBorder: Color.lerp(inputBorder, other.inputBorder, t)!,
      focusRing: Color.lerp(focusRing, other.focusRing, t)!,
      success: Color.lerp(success, other.success, t)!,
      successOnSurface: Color.lerp(
        successOnSurface,
        other.successOnSurface,
        t,
      )!,
      warning: Color.lerp(warning, other.warning, t)!,
      warningOnSurface: Color.lerp(
        warningOnSurface,
        other.warningOnSurface,
        t,
      )!,
      error: Color.lerp(error, other.error, t)!,
      errorOnSurface: Color.lerp(errorOnSurface, other.errorOnSurface, t)!,
      info: Color.lerp(info, other.info, t)!,
    );
  }
}

@immutable
class VhShapeTokens extends ThemeExtension<VhShapeTokens> {
  const VhShapeTokens({
    required this.inputRadius,
    required this.controlRadius,
    required this.cardRadius,
    required this.dialogRadius,
    required this.chipRadius,
    required this.pillRadius,
    required this.focusRingWidth,
    required this.focusRingOffset,
  });

  final double inputRadius;
  final double controlRadius;
  final double cardRadius;
  final double dialogRadius;
  final double chipRadius;
  final double pillRadius;
  final double focusRingWidth;
  final double focusRingOffset;

  @override
  VhShapeTokens copyWith({
    double? inputRadius,
    double? controlRadius,
    double? cardRadius,
    double? dialogRadius,
    double? chipRadius,
    double? pillRadius,
    double? focusRingWidth,
    double? focusRingOffset,
  }) {
    return VhShapeTokens(
      inputRadius: inputRadius ?? this.inputRadius,
      controlRadius: controlRadius ?? this.controlRadius,
      cardRadius: cardRadius ?? this.cardRadius,
      dialogRadius: dialogRadius ?? this.dialogRadius,
      chipRadius: chipRadius ?? this.chipRadius,
      pillRadius: pillRadius ?? this.pillRadius,
      focusRingWidth: focusRingWidth ?? this.focusRingWidth,
      focusRingOffset: focusRingOffset ?? this.focusRingOffset,
    );
  }

  @override
  VhShapeTokens lerp(ThemeExtension<VhShapeTokens>? other, double t) {
    if (other is! VhShapeTokens) return this;
    return VhShapeTokens(
      inputRadius: lerpDouble(inputRadius, other.inputRadius, t)!,
      controlRadius: lerpDouble(controlRadius, other.controlRadius, t)!,
      cardRadius: lerpDouble(cardRadius, other.cardRadius, t)!,
      dialogRadius: lerpDouble(dialogRadius, other.dialogRadius, t)!,
      chipRadius: lerpDouble(chipRadius, other.chipRadius, t)!,
      pillRadius: lerpDouble(pillRadius, other.pillRadius, t)!,
      focusRingWidth: lerpDouble(focusRingWidth, other.focusRingWidth, t)!,
      focusRingOffset: lerpDouble(focusRingOffset, other.focusRingOffset, t)!,
    );
  }
}

class VhDesignTokens {
  VhDesignTokens._();

  static const Color brandPrimary = Color(0xFF007A64);
  static const Color brandOnPrimary = Color(0xFFFFFFFF);
  static const Color brandPrimaryDark = Color(0xFF4DB8A8);
  static const Color brandOnPrimaryDark = Color(0xFF121212);

  static const Color clinicalPrimary = Color(0xFF1565C0);
  static const Color clinicalOnPrimary = Color(0xFFFFFFFF);
  static const Color clinicalPrimaryDark = Color(0xFF90CAF9);
  static const Color clinicalOnPrimaryDark = Color(0xFF0D1B2A);
  static const Color clinicalSecondary = Color(0xFF00796B);
  static const Color clinicalTertiary = Color(0xFF0097A7);

  static const Color coreBackgroundLight = Color(0xFFE0F5F6);
  static const Color staffBackgroundLight = Color(0xFFF5F7FA);
  static const Color surfaceLight = Color(0xFFFFFFFF);
  static const Color cardLight = Color(0xFFFFFFFF);
  static const Color textPrimaryLight = Color(0xFF1A237E);
  static const Color textSecondaryLight = Color(0xFF546E7A);
  static const Color borderLight = Color(0xFFECEFF1);
  static const Color inputBorderLight = Color(0xFFB0BEC5);

  static const Color coreBackgroundDark = Color(0xFF121212);
  static const Color staffBackgroundDark = Color(0xFF141420);
  static const Color surfaceDark = Color(0xFF1E1E1E);
  static const Color staffSurfaceDark = Color(0xFF1E1E2C);
  static const Color cardDark = Color(0xFF252536);
  static const Color textPrimaryDark = Color(0xFFE0E0E8);
  static const Color textSecondaryDark = Color(0xFF9E9EAE);
  static const Color borderDark = Color(0xFF2E2E42);
  static const Color inputBorderDark = Color(0xFF3A3A50);

  static const Color success = Color(0xFF2E7D32);
  static const Color successOnSurfaceLight = Color(0xFF2E7D32);
  static const Color successOnSurfaceDark = Color(0xFF66BB6A);
  static const Color warning = Color(0xFFE65100);
  static const Color warningOnSurfaceLight = Color(0xFFA84300);
  static const Color warningOnSurfaceDark = Color(0xFFFFB74D);
  static const Color error = Color(0xFFC62828);
  static const Color errorOnSurfaceLight = Color(0xFFC62828);
  static const Color errorOnSurfaceDark = Color(0xFFFF8A80);
  static const Color danger = Color(0xFFFF5252);

  static const double spacingXs = 4;
  static const double spacingSm = 8;
  static const double spacingMd = 12;
  static const double spacingLg = 16;
  static const double spacingXl = 24;
  static const double spacingXxl = 32;

  static const double baseFontSize = 16;
  static const double bodySmallFontSize = 12;
  static const double bodyFontSize = 14;
  static const double titleFontSize = 18;
  static const double displayFontSize = 34;
  static const double letterSpacing = 0;

  static const double iconXs = 14;
  static const double iconSm = 16;
  static const double iconMd = 20;
  static const double iconLg = 24;
  static const double iconXl = 32;

  static const double compactRowHeight = 40;
  static const double comfortableRowHeight = 48;
  static const double touchTarget = 48;
  static const double desktopScrollbar = 10;

  static const int motionFastMs = 120;
  static const int motionStandardMs = 200;
  static const int motionSlowMs = 320;

  static const double minimumTextContrast = 4.5;
  static const double minimumFocusContrast = 3;

  static const VhShapeTokens shape = VhShapeTokens(
    inputRadius: 8,
    controlRadius: 10,
    cardRadius: 12,
    dialogRadius: 12,
    chipRadius: 20,
    pillRadius: 999,
    focusRingWidth: 2,
    focusRingOffset: 2,
  );

  static const VhColorTokens coreLight = VhColorTokens(
    primary: brandPrimary,
    onPrimary: brandOnPrimary,
    background: coreBackgroundLight,
    surface: surfaceLight,
    card: cardLight,
    textPrimary: textPrimaryLight,
    textSecondary: textSecondaryLight,
    border: borderLight,
    inputBorder: inputBorderLight,
    focusRing: brandPrimary,
    success: success,
    successOnSurface: successOnSurfaceLight,
    warning: warning,
    warningOnSurface: warningOnSurfaceLight,
    error: danger,
    errorOnSurface: errorOnSurfaceLight,
    info: brandPrimary,
  );

  static const VhColorTokens coreDark = VhColorTokens(
    primary: brandPrimaryDark,
    onPrimary: brandOnPrimaryDark,
    background: coreBackgroundDark,
    surface: surfaceDark,
    card: surfaceDark,
    textPrimary: Color(0xFFFFFFFF),
    textSecondary: Color(0xFF9CA3AF),
    border: Color(0x334DB8A8),
    inputBorder: Color(0x404DB8A8),
    focusRing: brandPrimaryDark,
    success: successOnSurfaceDark,
    successOnSurface: successOnSurfaceDark,
    warning: warningOnSurfaceDark,
    warningOnSurface: warningOnSurfaceDark,
    error: danger,
    errorOnSurface: errorOnSurfaceDark,
    info: brandPrimaryDark,
  );

  static const VhColorTokens staffLight = VhColorTokens(
    primary: clinicalPrimary,
    onPrimary: clinicalOnPrimary,
    background: staffBackgroundLight,
    surface: surfaceLight,
    card: cardLight,
    textPrimary: textPrimaryLight,
    textSecondary: textSecondaryLight,
    border: borderLight,
    inputBorder: inputBorderLight,
    focusRing: clinicalPrimary,
    success: success,
    successOnSurface: successOnSurfaceLight,
    warning: warning,
    warningOnSurface: warningOnSurfaceLight,
    error: error,
    errorOnSurface: errorOnSurfaceLight,
    info: clinicalPrimary,
  );

  static const VhColorTokens staffDark = VhColorTokens(
    primary: clinicalPrimaryDark,
    onPrimary: clinicalOnPrimaryDark,
    background: staffBackgroundDark,
    surface: staffSurfaceDark,
    card: cardDark,
    textPrimary: textPrimaryDark,
    textSecondary: textSecondaryDark,
    border: borderDark,
    inputBorder: inputBorderDark,
    focusRing: clinicalPrimaryDark,
    success: successOnSurfaceDark,
    successOnSurface: successOnSurfaceDark,
    warning: warningOnSurfaceDark,
    warningOnSurface: warningOnSurfaceDark,
    error: errorOnSurfaceDark,
    errorOnSurface: errorOnSurfaceDark,
    info: clinicalPrimaryDark,
  );
}

extension VhDesignTokenTheme on ThemeData {
  VhColorTokens get vhColors {
    final tokens = extension<VhColorTokens>();
    if (tokens != null) return tokens;
    return brightness == Brightness.dark
        ? VhDesignTokens.coreDark
        : VhDesignTokens.coreLight;
  }

  VhShapeTokens get vhShape {
    return extension<VhShapeTokens>() ?? VhDesignTokens.shape;
  }
}
