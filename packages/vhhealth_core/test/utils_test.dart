import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/utils/validators.dart';
import 'package:vhhealth_core/utils/input_sanitizer.dart';
import 'package:vhhealth_core/utils/date_formatter.dart';

void main() {
  group('Validators', () {
    test('isValidPhone accepts valid numbers', () {
      expect(Validators.isValidPhone('+919876543210'), true);
      expect(Validators.isValidPhone('9876543210'), true);
      expect(Validators.isValidPhone('+14155551234'), true);
    });

    test('isValidPhone rejects invalid numbers', () {
      expect(Validators.isValidPhone('123'), false);
      expect(Validators.isValidPhone('abc'), false);
      expect(Validators.isValidPhone(''), false);
    });

    test('isNotBlank checks correctly', () {
      expect(Validators.isNotBlank('hello'), true);
      expect(Validators.isNotBlank('  '), false);
      expect(Validators.isNotBlank(null), false);
      expect(Validators.isNotBlank(''), false);
    });
  });

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

  group('DateFormatter', () {
    test('yyyyMmDd formats correctly', () {
      final date = DateTime(2026, 4, 2);
      expect(DateFormatter.yyyyMmDd(date), '2026-04-02');
    });

    test('hhMm formats correctly', () {
      final date = DateTime(2026, 4, 2, 14, 30);
      expect(DateFormatter.hhMm(date), '14:30');
    });
  });
}
