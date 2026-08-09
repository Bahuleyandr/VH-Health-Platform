import 'package:flutter_test/flutter_test.dart';

import 'package:vhhealth/core/services/abdm_api_service.dart';
import 'package:vhhealth/core/services/api_client.dart';

/// Audit follow-up P13. Every ABHA link failure the patient can actually cause
/// must arrive as something they can act on. The mapping is keyed off the
/// backend error CODE, not its prose, so server copy changes cannot silently
/// turn a specific message back into a generic one.
void main() {
  ApiResponse failure(String? code, {int status = 400, String? message}) =>
      ApiResponse(
        statusCode: status,
        isSuccess: false,
        code: code,
        message: message,
        raw: {'code': code, 'message': message},
      );

  test('a bad ABHA number tells the patient what to fix', () {
    expect(
      AbdmApiService.linkFailureMessage(failure('INVALID_ABHA_FORMAT')),
      contains('14 digits'),
    );
  });

  test('a bad ABHA address shows the expected shape', () {
    expect(
      AbdmApiService.linkFailureMessage(failure('INVALID_ABHA_ADDRESS')),
      contains('name@abdm'),
    );
  });

  test('an ABHA held by someone else points at the front desk', () {
    expect(
      AbdmApiService.linkFailureMessage(
        failure('ABHA_ALREADY_LINKED', status: 409),
      ),
      contains('front desk'),
    );
  });

  test('a gateway verification failure says nothing was linked', () {
    final message = AbdmApiService.linkFailureMessage(
      failure('ABHA_VERIFICATION_FAILED', status: 503),
    );
    expect(message, contains('has not been linked'));
    expect(message, contains('try again'));
  });

  test('a missing patient record does not read as the patient\'s mistake', () {
    expect(
      AbdmApiService.linkFailureMessage(
        failure('PATIENT_NOT_FOUND', status: 404),
      ),
      contains('front desk'),
    );
  });

  test(
    'an uncoded failure falls back to the server message, not a bare code',
    () {
      expect(
        AbdmApiService.linkFailureMessage(
          failure(null, status: 500, message: 'Failed to register ABHA'),
        ),
        contains('Failed to register ABHA'),
      );
    },
  );

  test('a failure with neither code nor message still says what happened', () {
    expect(
      AbdmApiService.linkFailureMessage(failure(null, status: 502)),
      contains('Could not link your ABHA'),
    );
  });
}
