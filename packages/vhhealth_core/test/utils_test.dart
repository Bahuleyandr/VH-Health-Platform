import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/utils/input_sanitizer.dart';

void main() {
  group('InputSanitizer', () {
    test('stripHtml removes tags', () {
      expect(InputSanitizer.stripHtml('<b>bold</b>'), 'bold');
      // Script content is stripped entirely (not just the tags) to prevent XSS
      expect(InputSanitizer.stripHtml('<script>alert("xss")</script>'), '');
      expect(InputSanitizer.stripHtml('no tags'), 'no tags');
    });

    test('sanitize removes null bytes and trims', () {
      expect(InputSanitizer.sanitize('  hello\x00  '), 'hello');
      expect(InputSanitizer.sanitize('<img src=x>test'), 'test');
    });

    test('sanitizePhone keeps only valid chars', () {
      expect(
        InputSanitizer.sanitizePhone('+91 9876-543210'),
        '+91 9876-543210',
      );
      expect(InputSanitizer.sanitizePhone('abc123'), '123');
    });

    test('sanitizeName strips html and null bytes', () {
      expect(InputSanitizer.sanitizeName('<b>John</b>'), 'John');
      expect(InputSanitizer.sanitizeName('John\x00Doe'), 'JohnDoe');
    });
  });
}
