import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/abdm_api_service.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/abdm/abdm_error_message.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  test('a failed response retains machine evidence, not server prose', () {
    final failure = AbdmException.fromResponse(
      const ApiResponse(
        statusCode: 409,
        isSuccess: false,
        code: 'ABHA_ALREADY_LINKED',
        requestId: 'synthetic-request-ref',
        message: 'Server detail must not become patient copy',
      ),
    );
    expect(failure.code, 'ABHA_ALREADY_LINKED');
    expect(failure.statusCode, 409);
    expect(failure.requestId, 'synthetic-request-ref');
    expect(failure.toString(), isNot(contains('Server detail')));
  });

  for (final locale in ['en', 'hi', 'ta', 'te', 'ml']) {
    test('known link errors preserve actionable meanings in $locale', () async {
      final l = await AppLocalizations.delegate.load(Locale(locale));
      final expected = {
        'INVALID_ABHA_FORMAT': l.abdmNumberLengthError,
        'INVALID_ABHA_ADDRESS': l.abdmAddressInvalidError,
        'ABHA_ALREADY_LINKED': l.abdmAlreadyLinkedError,
        'ABHA_VERIFICATION_FAILED': l.abdmVerificationFailedError,
        'PATIENT_NOT_FOUND': l.abdmPatientNotFoundError,
      };
      expect(expected, hasLength(5));
      for (final error in expected.entries) {
        expect(abdmLinkFailureMessage(l, error.key), error.value);
        expect(error.value, isNotEmpty);
      }
      expect(abdmLinkFailureMessage(l, 'UNRECOGNIZED'), l.abdmLinkFailed);
      expect(abdmLinkFailureMessage(l, null), l.abdmLinkFailed);
    });

    test('recognized enrolment errors are localized in $locale', () async {
      final l = await AppLocalizations.delegate.load(Locale(locale));
      expect(
        abhaEnrolmentFailureMessage(
          l,
          'INVALID_AADHAAR',
          l.abhaEnrolStartFailed,
        ),
        l.abhaEnrolStartFailed,
      );
      expect(
        abhaEnrolmentFailureMessage(l, 'INVALID_OTP', l.abhaEnrolOtpFailed),
        l.abhaEnrolOtpLengthError,
      );
      expect(
        abhaEnrolmentFailureMessage(
          l,
          'ABHA_ENROLMENT_VERIFY_IN_PROGRESS',
          l.abhaEnrolOtpFailed,
        ),
        l.abhaEnrolVerifyInProgress,
      );
      expect(
        abhaEnrolmentFailureMessage(l, 'UNRECOGNIZED', l.abhaEnrolOtpFailed),
        l.abhaEnrolOtpFailed,
      );
    });
  }

  test(
    'English actionable link distinctions retain their original meaning',
    () async {
      final l = await AppLocalizations.delegate.load(const Locale('en'));
      expect(l.abdmNumberLengthError, contains('14 digits'));
      expect(l.abdmAddressInvalidError, contains('name@abdm'));
      expect(l.abdmAlreadyLinkedError, contains('front desk'));
      expect(l.abdmVerificationFailedError, contains('has not been linked'));
      expect(l.abdmVerificationFailedError, contains('try again'));
      expect(l.abdmPatientNotFoundError, contains('front desk'));
    },
  );
}
