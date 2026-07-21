import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/clinical_inbox_api_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  test('sends a durable break-glass record id when one is supplied', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.path,
          endsWith('/clinical-inbox/tasks/71/acknowledge'),
        );
        expect(jsonDecode(request.body), {'break_glass_id': 42});
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'id': '71', 'status': 'in_progress'},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final task = await ClinicalInboxApiService.instance.acknowledgeTask(
      '71',
      breakGlassId: 42,
    );

    expect(task.id, '71');
    expect(task.status, 'in_progress');
  });

  test('claims a role queue task with a stable idempotency key', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, endsWith('/clinical-inbox/tasks/72/claim'));
        expect(jsonDecode(request.body), <String, dynamic>{});
        expect(request.headers['idempotency-key'], isNotEmpty);
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'id': '72',
              'status': 'open',
              'assigned_to_uid': 'doctor-1',
              'sla_completion_semantics': 'domain_evidence',
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final task = await ClinicalInboxApiService.instance.claimTask('72');

    expect(task.assignedToUid, 'doctor-1');
    expect(task.slaCompletionSemantics, 'domain_evidence');
  });

  test('records an explicitly attested diagnostic action', () async {
    final snapshotHash = List.filled(64, 'a').join();
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.path,
          endsWith('/clinical-inbox/diagnostic-results/generation-1/actions'),
        );
        expect(request.headers['idempotency-key'], isNotEmpty);
        expect(jsonDecode(request.body), {
          'task_id': 73,
          'disposition': 'referred',
          'clinical_note': 'Reviewed the complete signed generation.',
          'generation_snapshot_sha256': snapshotHash,
          'attested': true,
          'downstream_evidence': {
            'resource_type': 'referral',
            'resource_id': 'ref-8',
          },
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'id': 'action-1',
              'generation_id': 'generation-1',
              'task_id': 73,
              'action_kind': 'doctor_disposition',
              'disposition': 'referred',
              'signature_id': 'signature-1',
              'replayed': false,
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final receipt = await ClinicalInboxApiService.instance
        .recordDiagnosticAction(
          DiagnosticActionCommand(
            generationId: 'generation-1',
            taskId: '73',
            disposition: 'referred',
            clinicalNote: 'Reviewed the complete signed generation.',
            generationSnapshotSha256: snapshotHash,
            downstreamResourceType: 'referral',
            downstreamResourceId: 'ref-8',
          ),
        );

    expect(receipt.actionKind, 'doctor_disposition');
    expect(receipt.signatureId, 'signature-1');
  });

  test('reopens a normal result with a reason and idempotency key', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.path,
          endsWith('/clinical-inbox/diagnostic-results/generation-2/reopen'),
        );
        expect(request.headers['idempotency-key'], isNotEmpty);
        expect(jsonDecode(request.body), {
          'reason': 'Doctor requested a discretionary re-review.',
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'id': 'reopen-1',
              'generation_id': 'generation-2',
              'action_kind': 'doctor_reopened',
              'replayed': false,
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final receipt = await ClinicalInboxApiService.instance
        .reopenDiagnosticResult(
          generationId: 'generation-2',
          reason: 'Doctor requested a discretionary re-review.',
        );

    expect(receipt.actionKind, 'doctor_reopened');
    expect(receipt.generationId, 'generation-2');
  });
}
