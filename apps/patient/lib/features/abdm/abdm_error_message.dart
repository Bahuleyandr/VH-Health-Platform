import 'package:vhhealth/generated/app_localizations.dart';

String abdmLinkFailureMessage(AppLocalizations l, String? code) =>
    switch (code) {
      'INVALID_ABHA_FORMAT' => l.abdmNumberLengthError,
      'INVALID_ABHA_ADDRESS' => l.abdmAddressInvalidError,
      'ABHA_ALREADY_LINKED' => l.abdmAlreadyLinkedError,
      'ABHA_VERIFICATION_FAILED' => l.abdmVerificationFailedError,
      'PATIENT_NOT_FOUND' => l.abdmPatientNotFoundError,
      _ => l.abdmLinkFailed,
    };

String abhaEnrolmentFailureMessage(
  AppLocalizations l,
  String? code,
  String fallback,
) => switch (code) {
  'INVALID_OTP' => l.abhaEnrolOtpLengthError,
  'ABHA_ENROLMENT_VERIFY_IN_PROGRESS' => l.abhaEnrolVerifyInProgress,
  _ => fallback,
};
