import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_report_models.dart';

void main() {
  test('report template parses ordered sections and JSON-schema fields', () {
    final template = CathReportTemplate.fromJson({
      'id': '17',
      'template_code': 'PTCA_STARTER_V1',
      'name': 'PTCA starter',
      'report_type': 'ptca',
      'version': 2,
      'sections': [
        {'key': 'findings', 'title': 'Findings', 'required': true, 'order': 2},
        {'key': 'indication', 'title': 'Indication', 'order': 1},
      ],
      'coded_fields_schema': {
        'type': 'object',
        'required': ['stent_count'],
        'properties': {
          'vessels_treated': {
            'type': 'array',
            'title': 'Vessels treated',
            'items': {
              'type': 'string',
              'enum': ['lad', 'lcx', 'rca'],
            },
          },
          'stent_count': {'type': 'integer', 'title': 'Stent count'},
        },
      },
      'metadata': {'starter': true},
    });

    expect(template.id, 17);
    expect(template.reportType, 'ptca');
    expect(template.sections.map((section) => section.key), [
      'indication',
      'findings',
    ]);
    expect(template.sections.last.required, isTrue);
    expect(template.codedFields.first.isArray, isTrue);
    expect(template.codedFields.first.options, ['lad', 'lcx', 'rca']);
    expect(template.codedFields.last.isInteger, isTrue);
    expect(template.codedFields.last.required, isTrue);
    expect(template.isStarter, isTrue);
  });

  test(
    'report and viewer models preserve lifecycle, addenda, and PACS state',
    () {
      final report = CathProcedureReport.fromJson({
        'id': '91',
        'case_id': 42,
        'patient_uid': '11111111-1111-4111-8111-111111111111',
        'report_type': 'angiogram',
        'status': 'signed',
        'template_id': 17,
        'template_version': 2,
        'narrative_sections': [
          {
            'key': 'findings',
            'title': 'Findings',
            'text': 'Single-vessel disease',
          },
        ],
        'coded_fields': {'dominance': 'right'},
        'signed_by_name': 'Dr Rao',
        'signed_at': '2026-07-11T08:30:00.000Z',
        'report_tat_minutes': '24',
        'addenda': [
          {
            'id': 3,
            'reason': 'Clarification',
            'narrative': 'Corrected vessel segment.',
          },
        ],
      });

      expect(report.isSigned, isTrue);
      expect(report.narrativeSections['findings'], 'Single-vessel disease');
      expect(report.reportTatMinutes, 24);
      expect(report.addenda.single.reason, 'Clarification');

      final viewer = CathViewerLink.fromJson({
        'viewer_url': null,
        'viewer_status': 'pacs_not_configured',
      });
      expect(viewer.isPacsConfigured, isFalse);
      expect(viewer.canOpen, isFalse);
    },
  );

  test(
    'fallback template preserves structured object and object-array fields',
    () {
      final report = CathProcedureReport.fromJson({
        'id': 91,
        'case_id': 42,
        'patient_uid': '11111111-1111-4111-8111-111111111111',
        'report_type': 'ptca',
        'status': 'draft',
        'template_id': 17,
        'template_version': 1,
        'narrative_sections': [
          {'key': 'findings', 'title': 'Findings', 'text': 'Draft finding'},
        ],
        'coded_fields': {
          'hemodynamics': {'aortic_pressure': '120/80'},
          'stents': [
            {'vessel': 'LAD', 'length_mm': 18},
          ],
        },
      });

      final fallback = CathReportTemplate.forReport(report);

      expect(
        fallback.codedFields
            .singleWhere((field) => field.key == 'hemodynamics')
            .isObject,
        isTrue,
      );
      expect(
        fallback.codedFields
            .singleWhere((field) => field.key == 'stents')
            .isArrayOfObjects,
        isTrue,
      );
    },
  );

  test('report draft serializes narrative sections in backend array shape', () {
    const draft = CathReportDraft(
      templateId: 17,
      reportType: 'ptca',
      narrativeSections: {'findings': 'Successful PCI'},
      narrativeSectionTitles: {'findings': 'Findings'},
      codedFields: {'stent_count': 1},
    );

    expect(draft.toJson()['narrative_sections'], [
      {'key': 'findings', 'title': 'Findings', 'text': 'Successful PCI'},
    ]);
  });
}
