import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/api/vhhealth_api.dart';

void main() {
  test('live HL7 request omits the recovery property', () {
    const request = Hl7InboundReceiveRequest(message: 'MSH|live');

    expect(request.toJson(), <String, dynamic>{'message': 'MSH|live'});
    expect(request.toJson().containsKey('recovery'), isFalse);
  });

  test('recovery HL7 request serializes the typed closed envelope', () {
    final recovery = Hl7I03RecoveryEnvelope.fromJson(<String, dynamic>{
      'schema': 'vhhealth.i03.adt-orm-sequence/v1',
      'interface_family': 'I03',
      'arrival_class': 'recovery_backlog',
      'tenant_id': '11111111-1111-4111-8111-111111111111',
      'signing_credential_id': '42',
      'offset_id': '22222222-2222-4222-8222-222222222222',
      'source_partition': 'i03/credential/42/family/adt',
      'generation': 1,
      'source_position': '7',
      'source_token': List<String>.filled(64, 'a').join(),
      'predecessor_token': List<String>.filled(64, 'b').join(),
      'duplicate_key': List<String>.filled(64, 'c').join(),
      'message_family': 'adt',
      'message_type': 'ADT',
      'trigger_event': 'A01',
      'message_control_id': 'MSG-7',
      'message_sha256': List<String>.filled(64, 'd').join(),
      'source_observed_at': '2026-08-06T12:00:00.000Z',
      'source_received_at': '2026-08-06T12:00:01.000Z',
      'clock_evidence': <String, dynamic>{
        'source_clock_id': 'sender-clock',
        'synchronized_at': '2026-08-06T11:59:59.000Z',
        'maximum_error_ms': 1000,
      },
    });
    final request = Hl7InboundReceiveRequest(
      message: 'MSH|recovery',
      recovery: recovery,
    );

    expect(request.toJson()['recovery'], recovery.toJson());
  });
}
