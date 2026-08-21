// Pins the vitals-history temperature display projection (finding R1/P2):
// stored patient_vitals temperatures are canonical °C and convert to °F for
// display, but a value above the 45 °C plausibility ceiling is a legacy
// unconverted raw-°F row (pending migration 718) and must render raw +
// flagged instead of as a fabricated ~209 °F number. The trend transform
// drops such values so mixed-unit prev/cur pairs cannot corrupt the arrows.
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/vitals/widgets/vitals_history_tab.dart';

void main() {
  group('vitalsHistoryTemperatureDisplay', () {
    test('canonical °C converts to °F with the °F label', () {
      final t = vitalsHistoryTemperatureDisplay(37.0);
      expect(t, isNotNull);
      expect(t!.value, '98.6');
      expect(t.unit, '°F');
      expect(t.flagged, isFalse);
    });

    test('accepts numeric strings (raw JSON decimals arrive as strings)', () {
      final t = vitalsHistoryTemperatureDisplay('36.5');
      expect(t!.value, '97.7');
      expect(t.flagged, isFalse);
    });

    test('the 45 °C plausibility ceiling itself still converts', () {
      final t = vitalsHistoryTemperatureDisplay(45.0);
      expect(t!.value, '113.0');
      expect(t.unit, '°F');
      expect(t.flagged, isFalse);
    });

    test('legacy raw-°F value renders raw and flagged, never ~209 °F', () {
      final t = vitalsHistoryTemperatureDisplay(98.6);
      expect(t, isNotNull);
      expect(t!.flagged, isTrue);
      expect(t.value, '98.6'); // shown as stored, not converted
      expect(t.unit, isNot('°F'));
    });

    test('just above the ceiling is flagged', () {
      expect(vitalsHistoryTemperatureDisplay(45.1)!.flagged, isTrue);
    });

    test('non-numeric and null return null', () {
      expect(vitalsHistoryTemperatureDisplay(null), isNull);
      expect(vitalsHistoryTemperatureDisplay('n/a'), isNull);
    });
  });

  group('vitalsHistoryTemperatureTrendF', () {
    test('plausible °C converts for the trend row', () {
      expect(vitalsHistoryTemperatureTrendF(37.0), closeTo(98.6, 0.01));
      expect(vitalsHistoryTemperatureTrendF(40.0), closeTo(104.0, 0.01));
    });

    test('implausible legacy value is dropped (null) from the trend', () {
      expect(vitalsHistoryTemperatureTrendF(98.6), isNull);
      expect(vitalsHistoryTemperatureTrendF(45.1), isNull);
    });
  });
}
