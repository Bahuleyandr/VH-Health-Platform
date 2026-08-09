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
/// The adjustment walks HSL lightness away from the background (darker on
/// light backgrounds, lighter on dark ones) in small steps until the ratio
/// is met, preserving hue and saturation. Falls back to pure black/white,
/// which maximises contrast when even the extreme lightness in-hue fails.
///
/// Intended for accent/brand colours used as *text or icon* colour on a
/// known backdrop — e.g. the pastel feature colours in the patient app,
/// which are decorative as fills but unreadable as text.
Color ensureTextContrast(
  Color foreground,
  Color background, {
  double minRatio = 4.5,
}) {
  if (contrastRatio(foreground, background) >= minRatio) return foreground;

  final backgroundIsDark = background.computeLuminance() <= 0.5;
  var hsl = HSLColor.fromColor(foreground);
  const step = 0.05;
  for (var i = 0; i < 40; i++) {
    final lightness = backgroundIsDark
        ? (hsl.lightness + step).clamp(0.0, 1.0)
        : (hsl.lightness - step).clamp(0.0, 1.0);
    hsl = hsl.withLightness(lightness);
    final candidate = hsl.toColor();
    if (contrastRatio(candidate, background) >= minRatio) return candidate;
  }
  return backgroundIsDark ? const Color(0xFFFFFFFF) : const Color(0xFF000000);
}
