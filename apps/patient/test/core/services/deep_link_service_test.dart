import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/deep_link_service.dart';

void main() {
  group('DeepLinkService notification routing', () {
    test('accepts explicit allowlisted backend route', () {
      expect(
        DeepLinkService.parseNotificationRoute({
          'type': 'lab_result_ready',
          'route': '/portal/lab-results',
        }),
        '/portal/lab-results',
      );
    });

    test('rejects explicit non-allowlisted route', () {
      expect(
        DeepLinkService.parseNotificationRoute({
          'type': 'appointment_reminder',
          'route': '/admin/users',
        }),
        isNull,
      );
    });

    test('maps backend type field when route is absent', () {
      expect(
        DeepLinkService.parseNotificationRoute({
          'type': 'appointment_reminder',
        }),
        '/appointments',
      );
      expect(
        DeepLinkService.parseNotificationRoute({'type': 'lab_result_ready'}),
        '/portal/lab-results',
      );
      expect(
        DeepLinkService.parseNotificationRoute({'type': 'payment_link'}),
        '/portal/bills',
      );
      expect(
        DeepLinkService.parseNotificationRoute({'type': 'secure_message'}),
        '/portal/messages',
      );
    });

    test('allows numeric detail routes but rejects malformed detail paths', () {
      expect(
        DeepLinkService.parseNotificationRoute({'route': '/portal/bills/42'}),
        '/portal/bills/42',
      );
      expect(
        DeepLinkService.parseNotificationRoute({
          'route': '/portal/bills/42/edit',
        }),
        isNull,
      );
    });
  });
}
