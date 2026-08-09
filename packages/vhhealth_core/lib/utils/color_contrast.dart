import 'package:flutter/painting.dart';

/// WCAG 2.x colour-contrast helpers shared by patient and staff UI code.
///
/// Both functions treat colours as fully opaque — callers compositing
/// translucent colours should flatten them against their backdrop first.

/// WCAG 2.x contrast ratio between two opaque colours, in the range 1..21.
///
/// Uses the relative-luminance formula from WCAG 2.1 §1.4.3 (via
/// [Color.computeLuminance]). Order of the arguments does not matter.
double contrastRatio(Color a, Color b) {
  final la = a.computeLuminance();
  final lb = b.computeLuminance();
  final lighter = la > lb ? la : lb;
  final darker = la > lb ? lb : la;
  return (lighter + 0.05) / (darker + 0.05);
}

/// Returns [foreground] unchanged when it already meets [minRatio] against
/// [background]; otherwise returns the nearest same-hue colour that does.
///
/// The adjustment searches HSL lightness in both directions, preserving hue
/// and saturation, and chooses the nearest colour that meets the ratio. This
/// matters for mid-tone backgrounds, where luminance alone cannot safely
/// predict whether a lighter or darker foreground will pass.
///
/// Intended for accent/brand colours used as *text or icon* colour on a
/// known backdrop — e.g. the pastel feature colours in the patient app,
/// which are decorative as fills but unreadable as text.
Color ensureTextContrast(
  Color foreground,
  Color background, {
  double minRatio = 4.5,
}) {
  if (!minRatio.isFinite || minRatio < 1 || minRatio > 21) {
    throw ArgumentError.value(
      minRatio,
      'minRatio',
      'must be a finite WCAG contrast ratio between 1 and 21',
    );
  }
  if (contrastRatio(foreground, background) >= minRatio) return foreground;

  final source = HSLColor.fromColor(foreground);

  Color? nearestPassingColor(double targetLightness) {
    final extreme = source.withLightness(targetLightness).toColor();
    if (contrastRatio(extreme, background) < minRatio) return null;

    var failing = source.lightness;
    var passing = targetLightness;
    for (var i = 0; i < 24; i++) {
      final midpoint = (failing + passing) / 2;
      final candidate = source.withLightness(midpoint).toColor();
      if (contrastRatio(candidate, background) >= minRatio) {
        passing = midpoint;
      } else {
        failing = midpoint;
      }
    }
    return source.withLightness(passing).toColor();
  }
  final darker = nearestPassingColor(0);
  final lighter = nearestPassingColor(1);
  if (darker == null && lighter == null) {
    throw ArgumentError.value(
      minRatio,
      'minRatio',
      'cannot be achieved against the supplied background',
    );
  }
  if (darker == null) return lighter!;
  if (lighter == null) return darker;

  final darkerDistance =
      (HSLColor.fromColor(darker).lightness - source.lightness).abs();
  final lighterDistance =
      (HSLColor.fromColor(lighter).lightness - source.lightness).abs();
  return darkerDistance <= lighterDistance ? darker : lighter;
}
