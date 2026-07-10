import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/emr/widgets/nicu_picu_chart_panel.dart';

void main() {
  testWidgets('renders dense neonatal rows with governed score provenance', (
    tester,
  ) async {
    final nicu = {
      'summary': {
        'feed_fluid_entry_count': 5,
        'respiratory_support_count': 2,
        'cardiorespiratory_event_count': 1,
        'jaundice_phototherapy_count': 2,
        'thermal_observation_count': 3,
        'score_output_count': 1,
        'unverified_nicu_observation_count': 2,
      },
      'feed_fluid': {
        'entries': [
          {'entry_kind': 'feed', 'feed_type': 'expressed_breast_milk'},
        ],
        'balance': {
          'intake': {'total_ml': 75},
          'output': {'total_ml': 20},
          'net_ml': 55,
          'per_kg': {'net_ml_per_kg': 36.67},
        },
      },
      'respiratory_support': [
        {'support_mode': 'cpap', 'fio2_pct': 30, 'peep_cm_h2o': 5},
      ],
      'cardiorespiratory_events': [
        {
          'event_kind': 'desaturation',
          'lowest_spo2_pct': 78,
          'verification_status': 'unverified',
        },
      ],
      'jaundice_phototherapy': [
        {
          'event_kind': 'phototherapy_started',
          'phototherapy_type': 'double_surface',
        },
      ],
      'thermal_observations': [
        {
          'care_environment': 'incubator',
          'skin_temperature_c': 36.8,
          'humidity_pct': 60,
        },
      ],
      'scoring': {
        'outputs': [
          {
            'score_kind': 'crib_ii',
            'score_value': 7,
            'reference_version': 'v2.1-owner',
            'review_status': 'reviewed',
            'score_available': true,
            'order_mutation_performed': false,
          },
        ],
      },
      'newborn': {
        'linked': true,
        'record': {
          'gestational_age_weeks': 31.5,
          'birth_weight_g': 1500,
          'resuscitation_type': 'bag_mask',
        },
        'apgar_scores': [
          {'time_minute': 1, 'total_score': 6},
          {'time_minute': 5, 'total_score': 8},
        ],
      },
      'growth': {
        'available': true,
        'value_kg': 1.65,
        'percentile': 11.51,
        'source': 'WHO_0_5_approx',
      },
    };

    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: NicuPicuChartPanel(nicu: nicu))),
    );

    expect(find.text('NICU/PICU chart'), findsOneWidget);
    // Weight-adjusted fluid balance line.
    expect(
      find.text('in 75 mL - out 20 mL - net 55 mL - 36.67 mL/kg'),
      findsOneWidget,
    );
    // Respiratory + thermal + jaundice dense rows.
    expect(find.textContaining('cpap - FiO2 30%'), findsOneWidget);
    expect(find.textContaining('incubator - skin 36.8°C'), findsOneWidget);
    expect(find.textContaining('double surface'), findsOneWidget);
    // Newborn substrate reuse: APGAR shown from the maternity record.
    expect(find.textContaining('APGAR 1m 6, 5m 8'), findsOneWidget);
    // NL-5 growth output keeps its labelled source.
    expect(find.textContaining('WHO_0_5_approx'), findsOneWidget);
    // Score output carries version + decision-support-only posture.
    expect(find.textContaining('CRIB_II'), findsOneWidget);
    expect(find.textContaining('v2.1-owner'), findsOneWidget);
    expect(find.textContaining('decision support only'), findsOneWidget);
    // Unverified-device badge count is visible.
    expect(find.text('2'), findsWidgets);
    expect(NicuPicuChartPanel.hasRenderableData(nicu), isTrue);
  });

  testWidgets('shows the fail-closed label for score-unavailable rows', (
    tester,
  ) async {
    final nicu = {
      'summary': {'score_output_count': 1},
      'scoring': {
        'outputs': [
          {
            'score_kind': 'snappe_ii',
            'score_available': false,
            'review_status': 'score_unavailable',
          },
        ],
      },
    };

    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: NicuPicuChartPanel(nicu: nicu))),
    );

    expect(find.textContaining('SNAPPE_II'), findsOneWidget);
    expect(find.textContaining('Score unavailable'), findsOneWidget);
  });

  test('hasRenderableData is false for an empty nicu section', () {
    expect(NicuPicuChartPanel.hasRenderableData(const {}), isFalse);
    expect(
      NicuPicuChartPanel.hasRenderableData(const {
        'summary': {'feed_fluid_entry_count': 0},
      }),
      isFalse,
    );
  });
}
