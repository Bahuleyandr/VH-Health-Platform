// lib/core/utils/font_scale.dart
//
// Font-scaling parity with the patient app (roadmap E3). The patient app
// rebuilds its TextTheme from a user font-size preference; the staff app
// instead composes a MediaQuery TextScaler so EVERY text style — including
// the many hard-coded `fontSize:` chips and pills — scales together with
// the OS text-size setting (A11y #9 in SCREEN_READER_TEST_PLAN.md).
//
// Pure functions so the clamp behaviour is unit-testable without widgets.

/// User preference bounds, in "pt" as shown on the Settings slider.
const double kMinFontPt = 12.0;
const double kMaxFontPt = 22.0;

/// The neutral preference — factor 1.0, the pre-E3 rendering.
const double kBaseFontPt = 16.0;

/// Hard bounds on the COMPOSED factor (system × user). The lower bound
/// equals the slider minimum at a neutral OS setting (12/16) so every
/// slider position is honoured; it still floors pathological combos
/// (tiny OS factor × small preference). The upper bound keeps ward
/// tablets usable when both the OS setting and the in-app slider are
/// maxed (2.0 ≈ the Flutter accessibility large-text ceiling).
const double kMinComposedFactor = 0.75;
const double kMaxComposedFactor = 2.0;

/// Compose the effective text-scale factor from the OS factor and the
/// in-app preference (in pt, 16 = neutral).
double composeTextScaleFactor({
  required double systemFactor,
  required double userPt,
}) {
  final clampedPt = userPt.clamp(kMinFontPt, kMaxFontPt);
  final userFactor = clampedPt / kBaseFontPt;
  return (systemFactor * userFactor).clamp(
    kMinComposedFactor,
    kMaxComposedFactor,
  );
}
