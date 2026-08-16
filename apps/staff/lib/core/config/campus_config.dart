import 'package:flutter/foundation.dart';

import '../services/api_client.dart';

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

  /// Whether a backend fetch has already succeeded this session.
  static bool _fetched = false;

  /// Fetch campus location from the backend and update in-place.
  ///
  /// Calls `GET /config/campus-locations`. On success, updates the campus
  /// coordinates via [updateFromBackend]. On any failure (network error,
  /// missing endpoint, bad payload) the hardcoded defaults are kept silently.
  ///
  /// This is safe to call multiple times — after the first successful fetch
  /// it becomes a no-op for the rest of the session.
  static Future<void> fetchFromBackend() async {
    if (_fetched) return;
    try {
      final resp = await ApiClient.get('/config/campus-locations');
      if (resp.isSuccess && resp.raw is Map) {
        final raw = resp.raw as Map<String, dynamic>;
        // Backend envelope: { success: true, data: { campusLat, campusLng, campusRadius } }
        final data = (raw['data'] as Map<String, dynamic>?) ?? raw;
        updateFromBackend(data);
        _fetched = true;
        debugPrint(
          '[CampusConfig] Updated from backend: '
          'lat=$_latitude, lng=$_longitude, radius=$_radiusMeters',
        );
      }
    } catch (e) {
      // Silently fall back to defaults — attendance will use hardcoded location.
      debugPrint('[CampusConfig] Backend fetch failed, using defaults: $e');
    }
  }
}
