import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/features/safety/screens/safety_center_screen.dart';

void main() {
  group('Safety Center ownership helpers', () {
    test('routes critical lab alerts to lab and treating doctor ownership', () {
      final item = NotificationItem(
        id: '1',
        title: 'Critical potassium',
        body: 'K+ 6.7',
        timestamp: DateTime(2026, 6, 3, 10),
        type: 'CRITICAL_LAB_RESULT',
        priority: 'CRITICAL',
      );

      expect(safetyOwnerForAlert(item), 'Lab / treating doctor');
      expect(
        safetyEscalationLabel(item, now: DateTime(2026, 6, 3, 10, 5)),
        'Escalates in 10 min if unread',
      );
      expect(
        safetyEscalationLabel(item, now: DateTime(2026, 6, 3, 10, 20)),
        'Escalated until acknowledged',
      );
    });

    test('maps discharge blockers to the accountable department', () {
      expect(
        safetyOwnerForDischargeBlocker({
          'code': 'NO_INVOICE',
          'message': 'Finalized IPD invoice missing',
        }),
        'Billing',
      );
      expect(
        safetyOwnerForDischargeBlocker({
          'type': 'pharmacy',
          'message': 'Discharge drugs not dispensed',
        }),
        'Pharmacy',
      );
      expect(
        safetyOwnerForDischargeBlocker({
          'message': 'Discharge summary must be signed',
        }),
        'Doctor',
      );
    });

    test('renders housekeeping SLA timing without needing UI state', () {
      expect(
        safetyHousekeepingSlaLabel({
          'sla_due_at': '2026-06-03T10:30:00.000Z',
        }, now: DateTime.parse('2026-06-03T10:00:00.000Z').toLocal()),
        startsWith('Due in'),
      );
      expect(
        safetyHousekeepingSlaLabel({
          'sla_due_at': '2026-06-03T09:30:00.000Z',
        }, now: DateTime.parse('2026-06-03T10:00:00.000Z').toLocal()),
        startsWith('Overdue'),
      );
    });
  });
}
