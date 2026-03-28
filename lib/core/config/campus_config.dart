/// Configuration for campus geofence boundaries.
///
/// Default values point to Venkataeswara Hospitals, Nandanam, Chennai.
/// These can be overridden at runtime via [updateFromBackend] when the
/// server provides campus coordinates (e.g. from `/api/v1/config/campus`).
class CampusConfig {
  static double _latitude = defaultLatitude;
  static double _longitude = defaultLongitude;
  static double _radiusMeters = defaultRadiusMeters;

  // ── Fallback defaults (hardcoded) ──────────────────────────────────────
  static const double defaultLatitude = 13.02936;
  static const double defaultLongitude = 80.24409;
  static const double defaultRadiusMeters = 200.0;

  // ── Getters ────────────────────────────────────────────────────────────
  static double get latitude => _latitude;
  static double get longitude => _longitude;
  static double get radiusMeters => _radiusMeters;

  /// Update campus boundaries from a backend response map.
  ///
  /// Expected keys: `campusLat`, `campusLng`, `campusRadius`.
  /// Any missing key will leave the current (or default) value unchanged.
  static void updateFromBackend(Map<String, dynamic> data) {
    _latitude = (data['campusLat'] as num?)?.toDouble() ?? _latitude;
    _longitude = (data['campusLng'] as num?)?.toDouble() ?? _longitude;
    _radiusMeters = (data['campusRadius'] as num?)?.toDouble() ?? _radiusMeters;
  }

  /// Reset to hardcoded defaults (useful for testing).
  static void resetToDefaults() {
    _latitude = defaultLatitude;
    _longitude = defaultLongitude;
    _radiusMeters = defaultRadiusMeters;
  }
}
