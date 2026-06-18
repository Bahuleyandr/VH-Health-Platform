import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/utils/safe_filename.dart';

void main() {
  // Build control/space chars from code points so the source stays pure ASCII
  // (no invisible bytes that obscure what each case actually exercises).
  final nul = String.fromCharCode(0); // NUL — removed
  final tab = String.fromCharCode(9); // TAB (control) — removed
  final space = String.fromCharCode(32); // space — replaced with '_'

  group('safeFileName — path-traversal containment (audit #6)', () {
    test('strips POSIX traversal so the result has no separators', () {
      final out = safeFileName('../../etc/passwd');
      expect(out.contains('/'), isFalse);
      expect(out.contains('\\'), isFalse);
      expect(out, isNot(startsWith('.')));
    });

    test('strips Windows-style separators and traversal', () {
      final out = safeFileName(r'..\..\Windows\System32\x');
      expect(out.contains('/'), isFalse);
      expect(out.contains('\\'), isFalse);
    });

    test('neutralises an absolute path to a child segment', () {
      final out = safeFileName('/etc/shadow');
      expect(out.contains('/'), isFalse);
      expect(out, isNotEmpty);
    });

    test('bare ".." collapses to the fallback (never names the parent dir)', () {
      expect(safeFileName('..'), 'file');
      expect(safeFileName('.'), 'file');
      expect(safeFileName('...'), 'file');
    });

    test('drops null bytes and control characters', () {
      expect(safeFileName('report$nul.pdf'), 'report.pdf');
      expect(safeFileName('a${tab}bc.pdf'), 'abc.pdf');
    });

    test('replaces spaces and other unsafe characters with underscore', () {
      expect(safeFileName('my${space}report.pdf'), 'my_report.pdf');
      final out = safeFileName('report$space(final).pdf');
      expect(out.contains(' '), isFalse);
      expect(out.contains('('), isFalse);
      expect(out.endsWith('.pdf'), isTrue);
    });

    test('empty / whitespace / null fall back', () {
      expect(safeFileName(''), 'file');
      expect(safeFileName('   '), 'file');
      expect(safeFileName(null), 'file');
      expect(safeFileName(null, fallback: 'document'), 'document');
    });

    test('the output is ALWAYS a single safe segment for hostile inputs', () {
      final hostile = [
        '../../../../data/data/com.vhhealth/secret',
        r'a\..\..\b',
        '....//....//file.pdf',
        '/absolute/phi.pdf',
        'nested/dir/report.pdf',
        '..',
        space,
      ];
      for (final input in hostile) {
        final out = safeFileName(input);
        expect(out.contains('/'), isFalse, reason: 'separator leaked from "$input"');
        expect(out.contains('\\'), isFalse, reason: 'backslash leaked from "$input"');
        expect(out == '.' || out == '..' || out.isEmpty, isFalse,
            reason: 'dot/empty segment from "$input"');
      }
    });
  });

  group('safeFileName — legitimate names are preserved', () {
    test('a plain server filename is unchanged', () {
      expect(safeFileName('report.pdf'), 'report.pdf');
    });

    test('an app-built lab report name is unchanged', () {
      expect(safeFileName('LabReport_4821_2026-06-18.pdf'), 'LabReport_4821_2026-06-18.pdf');
    });

    test('distinct keys sharing a basename stay distinct (no cache collision)', () {
      final a = safeFileName('2026/06/report.pdf');
      final b = safeFileName('2026/05/report.pdf');
      expect(a, isNot(equals(b)));
      expect(a.endsWith('report.pdf'), isTrue);
    });

    test('a long name is bounded but keeps its extension', () {
      final out = safeFileName('${'x' * 400}.pdf');
      expect(out.length, lessThanOrEqualTo(150));
      expect(out.endsWith('.pdf'), isTrue);
    });
  });
}
