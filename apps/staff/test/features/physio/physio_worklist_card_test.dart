import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/physio/models/physio_models.dart';
import 'package:vhhealth_staff/features/physio/widgets/physio_worklist_card.dart';

void main() {
  testWidgets('physio worklist card renders backend referral mapping', (
    tester,
  ) async {
    final item = PhysioWorklistItem.fromJson({
      'follow_up_plan_id': 4401,
      'patient_uid': '11111111-1111-4111-8111-111111111111',
      'patient_name': 'Asha Rao',
      'origin_kind': 'discharge',
      'follow_up_status': 'open',
      'reason': 'Physiotherapy discharge mobilisation review',
      'care_plan_id': 4421,
      'care_plan_name': 'Post-discharge gait rehab',
      'latest_assessment_id': 4411,
      'latest_outcome_score': '74',
    });

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: PhysioWorklistCard(item: item)),
      ),
    );

    expect(find.text('Asha Rao'), findsOneWidget);
    expect(find.text('Discharge'), findsOneWidget);
    expect(find.text('Post-discharge gait rehab'), findsOneWidget);
    expect(find.text('Outcome 74'), findsOneWidget);
  });
}
