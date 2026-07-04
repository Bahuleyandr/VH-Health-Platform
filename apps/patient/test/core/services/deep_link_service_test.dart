import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/deep_link_service.dart';
import 'package:vhhealth/core/services/push_notification_service.dart';

void main() {
  group('DeepLinkService notification routing', () {
    test('accepts every explicit allowlisted app route', () {
      expect(DeepLinkService.debugAllowedRoutes, isNotEmpty);

      for (final route in DeepLinkService.debugAllowedRoutes) {
        expect(
          DeepLinkService.parseNotificationRoute({'route': route}),
          route,
          reason: route,
        );
      }
    });

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

    test('allows numeric detail routes but rejects malformed IDs', () {
      expect(DeepLinkService.debugNumericIdPrefixes, isNotEmpty);

      for (final prefix in DeepLinkService.debugNumericIdPrefixes) {
        expect(
          DeepLinkService.parseNotificationRoute({'route': '${prefix}42'}),
          '${prefix}42',
          reason: prefix,
        );
        expect(
          DeepLinkService.parseNotificationRoute({'route': '${prefix}abc'}),
          isNull,
          reason: '$prefix rejects non-numeric IDs',
        );
        expect(
          DeepLinkService.parseNotificationRoute({'route': '$prefix-1'}),
          isNull,
          reason: '$prefix rejects negative IDs',
        );
        expect(
          DeepLinkService.parseNotificationRoute({'route': '${prefix}42/edit'}),
          isNull,
          reason: '$prefix rejects extra path segments',
        );
      }
    });

    test('maps FCM payload types to patient routes', () {
      final cases = <String, String>{
        'appointment_reminder': '/appointments',
        'appointment_confirmed': '/appointments',
        'pharmacy_order_update': '/pharmacy',
        'order_delivered': '/pharmacy',
        'investigation_result_ready': '/investigations',
        'collector_dispatched': '/investigations',
        'lab_result_ready': '/portal/lab-results',
        'results_ready': '/portal/lab-results',
        'prescription_ready': '/health',
        'document_uploaded': '/health',
        'bill_ready': '/portal/bills',
        'payment_link': '/portal/bills',
        'secure_message': '/portal/messages',
        'portal_message': '/portal/messages',
        'sos_alert': '/home',
        'feedback_reply': '/feedback-history',
        'step_reward': '/steps',
        'medication_reminder': '/home',
      };

      for (final entry in cases.entries) {
        expect(
          PushNotificationService.routeFromPayload({'type': entry.key}),
          entry.value,
          reason: entry.key,
        );
      }
    });

    test('rejects unsafe FCM payload routes', () {
      expect(
        PushNotificationService.routeFromPayload({'route': '/admin/users'}),
        isNull,
      );
      expect(
        PushNotificationService.routeFromPayload({
          'route': '/portal/messages/not-a-number',
        }),
        isNull,
      );
    });
  });
}
