import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/doctor/screens/queue_screen.dart';

void main() {
  test('queue uses the canonical backend in-progress status', () {
    expect(queueInProgressFilterStatus, 'IN_PROGRESS');
    expect(queueInProgressUpdateStatus, 'IN_PROGRESS');
    expect(queueInProgressFilterStatus, isNot(contains('-')));
    expect(queueInProgressUpdateStatus, isNot(contains('-')));
  });
}
