import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_staff/features/dental/models/dental_models.dart';
import 'package:vhhealth_staff/features/dental/services/dental_api_service.dart';

void main() {
  group('DentalApiService', () {
    test(
      'loads a patient odontogram through the dental chart endpoint',
      () async {
        final transport = _FakeDentalTransport();
        transport.nextGet = _ok({
          'chart': {
            'patient_uid': 'patient-1',
            'active_finding_count': 1,
            'teeth': {
              '36': {
                'findings': [
                  {
                    'id': 7,
                    'tooth_fdi': '36',
                    'finding': 'caries',
                    'status': 'active',
                  },
                ],
              },
            },
            'procedures': const [],
          },
        });

        final chart = await DentalApiService(transport).getChart('patient 1');

        expect(
          transport.gets.single.path,
          '/dental/patients/patient%201/chart',
        );
        expect(chart.patientUid, 'patient-1');
        expect(chart.activeFindingCount, 1);
        expect(chart.summaryFor('36').findings.single.finding, 'caries');
      },
    );

    test(
      'records findings with FDI tooth, surface, severity, and notes',
      () async {
        final transport = _FakeDentalTransport();
        transport.nextPost = _ok({
          'finding': {
            'id': 8,
            'tooth_fdi': '46',
            'surface': 'occlusal',
            'finding': 'fracture',
            'severity': 'moderate',
          },
        });

        final finding = await DentalApiService(transport).recordFinding(
          patientUid: 'patient-2',
          draft: const DentalFindingDraft(
            toothFdi: '46',
            surface: 'occlusal',
            finding: 'fracture',
            severity: 'moderate',
            notes: 'Sharp cusp',
          ),
        );

        expect(transport.posts.single.path, '/dental/findings');
        expect(transport.posts.single.body, {
          'patient_uid': 'patient-2',
          'tooth_fdi': '46',
          'finding': 'fracture',
          'surface': 'occlusal',
          'severity': 'moderate',
          'notes': 'Sharp cusp',
        });
        expect(finding.id, 8);
        expect(finding.toothFdi, '46');
      },
    );

    test('completes a procedure and omits blank optional fields', () async {
      final transport = _FakeDentalTransport();
      transport.nextPost = _ok({
        'procedure': {
          'id': 12,
          'procedure_name': 'Composite restoration',
          'procedure_code': 'D2391',
          'status': 'completed',
        },
      });

      final procedure = await DentalApiService(transport).completeProcedure(
        procedureId: 12,
        materials: 'A2 composite',
        anesthesia: '',
      );

      expect(transport.posts.single.path, '/dental/procedures/12/complete');
      expect(transport.posts.single.body, {'materials': 'A2 composite'});
      expect(procedure.status, 'completed');
    });
  });
}

class _CapturedRequest {
  final String path;
  final Map<String, dynamic>? body;
  final Map<String, String>? queryParameters;

  const _CapturedRequest({required this.path, this.body, this.queryParameters});
}

class _FakeDentalTransport implements DentalApiTransport {
  final gets = <_CapturedRequest>[];
  final posts = <_CapturedRequest>[];
  ApiResponse? nextGet;
  ApiResponse? nextPost;

  @override
  Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
  }) async {
    gets.add(_CapturedRequest(path: path, queryParameters: queryParameters));
    return nextGet ?? _ok(const {});
  }

  @override
  Future<ApiResponse> post(String path, {Map<String, dynamic>? body}) async {
    posts.add(_CapturedRequest(path: path, body: body));
    return nextPost ?? _ok(const {});
  }
}

ApiResponse _ok(Map<String, dynamic> data) {
  return ApiResponse(
    statusCode: 200,
    isSuccess: true,
    data: data,
    raw: {'data': data},
  );
}
