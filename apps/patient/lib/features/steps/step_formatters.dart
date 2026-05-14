// Small formatting helpers shared across the Step Challenge section
// widgets. Extracted from step_challenge_screen.dart so each section
// widget doesn't need its own copy.
import 'package:flutter/material.dart';

/// Metres → "x.xx km".
String stepDistKm(double m) => '${(m / 1000).toStringAsFixed(2)} km';

/// Parses a "#RRGGBB" hex string into a [Color], defaulting to blue on
/// any parse failure.
Color stepHexColor(String hex) {
  try {
    return Color(int.parse(hex.replaceFirst('#', '0xFF')));
  } catch (_) {
    return const Color(0xFF2196F3);
  }
}
