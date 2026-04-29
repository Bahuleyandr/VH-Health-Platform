// test/core/config/campus_config_test.dart
//
// Unit tests for CampusConfig — default values, updateFromBackend overrides,
// and resetToDefaults.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/campus_config.dart';

void main() {
  // Reset state before each test so tests don't leak into each other.
  setUp(() {
    CampusConfig.resetToDefaults();
  });

  group('CampusConfig — default values', () {
    test('defaultLatitude is 13.02936', () {
      expect(CampusConfig.defaultLatitude, 13.02936);
    });

    test('defaultLongitude is 80.24409', () {
      expect(CampusConfig.defaultLongitude, 80.24409);
    });

    test('defaultRadiusMeters is 200.0', () {
      expect(CampusConfig.defaultRadiusMeters, 200.0);
    });

    test('latitude getter returns default', () {
      expect(CampusConfig.latitude, CampusConfig.defaultLatitude);
    });

    test('longitude getter returns default', () {
      expect(CampusConfig.longitude, CampusConfig.defaultLongitude);
    });

    test('radiusMeters getter returns default', () {
      expect(CampusConfig.radiusMeters, CampusConfig.defaultRadiusMeters);
    });
  });

  group('CampusConfig — updateFromBackend', () {
    test('updates all values when all keys are present', () {
      CampusConfig.updateFromBackend({
        'campusLat': 12.9716,
        'campusLng': 77.5946,
        'campusRadius': 500.0,
      });

      expect(CampusConfig.latitude, 12.9716);
      expect(CampusConfig.longitude, 77.5946);
      expect(CampusConfig.radiusMeters, 500.0);
    });

    test('updates only latitude when only campusLat is present', () {
      CampusConfig.updateFromBackend({'campusLat': 10.0});

      expect(CampusConfig.latitude, 10.0);
      expect(CampusConfig.longitude, CampusConfig.defaultLongitude);
      expect(CampusConfig.radiusMeters, CampusConfig.defaultRadiusMeters);
    });

    test('updates only longitude when only campusLng is present', () {
      CampusConfig.updateFromBackend({'campusLng': 99.99});

      expect(CampusConfig.latitude, CampusConfig.defaultLatitude);
      expect(CampusConfig.longitude, 99.99);
      expect(CampusConfig.radiusMeters, CampusConfig.defaultRadiusMeters);
    });

    test('updates only radius when only campusRadius is present', () {
      CampusConfig.updateFromBackend({'campusRadius': 1000.0});

      expect(CampusConfig.latitude, CampusConfig.defaultLatitude);
      expect(CampusConfig.longitude, CampusConfig.defaultLongitude);
      expect(CampusConfig.radiusMeters, 1000.0);
    });

    test('leaves values unchanged for empty map', () {
      CampusConfig.updateFromBackend({});

      expect(CampusConfig.latitude, CampusConfig.defaultLatitude);
      expect(CampusConfig.longitude, CampusConfig.defaultLongitude);
      expect(CampusConfig.radiusMeters, CampusConfig.defaultRadiusMeters);
    });

    test('handles int values by converting to double', () {
      CampusConfig.updateFromBackend({
        'campusLat': 13,
        'campusLng': 80,
        'campusRadius': 300,
      });

      expect(CampusConfig.latitude, 13.0);
      expect(CampusConfig.longitude, 80.0);
      expect(CampusConfig.radiusMeters, 300.0);
    });

    test('ignores unrelated keys', () {
      CampusConfig.updateFromBackend({
        'campusLat': 11.0,
        'someOtherKey': 'value',
        'anotherKey': 42,
      });

      expect(CampusConfig.latitude, 11.0);
      expect(CampusConfig.longitude, CampusConfig.defaultLongitude);
      expect(CampusConfig.radiusMeters, CampusConfig.defaultRadiusMeters);
    });

    test('successive updates accumulate (not reset between calls)', () {
      CampusConfig.updateFromBackend({'campusLat': 1.0});
      CampusConfig.updateFromBackend({'campusLng': 2.0});
      CampusConfig.updateFromBackend({'campusRadius': 3.0});

      expect(CampusConfig.latitude, 1.0);
      expect(CampusConfig.longitude, 2.0);
      expect(CampusConfig.radiusMeters, 3.0);
    });

    test('null values in map leave current value unchanged', () {
      CampusConfig.updateFromBackend({
        'campusLat': 50.0,
        'campusLng': null,
        'campusRadius': null,
      });

      expect(CampusConfig.latitude, 50.0);
      expect(CampusConfig.longitude, CampusConfig.defaultLongitude);
      expect(CampusConfig.radiusMeters, CampusConfig.defaultRadiusMeters);
    });
  });

  group('CampusConfig — resetToDefaults', () {
    test('resets all values to hardcoded defaults', () {
      CampusConfig.updateFromBackend({
        'campusLat': 1.0,
        'campusLng': 2.0,
        'campusRadius': 3.0,
      });

      CampusConfig.resetToDefaults();

      expect(CampusConfig.latitude, CampusConfig.defaultLatitude);
      expect(CampusConfig.longitude, CampusConfig.defaultLongitude);
      expect(CampusConfig.radiusMeters, CampusConfig.defaultRadiusMeters);
    });

    test('resetToDefaults is idempotent', () {
      CampusConfig.resetToDefaults();
      CampusConfig.resetToDefaults();

      expect(CampusConfig.latitude, CampusConfig.defaultLatitude);
      expect(CampusConfig.longitude, CampusConfig.defaultLongitude);
      expect(CampusConfig.radiusMeters, CampusConfig.defaultRadiusMeters);
    });
  });
}
