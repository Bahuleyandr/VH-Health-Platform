import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_report_models.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_report_editor.dart';

void main() {
  testWidgets(
    'editor renders template sections and submits structured fields',
    (tester) async {
      CathReportDraft? saved;
      const template = CathReportTemplate(
        id: 17,
        templateCode: 'PTCA_STARTER_V1',
        name: 'PTCA starter',
        reportType: 'ptca',
        version: 1,
        sections: [
          CathReportSectionDefinition(
            key: 'indication',
            title: 'Indication',
            order: 1,
            required: true,
          ),
          CathReportSectionDefinition(
            key: 'findings',
            title: 'Findings',
            order: 2,
          ),
        ],
        codedFields: [
          CathReportFieldDefinition(
            key: 'stent_count',
            title: 'Stent count',
            type: 'integer',
            order: 1,
            required: true,
          ),
          CathReportFieldDefinition(
            key: 'device',
            title: 'Device',
            type: 'object',
            order: 2,
          ),
        ],
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: CathReportEditor(
              templates: const [template],
              onSave: (draft) async => saved = draft,
            ),
          ),
        ),
      );

      expect(find.text('Narrative sections'), findsOneWidget);
      expect(find.text('Indication'), findsOneWidget);
      expect(find.text('Findings'), findsOneWidget);
      expect(find.text('Structured fields'), findsOneWidget);
      expect(find.text('Stent count'), findsOneWidget);

      await tester.enterText(
        find.byKey(const ValueKey('cath-report-section-indication')),
        'Acute coronary syndrome',
      );
      await tester.enterText(
        find.byKey(const ValueKey('cath-report-coded-stent_count')),
        '2',
      );
      await tester.enterText(
        find.byKey(const ValueKey('cath-report-coded-device')),
        '{"model":"Synthetic DES"}',
      );
      await tester.drag(find.byType(ListView), const Offset(0, -500));
      await tester.pumpAndSettle();
      final save = find.byKey(const ValueKey('cath-report-save'));
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();

      expect(saved, isNotNull);
      expect(saved!.templateId, 17);
      expect(saved!.reportType, 'ptca');
      expect(saved!.narrativeSections['indication'], 'Acute coronary syndrome');
      expect(saved!.codedFields['stent_count'], 2);
      expect(saved!.codedFields['device'], {'model': 'Synthetic DES'});
    },
  );
}
