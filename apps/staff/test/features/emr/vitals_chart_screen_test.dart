import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/emr/screens/vitals_chart_screen.dart';

void main() {
  test('records consciousness with ACVPU option order', () {
    expect(vitalsConsciousnessOptionCodes, ['A', 'C', 'V', 'P', 'U']);
  });

  group('normalizeVitalsConsciousness', () {
    test('keeps backend AVPU consciousness codes unchanged', () {
      expect(normalizeVitalsConsciousness('A'), 'A');
      expect(normalizeVitalsConsciousness('C'), 'C');
      expect(normalizeVitalsConsciousness('V'), 'V');
      expect(normalizeVitalsConsciousness('P'), 'P');
      expect(normalizeVitalsConsciousness('U'), 'U');
    });

    test('converts legacy UI labels to backend consciousness codes', () {
      expect(normalizeVitalsConsciousness('Alert'), 'A');
      expect(normalizeVitalsConsciousness('Confused'), 'C');
      expect(normalizeVitalsConsciousness('Verbal'), 'V');
      expect(normalizeVitalsConsciousness('Responds to Voice'), 'V');
      expect(normalizeVitalsConsciousness('Pain'), 'P');
      expect(normalizeVitalsConsciousness('Responds to Pain'), 'P');
      expect(normalizeVitalsConsciousness('Unresponsive'), 'U');
    });

    test('accepts display labels prefixed with a consciousness code', () {
      expect(normalizeVitalsConsciousness('A - Alert'), 'A');
      expect(normalizeVitalsConsciousness('V - Responds to Voice'), 'V');
    });
  });

  group('buildVitalsRecordPayload', () {
    test('uses backend EMR vitals field names', () {
      final payload = buildVitalsRecordPayload(
        patientUid: 'PAT-1',
        hr: '82 /min',
        bpSystolic: '120 mm Hg',
        bpDiastolic: '78 mm Hg',
        temp: '98.6 deg F',
        spo2: '98%',
        rr: '18 /min',
        glucose: '110 mg/dl',
        pain: '2 /10',
        gcs: '15 /15',
        consciousness: 'Alert',
      );

      expect(payload['patient_uid'], 'PAT-1');
      expect(payload['heart_rate'], 82);
      expect(payload['systolic_bp'], 120);
      expect(payload['diastolic_bp'], 78);
      // The sheet collects °F, so the payload must say so explicitly — the
      // backend treats a unitless temperature as °C and would reject 98.6
      // against the 30–45 °C plausibility band (losing the whole record).
      expect(payload['temperature'], 98.6);
      expect(payload['temperature_unit'], 'F');
      expect(payload['spo2'], 98);
      expect(payload['respiratory_rate'], 18);
      expect(payload['blood_glucose'], 110);
      expect(payload['pain_score'], 2);
      expect(payload['gcs_score'], 15);
      expect(payload['consciousness'], 'A');

      expect(payload.containsKey('bp_systolic'), isFalse);
      expect(payload.containsKey('bp_diastolic'), isFalse);
      expect(payload.containsKey('glucose'), isFalse);
      expect(payload.containsKey('gcs'), isFalse);
    });

    test('omits temperature_unit when no temperature was entered', () {
      final payload = buildVitalsRecordPayload(
        patientUid: 'PAT-1',
        hr: '82',
        bpSystolic: '',
        bpDiastolic: '',
        temp: '',
        spo2: '',
        rr: '',
        glucose: '',
        pain: '',
        gcs: '',
        consciousness: 'A',
      );

      expect(payload.containsKey('temperature'), isFalse);
      expect(payload.containsKey('temperature_unit'), isFalse);
    });
  });

  group('temperature display conversion (canonical °C → shown °F)', () {
    test('converts backend Celsius values to the Fahrenheit column', () {
      expect(vitalsTemperatureDisplayF(37.0), closeTo(98.6, 0.01));
      expect(vitalsTemperatureDisplayF(40.0), closeTo(104.0, 0.01));
      expect(vitalsTemperatureDisplayF('36.5'), closeTo(97.7, 0.01));
    });

    test('returns null for absent or non-numeric values', () {
      expect(vitalsTemperatureDisplayF(null), isNull);
      expect(vitalsTemperatureDisplayF('n/a'), isNull);
    });
  });

  group('buildIORecordPayload', () {
    test('uses backend I/O field names', () {
      final payload = buildIORecordPayload(
        patientUid: 'PAT-1',
        type: 'intake',
        category: 'oral',
        amount: '250',
        description: 'water',
      );

      expect(payload['patient_uid'], 'PAT-1');
      expect(payload['io_type'], 'intake');
      expect(payload['category'], 'oral');
      expect(payload['amount_ml'], 250);
      expect(payload['description'], 'water');
      expect(payload.containsKey('type'), isFalse);
    });
  });

  group('extractVitalsChartRows', () {
    test('reads full vitals chart rows from the API data wrapper', () {
      final rows = extractVitalsChartRows({
        'data': [
          {'heart_rate': 82, 'recorded_at': '2026-06-01T10:00:00Z'},
          {'heart_rate': 75, 'recorded_at': '2026-05-31T08:00:00Z'},
        ],
      });

      expect(rows, hasLength(2));
      expect(rows.first['heart_rate'], 82);
    });

    test('also accepts vitals and records wrappers', () {
      expect(
        extractVitalsChartRows({
          'vitals': [
            {'spo2': 98},
          ],
        }),
        hasLength(1),
      );
      expect(
        extractVitalsChartRows({
          'records': [
            {'spo2': 97},
          ],
        }),
        hasLength(1),
      );
    });
  });

  group('NEWS2 banner (audit W2-H2)', () {
    test('severity bands by score, with clinical_risk as tie-breaker', () {
      expect(news2SeverityToken(8, 'high'), 'critical');
      expect(news2SeverityToken(7, 'medium'), 'critical');
      expect(news2SeverityToken(5, 'medium'), 'high');
      expect(news2SeverityToken(6, 'low'), 'high');
      // A single-parameter high-risk trigger bands up even at a low total.
      expect(news2SeverityToken(3, 'high'), 'critical');
      expect(news2SeverityToken(2, 'low_to_medium'), 'medium');
      expect(news2SeverityToken(0, 'low'), 'low');
    });

    test('extracts a banner from a high-score record-vitals response', () {
      final banner = extractNews2Banner({
        'vitals': {'id': 1},
        'news2': {'total_score': 8, 'clinical_risk': 'high'},
        'alerts': [],
      });

      expect(banner, isNotNull);
      expect(banner!.totalScore, 8);
      expect(banner.clinicalRisk, 'high');
      expect(banner.severity, 'critical');
      expect(banner.shouldEscalate, isTrue);
    });

    test('tolerates the risk_level alias and numeric-string scores', () {
      final banner = extractNews2Banner({
        'news2': {'total_score': '5', 'risk_level': 'medium'},
      });

      expect(banner, isNotNull);
      expect(banner!.totalScore, 5);
      expect(banner.severity, 'high');
      expect(banner.shouldEscalate, isTrue);
    });

    test('a sub-threshold score does not escalate', () {
      final banner = extractNews2Banner({
        'news2': {'total_score': 2, 'clinical_risk': 'low_to_medium'},
      });

      expect(banner, isNotNull);
      expect(banner!.shouldEscalate, isFalse);
      expect(banner.severity, 'medium');
    });

    test('returns null when there is no usable NEWS2 payload', () {
      expect(extractNews2Banner(null), isNull);
      expect(extractNews2Banner({'vitals': {}}), isNull);
      expect(extractNews2Banner({'news2': 'nope'}), isNull);
      expect(
        extractNews2Banner({
          'news2': {'clinical_risk': 'high'},
        }),
        isNull,
      );
    });
  });

  group('vitals and I/O history filters', () {
    test('formats vitals timestamps with dd/mm date and time', () {
      expect(recordDateTimeLabel(DateTime(2026, 6, 2, 7, 5)), '02/06 07:05');
      expect(recordDateTimeLabel(null), '-');
    });

    test('splits current and previous vitals around the last 24h', () {
      final now = DateTime(2026, 6, 1, 12);
      final rows = [
        {
          'heart_rate': 82,
          'recorded_at': now
              .subtract(const Duration(hours: 2))
              .toIso8601String(),
        },
        {
          'heart_rate': 75,
          'recorded_at': now
              .subtract(const Duration(hours: 30))
              .toIso8601String(),
        },
      ];

      expect(filterVitalsRowsLast24h(rows, now: now).single['heart_rate'], 82);
      expect(
        filterVitalsRowsBeforeLast24h(rows, now: now).single['heart_rate'],
        75,
      );
    });

    test('extracts previous-day I/O entries from chart rows', () {
      final now = DateTime(2026, 6, 1, 12);
      final rows = extractIOChartRows({
        'data': [
          {
            'io_type': 'intake',
            'amount_ml': 100,
            'recorded_at': DateTime(2026, 6, 1, 8).toIso8601String(),
          },
          {
            'io_type': 'output',
            'amount_ml': 50,
            'recorded_at': DateTime(2026, 5, 31, 23).toIso8601String(),
          },
        ],
      });

      final previous = filterIOEntriesBeforeToday(rows, now: now);
      expect(previous, hasLength(1));
      expect(previous.single['io_type'], 'output');
    });
  });
}
