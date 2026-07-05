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

  test('role navigation config stores keys instead of display copy', () {
    final hits = <String>[];
    final roleConfig = File('lib/core/config/role_config.dart');
    for (final entry in _literalHits(roleConfig, [
      _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
    ])) {
      hits.add(entry);
    }

    final staffScaffold = File('lib/core/widgets/staff_scaffold.dart');
    for (final entry in _literalHits(staffScaffold, [
      _Pattern('_NavItem', RegExp(r'''_NavItem\(\s*(?:r)?(['"])(.*?)\1''')),
    ], allowedPrefix: 'role.nav.')) {
      hits.add(entry);
    }

    expect(
      hits,
      isEmpty,
      reason:
          'Role/dashboard navigation labels should be AppStrings keys, not '
          'raw display copy.',
    );
  });

  test('role display metadata stores keys with required locale entries', () {
    final roleConfig = File('lib/core/config/role_config.dart');
    final roleConfigSource = roleConfig.readAsStringSync();
    expect(
      RegExp(r'''String\s+get\s+displayName\s*=>''').hasMatch(roleConfigSource),
      isFalse,
      reason: 'StaffRole display names should resolve through AppStrings keys.',
    );
    expect(
      RegExp(
        r'''String\s+get\s+rosterDepartmentLabel\s*=>''',
      ).hasMatch(roleConfigSource),
      isFalse,
      reason:
          'Roster department display names should resolve through AppStrings '
          'keys.',
    );

    final staffRosterHub = File(
      'lib/features/hr/screens/staff_roster_hub_screen.dart',
    );
    final hits = <String>[];
    for (final entry in _literalHits(staffRosterHub, [
      _Pattern(
        'roster title',
        RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern(
        'roster subtitle',
        RegExp(r'''\bsubtitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
    ])) {
      hits.add(entry);
    }

    final keys = <String>{};
    final enumSource = roleConfigSource.substring(
      roleConfigSource.indexOf('enum StaffRole'),
      roleConfigSource.indexOf('static StaffRole fromString'),
    );
    final roleValueRegex = RegExp(
      r'''^\s*\w+\('([A-Z_]+)'\),''',
      multiLine: true,
    );
    for (final match in roleValueRegex.allMatches(enumSource)) {
      keys.add('role.display.${match.group(1)!.toLowerCase()}');
    }
    keys.addAll(
      _appStringKeysFrom(roleConfigSource, ['role.roster_department.']),
    );

    for (final file in [
      staffRosterHub,
      File('lib/features/dashboard/screens/dashboard_screen.dart'),
      File('lib/features/schedule/screens/duty_preference_screen.dart'),
      File('lib/features/reception/screens/front_office_workbench_screen.dart'),
      File('lib/features/clinical_ai/screens/op_ai_assist_screen.dart'),
      File('lib/features/reports/screens/reports_admin_queue_screen.dart'),
    ]) {
      keys.addAll(
        _appStringKeysFrom(file.readAsStringSync(), [
          'role.display.',
          'role.roster_department.',
          's4.lib.staff_roster_hub.',
          's4.lib.dashboard.',
          's4.lib.duty_preference.any_shift',
          's4.lib.front_office_workbench.front_office_unavailable',
          's4.lib.front_office_workbench.workstation_mode_required',
          's4.lib.front_office_workbench.workstation_mode_required_message',
          's4.dynamic.duty_preference.',
          's4.dynamic.front_office.',
          's4.dynamic.op_ai_assist.',
          's4.dynamic.reports_admin_queue.',
        ]),
      );
    }

    expect(
      hits,
      isEmpty,
      reason: 'Roster hub display metadata should use AppStrings keys.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'Role display and roster metadata keys must have en/hi/ta/te.',
    );
  });

  test('calculator metadata stores keys with required locale entries', () {
    final calculatorFile = File(
      'lib/features/productivity/screens/calculators_screen.dart',
    );
    final hits = <String>[];
    for (final entry in _literalHits(calculatorFile, [
      _Pattern(
        'calculator title',
        RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern(
        'calculator subtitle',
        RegExp(r'''\bsubtitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern(
        'calculator label',
        RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern(
        'calculator hint',
        RegExp(r'''\bhint\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
    ])) {
      hits.add(entry);
    }

    final calculatorSource = calculatorFile.readAsStringSync();
    final keyRegex = RegExp(
      r'''['"]((?:s4\.calculators|s4\.lib\.calculators)\.[^'"]+)['"]''',
    );
    final keys = <String>{};
    for (final match in keyRegex.allMatches(calculatorSource)) {
      final key = match.group(1)!;
      if (key.contains(r'$')) continue;
      keys.add(key);
    }

    expect(
      hits,
      isEmpty,
      reason: 'Calculator metadata display copy should use AppStrings keys.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'Calculator keys must have en/hi/ta/te entries.',
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

Iterable<String> _literalHits(
  File file,
  List<_Pattern> patterns, {
  String? allowedPrefix,
}) sync* {
  final path = file.path.replaceAll('\\', '/');
  final lines = file.readAsLinesSync();
  for (var index = 0; index < lines.length; index += 1) {
    final line = lines[index];
    final trimmed = line.trimLeft();
    if (trimmed.startsWith('//') || trimmed.startsWith('///')) continue;
    for (final pattern in patterns) {
      for (final match in pattern.regex.allMatches(line)) {
        final value = match.group(2) ?? '';
        if (allowedPrefix != null && value.startsWith(allowedPrefix)) continue;
        if (!_isVisibleStaticCopy(value)) continue;
        yield '$path:${index + 1}: ${pattern.name}: "$value"';
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

Set<String> _appStringKeysFrom(String source, List<String> prefixes) {
  final keys = <String>{};
  final regex = RegExp(r'''['"]([^'"]+)['"]''');
  for (final match in regex.allMatches(source)) {
    final key = match.group(1)!;
    if (key.contains(r'$')) continue;
    if (prefixes.any(key.startsWith)) {
      keys.add(key);
    }
  }
  return keys;
}

List<String> _missingLocaleEntries(Set<String> keys) {
  final appStringsSource = File('lib/l10n/app_strings.dart').readAsStringSync();
  final missingKeys = <String>[];
  for (final key in keys) {
    final occurrences = RegExp(
      "'${RegExp.escape(key)}'",
    ).allMatches(appStringsSource);
    if (occurrences.length < 4) {
      missingKeys.add('$key (${occurrences.length}/4 locales)');
    }
  }
  missingKeys.sort();
  return missingKeys;
}

bool _setEquals(Set<String> a, Set<String> b) {
  return a.length == b.length && a.containsAll(b);
}
