import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/config/patient_notification_contract.g.dart';
import 'package:vhhealth/core/services/deep_link_service.dart';

void main() {
  group('generated patient notification contract', () {
    test('every active inbox type has complete patient-session policy', () {
      final inboxContracts = patientNotificationContracts.values
          .where((contract) => contract.inboxSupported)
          .toList();

      expect(inboxContracts, isNotEmpty);
      for (final contract in inboxContracts) {
        expect(contract.type, contract.feedType, reason: contract.type);
        expect(contract.authPolicy, 'current_patient_session');
        expect(contract.biometricPolicy, 'notification_inbox_gate');
        expect(contract.acknowledgement, 'mark_read');
        expect(contract.expiry, 'source_authoritative');
        expect(contract.owner, isNotEmpty);
      }
    });

    test(
      'secure-message hydration accepts only positive stable thread ids',
      () {
        final contract = patientNotificationContractFor('patient_message')!;

        expect(contract.resolveRoute({'thread_id': 42}), '/portal/messages/42');
        expect(contract.resolveRoute({'thread_id': '7'}), '/portal/messages/7');
        for (final value in <Object?>[
          null,
          '',
          0,
          -1,
          '+1',
          '0007',
          'abc',
          '42/edit',
        ]) {
          expect(
            contract.resolveRoute({'thread_id': value}),
            '/portal/messages',
            reason: '$value',
          );
        }
      },
    );

    test('every registered destination survives the deep-link allowlist', () {
      for (final contract in patientNotificationContracts.values) {
        final payload = <String, dynamic>{'type': contract.type};
        for (final id in contract.stableHydrationIds) {
          payload[id] = 42;
        }
        final expected = contract.resolveRoute(payload);
        expect(
          DeepLinkService.parseNotificationRoute(payload),
          expected,
          reason: contract.type,
        );
      }
    });

    test('engagement is intentionally acknowledge-only', () {
      expect(patientNotificationContractFor('engagement_campaign'), isNotNull);
      expect(
        patientNotificationContractFor('engagement_campaign')!.action,
        PatientNotificationActionKind.acknowledgeOnly,
      );
      expect(
        patientNotificationContractFor('engagement_campaign')!.resolveRoute({}),
        '/notifications',
      );
    });

    test(
      'transport aliases resolve but cannot be persisted as inbox types',
      () {
        for (final type in <String>[
          'appointment_reminder_24h',
          'secure_message',
          'payment_link',
        ]) {
          final contract = patientNotificationContractFor(type)!;
          expect(contract.lifecycle, 'legacy_alias');
          expect(contract.inboxSupported, isFalse);
          expect(contract.feedType, isNot(type));
        }
      },
    );
  });
}
