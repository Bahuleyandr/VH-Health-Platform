import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/order_payloads.dart';
import 'package:vhhealth_staff/features/ipd/drug_chart_offline_order.dart';

void main() {
  OfflineOrderIntent build(String deviceType) => buildOfflineOrderIntent(
        deviceType: deviceType,
        patientUid: 'p-uid',
        encounterId: 'enc-1',
        medicationName: 'Paracetamol',
        dose: '500mg',
        route: 'oral',
        frequency: 'BD',
        doseTimes: ['morning', 'night'],
        startDate: DateTime.utc(2026, 6, 27, 9),
      );

  test('phone-mode (mobile) blocks — never enqueues', () {
    final i = build('mobile');
    expect(i.block, isTrue);
    expect(i.enqueue, isFalse);
    expect(i.reason, isNotNull);
  });

  test('empty / unknown deviceType blocks (fail-closed)', () {
    expect(build('').block, isTrue);
    expect(build('   ').block, isTrue);
  });

  test('tablet enqueues with the /emr/orders endpoint', () {
    final i = build('tablet');
    expect(i.block, isFalse);
    expect(i.enqueue, isTrue);
    expect(i.endpoint, '/emr/orders');
    expect(i.reason, isNull);
  });

  test('desktop enqueues', () {
    expect(build('desktop').enqueue, isTrue);
  });

  test('queued body is byte-identical to the online builder', () {
    final i = build('tablet');
    final online = buildInpatientMedicationOrderBody(
      patientUid: 'p-uid',
      encounterId: 'enc-1',
      medicationName: 'Paracetamol',
      dose: '500mg',
      route: 'oral',
      frequency: 'BD',
      doseTimes: ['morning', 'night'],
      startDate: DateTime.utc(2026, 6, 27, 9),
    );
    expect(i.body, online);
  });
}
