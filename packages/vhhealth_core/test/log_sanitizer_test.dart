import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/utils/log_sanitizer.dart';

void main() {
  group('logSafePath', () {
    test('keeps only the path for full URLs', () {
      expect(
        logSafePath(
          'https://api.vhhealth.app/portal/lab-results?code=GLU&phone=9876543210',
        ),
        '/portal/lab-results',
      );
    });

    test('strips cachedGet query suffixes from cache keys', () {
      expect(
        logSafePath('/portal/lab-results_code=GLU_phone=9876543210'),
        '/portal/lab-results',
      );
    });

    test('redacts phone-shaped values in non-URL cache keys', () {
      expect(
        logSafePath('records_manifest_9876543210'),
        'records_manifest_<redacted-number>',
      );
    });

    test('drops acting-as cache namespace prefixes', () {
      expect(
        logSafePath('as_dependent-uid-123__/portal/bills'),
        '/portal/bills',
      );
    });
  });

  group('redactLogText', () {
    test(
      'redacts query values, bearer tokens, JWTs, email, and phone numbers',
      () {
        final redacted = redactLogText(
          'ClientException https://api.test/v1?token=secret&foo=bar '
          'Bearer abc.def.ghi user@example.com phone=9876543210',
        );

        expect(redacted, isNot(contains('secret')));
        expect(redacted, isNot(contains('bar')));
        expect(redacted, isNot(contains('abc.def.ghi')));
        expect(redacted, isNot(contains('user@example.com')));
        expect(redacted, isNot(contains('9876543210')));
        expect(redacted, contains('token=<redacted>'));
        expect(redacted, contains('foo=<redacted>'));
        expect(redacted, contains('Bearer <redacted>'));
        expect(redacted, contains('<redacted-email>'));
        expect(redacted, contains('phone=<redacted>'));
      },
    );
  });
}
