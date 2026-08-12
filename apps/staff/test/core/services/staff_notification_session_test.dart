import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/staff_notification_session.dart';

void main() {
  const audience = StaffNotificationAudience(
    version: 1,
    tenantId: '22222222-2222-4222-8222-222222222222',
    recipientUid: '33333333-3333-4333-8333-333333333333',
    deviceId: '11111111-1111-4111-8111-111111111111',
    registrationEpoch: '7',
    sessionEpoch: 'session-family-1',
    authorizationEpoch: '4',
  );

  RemoteMessage message({String reference = 'v1.iv.cipher.tag'}) =>
      RemoteMessage(
        data: {
          'type': 'code_blue',
          'code_blue_reference': reference,
          'notification_authority_version': '${audience.version}',
          'notification_tenant_id': audience.tenantId,
          'notification_recipient_uid': audience.recipientUid,
          'notification_device_id': audience.deviceId,
          'notification_registration_epoch': audience.registrationEpoch,
          'notification_session_epoch': audience.sessionEpoch,
          'notification_authorization_epoch': audience.authorizationEpoch,
          'notification_expires_at': '1924992000',
        },
      );

  test(
    'Code Blue detail is fetched by opaque event reference and audience',
    () async {
      StaffNotificationAudience? receivedAudience;
      String? receivedReference;

      final content = await codeBlueContentForMessage(
        message: message(),
        contentFetcher: (candidate, reference) async {
          receivedAudience = candidate;
          receivedReference = reference;
          return {
            'eventId': '42',
            'patientId': 'patient-42',
            'ward': 'ICU',
            'bedNumber': '4A',
            'reason': 'Cardiac arrest',
          };
        },
      );

      expect(receivedAudience?.matches(audience), isTrue);
      expect(receivedReference, 'v1.iv.cipher.tag');
      expect(content, containsPair('patientId', 'patient-42'));
    },
  );

  test(
    'missing or malformed event references never reach the PHI fetcher',
    () async {
      var fetches = 0;
      for (final reference in [
        '',
        'spaces are not opaque',
        List<String>.filled(2049, 'x').join(),
      ]) {
        expect(
          await codeBlueContentForMessage(
            message: message(reference: reference),
            contentFetcher: (_, _) async {
              fetches += 1;
              return {'ward': 'ICU'};
            },
          ),
          isNull,
        );
      }
      expect(fetches, 0);
    },
  );

  test(
    'denied current-audience fetch returns no detailed presentation data',
    () async {
      expect(
        await codeBlueContentForMessage(
          message: message(),
          contentFetcher: (_, _) async => null,
        ),
        isNull,
      );
    },
  );
}
