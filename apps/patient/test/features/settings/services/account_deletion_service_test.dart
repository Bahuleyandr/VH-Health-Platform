import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/settings/services/account_deletion_service.dart';

void main() {
  test('extracts account deletion error code from backend envelope', () {
    const response = ApiResponse(
      statusCode: 409,
      isSuccess: false,
      raw: {
        'success': false,
        'message': 'Cannot delete account while an active admission is open',
        'details': {
          'code': 'ACTIVE_ADMISSION_BLOCKS_ACCOUNT_DELETION',
          'admissionId': 42,
        },
      },
      message: 'Cannot delete account while an active admission is open',
    );

    final error = AccountDeletionService.exceptionFromResponse(response);

    expect(error.statusCode, 409);
    expect(error.code, 'ACTIVE_ADMISSION_BLOCKS_ACCOUNT_DELETION');
    expect(
      error.message,
      contains('Cannot delete account while an active admission is open'),
    );
  });
}
