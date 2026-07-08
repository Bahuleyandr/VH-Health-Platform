import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/ophthalmology/widgets/ophthalmology_eye_entry_panel.dart';

void main() {
  testWidgets('builds an OD/OS ophthalmology exam payload', (tester) async {
    Map<String, dynamic>? submitted;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: OphthalmologyEyeEntryPanel(
            onSubmit: (payload) async {
              submitted = payload;
            },
          ),
        ),
      ),
    );

    await tester.enterText(
      find.byKey(const Key('ophtho_patient_uid')),
      '11111111-1111-4111-8111-111111111111',
    );
    await tester.enterText(find.byKey(const Key('ophtho_od_va')), '6/18');
    await tester.enterText(find.byKey(const Key('ophtho_os_va')), '6/12');
    await tester.enterText(find.byKey(const Key('ophtho_od_iop')), '22');
    await tester.enterText(find.byKey(const Key('ophtho_os_iop')), '16');
    await tester.enterText(
      find.byKey(const Key('ophtho_od_anterior')),
      'Quiet anterior chamber',
    );
    await tester.enterText(
      find.byKey(const Key('ophtho_os_anterior')),
      'Clear cornea',
    );
    await tester.enterText(
      find.byKey(const Key('ophtho_diagnosis')),
      'Immature cataract',
    );

    final submit = find.byKey(const Key('ophtho_submit_exam'));
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await tester.pumpAndSettle();

    expect(submitted, isNotNull);
    expect(submitted!['patient_uid'], '11111111-1111-4111-8111-111111111111');
    expect(submitted!['exam_type'], 'comprehensive');
    expect(submitted!['od_va_unaided'], '6/18');
    expect(submitted!['os_va_unaided'], '6/12');
    expect(submitted!['od_iop_mmhg'], 22);
    expect(submitted!['os_iop_mmhg'], 16);
    expect(submitted!['iop_method'], 'gat');
    expect(submitted!['od_anterior_segment'], 'Quiet anterior chamber');
    expect(submitted!['os_anterior_segment'], 'Clear cornea');
    expect(submitted!['diagnosis'], 'Immature cataract');
  });
}
