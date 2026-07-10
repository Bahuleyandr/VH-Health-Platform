import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/emr/widgets/icu_chart_depth_panel.dart';

void main() {
  testWidgets('renders ICU chart device and score depth', (tester) async {
    final chart = {
      'summary': {
        'device_vitals_count': 2,
        'unverified_device_vitals_count': 1,
        'active_line_count': 1,
        'ventilation_episode_count': 1,
        'weaning_trial_count': 1,
        'scoring_output_count': 1,
      },
      'device_vitals': [
        {
          'source_device': 'Bedside monitor',
          'heart_rate': 88,
          'spo2': 96,
          'systolic_bp': 120,
          'diastolic_bp': 76,
        },
      ],
      'ventilation_episodes': [
        {
          'mode': 'pressure_support',
          'oxygen_device': 'ventilator',
          'airway_type': 'ett',
          'stopped_at': null,
        },
      ],
      'line_presence': [
        {
          'presence_kind': 'central_line',
          'display_label': 'Right IJ central line',
          'denominator_device_type': 'central_line',
          'stopped_at': null,
        },
      ],
      'weaning_trials': [
        {'trial_kind': 'sbt'},
      ],
      'scoring_outputs': [
        {
          'scoring_kind': 'sofa',
          'score_value': 6,
          'review_status': 'reviewed',
          'order_mutation_performed': false,
        },
      ],
    };

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: IcuChartDepthPanel(chart: chart)),
      ),
    );

    expect(find.text('ICU chart'), findsOneWidget);
    expect(
      find.text('Bedside monitor - HR 88 - SpO2 96 - BP 120/76'),
      findsOneWidget,
    );
    expect(find.textContaining('Right IJ central line'), findsOneWidget);
    expect(find.textContaining('SOFA'), findsOneWidget);
    expect(IcuChartDepthPanel.hasRenderableData(chart), isTrue);
  });
}
