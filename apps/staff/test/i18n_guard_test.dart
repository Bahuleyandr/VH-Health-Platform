import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('staff feature UI copy uses AppStrings instead of raw literals', () {
    final hits = <String>[];
    for (final file in _guardedFiles()) {
      final path = file.path.replaceAll('\\', '/');
      final lines = file.readAsLinesSync();
      for (var index = 0; index < lines.length; index += 1) {
        final line = lines[index];
        final trimmed = line.trimLeft();
        if (trimmed.startsWith('//') || trimmed.startsWith('///')) continue;
        for (final pattern in _patterns) {
          for (final match in pattern.regex.allMatches(line)) {
            final value = match.group(2) ?? '';
            if (!_isVisibleStaticCopy(value)) continue;
            final allowKey = '$path|$value';
            if (_allowlist.contains(allowKey)) continue;
            hits.add('$path:${index + 1}: ${pattern.name}: "$value"');
          }
        }
      }
    }

    expect(
      hits,
      isEmpty,
      reason:
          'Move user-visible staff feature copy to AppStrings/AppText. '
          'If this is display data rather than copy, add a narrow allowlist entry.',
    );
  });

  test('S4 dynamic translations preserve interpolation placeholders', () {
    final source = File('lib/l10n/app_strings.dart').readAsStringSync();
    final entries = <String, List<Set<String>>>{};
    final entryRegex = RegExp(
      r'''('s4\.dynamic\.[^']+'\s*:\s*)(["'])([\s\S]*?)\2\s*,''',
      dotAll: true,
    );
    final keyRegex = RegExp(r'''s4\.dynamic\.[^']+''');
    final placeholderRegex = RegExp(r'\{[A-Za-z0-9_]+\}');

    for (final match in entryRegex.allMatches(source)) {
      final key = keyRegex.firstMatch(match.group(1)!)!.group(0)!;
      final value = match.group(3)!;
      entries
          .putIfAbsent(key, () => [])
          .add(
            placeholderRegex
                .allMatches(value)
                .map((placeholder) => placeholder.group(0)!)
                .toSet(),
          );
    }

    final mismatches = <String>[];
    for (final entry in entries.entries) {
      final values = entry.value;
      if (values.length < 4) {
        mismatches.add('${entry.key}: found ${values.length} translations');
        continue;
      }
      final expected = values.first;
      for (var index = 1; index < 4; index += 1) {
        if (!_setEquals(expected, values[index])) {
          mismatches.add(
            '${entry.key}: translation $index has ${values[index]}, '
            'expected $expected',
          );
        }
      }
    }

    expect(
      mismatches,
      isEmpty,
      reason:
          'Dynamic AppStrings values must keep the same {placeholders} across '
          'en/hi/ta/te so AppStrings.format can inject runtime values.',
    );
  });
}

class _Pattern {
  final String name;
  final RegExp regex;

  const _Pattern(this.name, this.regex);
}

final _patterns = <_Pattern>[
  _Pattern(
    'Text',
    RegExp(
      r'''(?:^|[^A-Za-z0-9_.])(?:const\s+)?Text\(\s*(?:r)?(['"])(.*?)\1''',
    ),
  ),
  _Pattern(
    'SelectableText',
    RegExp(
      r'''(?:^|[^A-Za-z0-9_.])(?:const\s+)?SelectableText\(\s*(?:r)?(['"])(.*?)\1''',
    ),
  ),
  _Pattern(
    'TextSpan.text',
    RegExp(r'''TextSpan\(\s*text\s*:\s*(?:r)?(['"])(.*?)\1'''),
  ),
  _Pattern(
    'Tab.text',
    RegExp(r'''Tab\([^\n]*\btext\s*:\s*(?:r)?(['"])(.*?)\1'''),
  ),
  _Pattern('tooltip', RegExp(r'''\btooltip\s*:\s*(?:r)?(['"])(.*?)\1''')),
  _Pattern(
    'Tooltip.message',
    RegExp(r'''Tooltip\([^\n]*\bmessage\s*:\s*(?:r)?(['"])(.*?)\1'''),
  ),
  _Pattern(
    'semanticLabel',
    RegExp(r'''\bsemanticLabel\s*:\s*(?:r)?(['"])(.*?)\1'''),
  ),
  _Pattern(
    'Semantics.label',
    RegExp(r'''Semantics\([^\n]*\blabel\s*:\s*(?:r)?(['"])(.*?)\1'''),
  ),
  _Pattern('labelText', RegExp(r'''\blabelText\s*:\s*(?:r)?(['"])(.*?)\1''')),
  _Pattern('hintText', RegExp(r'''\bhintText\s*:\s*(?:r)?(['"])(.*?)\1''')),
  _Pattern('helperText', RegExp(r'''\bhelperText\s*:\s*(?:r)?(['"])(.*?)\1''')),
  _Pattern('errorText', RegExp(r'''\berrorText\s*:\s*(?:r)?(['"])(.*?)\1''')),
];

final _allowlist = <String>{
  'lib/features/about/screens/about_screen.dart|support@vhhealth.in',
  'lib/features/doctor/screens/prescriptions_screen.dart|A',
  'lib/features/doctor/screens/prescriptions_screen.dart|N',
};

Iterable<File> _guardedFiles() sync* {
  final roots = [
    Directory('lib/core/navigation'),
    Directory('lib/core/widgets'),
    Directory('lib/features'),
  ];
  for (final root in roots) {
    expect(root.existsSync(), isTrue, reason: 'Missing ${root.path}');
    for (final entity in root.listSync(recursive: true)) {
      if (entity is File && entity.path.endsWith('.dart')) {
        yield entity;
      }
    }
  }
}

bool _isVisibleStaticCopy(String value) {
  final text = value.trim();
  if (text.isEmpty) return false;
  if (text.contains(r'$')) return false;
  if (!RegExp(r'[A-Za-z0-9]').hasMatch(text)) return false;
  if (RegExp(r'^[dMyHhmsaE:/.,\-_ ]+$').hasMatch(text)) return false;
  if (RegExp(r'^[a-z0-9_.]+$').hasMatch(text) && !text.contains(' ')) {
    return false;
  }
  return true;
}

bool _setEquals(Set<String> a, Set<String> b) {
  return a.length == b.length && a.containsAll(b);
}
