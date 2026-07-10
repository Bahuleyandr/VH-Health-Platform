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

  test('S4 HR display copy stores keys with required locale entries', () {
    final files = [
      File('lib/features/hr/screens/organization_hierarchy_screen.dart'),
      File('lib/features/hr/screens/hr_dashboard_screen.dart'),
      File('lib/features/hr/screens/staff_management_screen.dart'),
      File('lib/features/hr/screens/leave_approvals_screen.dart'),
      File('lib/features/hr/screens/performance_screen.dart'),
    ];
    final hits = <String>[];
    for (final file in files) {
      for (final entry in _literalHits(file, [
        _Pattern(
          'StaffScaffold title',
          RegExp(r'''StaffScaffold\(\s*\btitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
        ),
        _Pattern(
          'section title',
          RegExp(r'''_SectionTitle\(\s*(?:r)?(['"])(.*?)\1'''),
        ),
        _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
        _Pattern(
          'subtitle',
          RegExp(r'''\bsubtitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
        ),
        _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
      ])) {
        hits.add(entry);
      }
    }

    final keys = <String>{};
    for (final file in files) {
      keys.addAll(
        _appStringKeysFrom(file.readAsStringSync(), [
          'hr.action.',
          'role.display.',
          'staff_mgmt.',
          'performance.no_review_yet',
          's4.lib.hr_dashboard.',
          's4.lib.organization_hierarchy.',
          's4.lib.leave_approvals.',
          's4.lib.staff_management.',
          's4.dynamic.hr_dashboard.',
          's4.dynamic.organization_hierarchy.',
          's4.dynamic.leave_approvals.',
          's4.dynamic.staff_management.',
        ]),
      );
    }

    expect(
      hits,
      isEmpty,
      reason:
          'S4 HR slice metadata and small display labels should use AppStrings.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 HR slice keys must have en/hi/ta/te entries.',
    );
  });

  test(
    'S4 EMR patient-context copy stores keys with required locale entries',
    () {
      final files = [
        File('lib/features/emr/screens/patient_command_board_screen.dart'),
        File('lib/features/emr/widgets/patient_health_journey_panel.dart'),
        File('lib/features/emr/screens/patient_timeline_screen.dart'),
        File('lib/features/emr/screens/admission_case_sheet_screen.dart'),
        File('lib/features/emr/widgets/note_draft_status_indicator.dart'),
      ];
      final hits = <String>[];
      for (final file in files) {
        for (final entry in _literalHits(file, [
          _Pattern(
            'case sheet field label',
            RegExp(
              r'''_(?:sectionTitle|field|smallField)\(\s*(?:r)?(['"])(.*?)\1''',
            ),
          ),
          _Pattern(
            'section title',
            RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
          ),
          _Pattern(
            'section subtitle',
            RegExp(r'''\bsubtitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
          ),
          _Pattern(
            'button label',
            RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1'''),
          ),
        ])) {
          hits.add(entry);
        }
      }

      final keys = <String>{};
      for (final file in files) {
        keys.addAll(
          _appStringKeysFrom(file.readAsStringSync(), [
            's4.lib.admission_case_sheet.',
            's4.dynamic.admission_case_sheet.',
            's4.lib.patient_command_board.',
            's4.dynamic.patient_command_board.',
            's4.lib.patient_health_journey_panel.',
            's4.dynamic.patient_health_journey_panel.',
            's4.lib.patient_timeline.',
            's4.dynamic.patient_timeline.',
            's4.lib.note_draft_status.',
            's4.dynamic.note_draft_status.',
          ]),
        );
      }

      expect(
        hits,
        isEmpty,
        reason:
            'S4 EMR patient-context labels should use AppStrings/AppText keys.',
      );
      expect(
        _missingLocaleEntries(keys),
        isEmpty,
        reason: 'S4 EMR patient-context keys must have en/hi/ta/te entries.',
      );
    },
  );

  test('S4 scan screen copy stores keys with required locale entries', () {
    final files = [
      File('lib/features/bloodbank/screens/transfusion_scan_screen.dart'),
      File('lib/features/investigations/screens/specimen_scan_screen.dart'),
    ];
    final hits = <String>[];
    for (final file in files) {
      for (final entry in _literalHits(file, [
        _Pattern(
          'StaffScaffold title',
          RegExp(r'''StaffScaffold\(\s*\btitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
        ),
        _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
        _Pattern(
          'subtitle',
          RegExp(r'''\bsubtitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
        ),
        _Pattern('message', RegExp(r'''\bmessage\s*:\s*(?:r)?(['"])(.*?)\1''')),
        _Pattern(
          'action label',
          RegExp(r'''\bactionLabel\s*:\s*(?:r)?(['"])(.*?)\1'''),
        ),
        _Pattern(
          'failure fallback',
          RegExp(r'''failureMessage\(\s*(?:r)?(['"])(.*?)\1'''),
        ),
        _Pattern(
          'offline queue context',
          RegExp(r'''\bcontextLabel\s*:\s*(?:r)?(['"])(.*?)\1'''),
        ),
      ])) {
        hits.add(entry);
      }
    }

    final keys = <String>{};
    for (final file in files) {
      keys.addAll(
        _appStringKeysFrom(file.readAsStringSync(), [
          's4.lib.scan_common.',
          's4.lib.specimen_scan.',
          's4.dynamic.specimen_scan.',
          's4.lib.transfusion_scan.',
          's4.dynamic.transfusion_scan.',
        ]),
      );
    }

    expect(
      hits,
      isEmpty,
      reason:
          'S4 scan screen titles, status panels, and fallback copy should use '
          'AppStrings/AppText keys.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 scan screen keys must have en/hi/ta/te entries.',
    );
  });

  test('S4 Drug Chart state copy stores keys with required locale entries', () {
    final file = File('lib/features/ipd/screens/drug_chart_screen.dart');
    final source = file.readAsStringSync();
    final keys = <String>{
      ..._appStringKeysFrom(source, [
        'drug_chart.',
        's4.dynamic.drug_chart.',
        's4.lib.drug_chart.',
      ]),
      ..._appStringCallKeysFrom(source, [
        'drug_chart.',
        's4.dynamic.drug_chart.',
        's4.lib.drug_chart.',
      ]),
    };

    expect(
      source,
      contains('EmptyState('),
      reason: 'Drug Chart empty copy should use the shared EmptyState widget.',
    );
    for (final rawCopy in [
      "'Drug is required'",
      "'Dose is required; select a drug with strength or enter dose'",
      "'Select at least one administration time'",
      "'Medication order queued",
      "'Rules clear'",
      "'Safety review needed'",
      "'Doctor edit",
      "'Bed \$bed'",
      "'Admission #",
      "'\$sourceCount sources'",
    ]) {
      expect(
        source,
        isNot(contains(rawCopy)),
        reason:
            'Drug Chart validation, header, and status copy should use '
            'AppStrings keys: $rawCopy',
      );
    }
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 Drug Chart keys must have en/hi/ta/te entries.',
    );
  });

  test('S4 housekeeping copy stores keys with required locale entries', () {
    final files = [
      File(
        'lib/features/housekeeping/screens/housekeeping_command_screen.dart',
      ),
      File(
        'lib/features/housekeeping/screens/housekeeping_roster_board_screen.dart',
      ),
      File('lib/features/housekeeping/screens/log_cleaning_screen.dart'),
      File('lib/features/housekeeping/screens/my_housekeeping_screen.dart'),
      File('lib/features/housekeeping/screens/raise_request_screen.dart'),
      File('lib/features/housekeeping/screens/tasks_screen.dart'),
    ];
    final hits = <String>[];
    final patterns = [
      _Pattern(
        'AppText display copy',
        RegExp(
          r'''(?:^|[^A-Za-z0-9_.])(?:const\s+)?AppText\(\s*(?:r)?(['"])(.*?)\1''',
        ),
      ),
      _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('subtitle', RegExp(r'''\bsubtitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('message', RegExp(r'''\bmessage\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('text', RegExp(r'''\btext\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('fallback', RegExp(r'''\bfallback\s*:\s*(?:r)?(['"])(.*?)\1''')),
    ];
    final allowedPrefixes = [
      'action.',
      'bed_board.',
      'bed_sheet.',
      'clinical_ai.',
      'drug_chart.',
      'housekeeping.',
      'investigations.',
      'prescriptions.',
      'priority.',
      'profile.',
      'role.',
      's4.dynamic.housekeeping.',
      's4.dynamic.housekeeping_command.',
      's4.dynamic.housekeeping_roster_board.',
      's4.dynamic.housekeeping_task.',
      's4.lib.housekeeping_command.',
      's4.lib.housekeeping_roster_board.',
      's4.lib.housekeeping_task.',
      's4.lib.leave_approvals.',
      's4.lib.staff_roster_hub.',
      'urgency.',
    ];

    for (final file in files) {
      for (final entry in _literalHits(file, patterns)) {
        if (_housekeepingGuardAllowlist.any(entry.contains)) continue;
        hits.add(entry);
      }
      for (final entry in _interpolatedLiteralHits(file, patterns)) {
        if (_housekeepingGuardAllowlist.any(entry.contains)) continue;
        hits.add(entry);
      }
    }

    final keys = <String>{};
    for (final file in files) {
      keys.addAll(_appStringKeysFrom(file.readAsStringSync(), allowedPrefixes));
    }
    keys.addAll(
      _appStringKeysFrom(
        File('lib/core/navigation/app_router.dart').readAsStringSync(),
        allowedPrefixes,
      ),
    );

    expect(
      hits,
      isEmpty,
      reason:
          'S4 housekeeping labels, messages, and interpolated UI copy should '
          'use AppStrings/AppText keys.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 housekeeping keys must have en/hi/ta/te entries.',
    );
  });

  test('S4 operational static copy stores keys with required locale entries', () {
    final files = [
      File('lib/features/phone/screens/staff_phone_more_screen.dart'),
      File('lib/features/ward/screens/ward_mode_screen.dart'),
      File('lib/features/cath_lab/screens/cath_lab_screen.dart'),
      File(
        'lib/features/radiation_oncology/screens/radiation_oncology_screen.dart',
      ),
      File('lib/features/audit/screens/audit_logs_screen.dart'),
      File('lib/features/diagnostics/screens/staff_diagnostics_screen.dart'),
      File('lib/features/appointments/screens/appointment_queue_screen.dart'),
      File('lib/features/reception/screens/billing_desk_screen.dart'),
    ];
    final patterns = [
      _Pattern(
        'AppText display copy',
        RegExp(
          r'''(?:^|[^A-Za-z0-9_.])(?:const\s+)?AppText\(\s*(?:r)?(['"])(.*?)\1''',
        ),
      ),
      _Pattern(
        'StaffScaffold title',
        RegExp(r'''StaffScaffold\(\s*\btitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern(
        'title key',
        RegExp(r'''\btitleKey\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern(
        'subtitle key',
        RegExp(r'''\bsubtitleKey\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('subtitle', RegExp(r'''\bsubtitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('text', RegExp(r'''\btext\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('body', RegExp(r'''\bbody\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('tooltip', RegExp(r'''\btooltip\s*:\s*(?:r)?(['"])(.*?)\1''')),
    ];
    final allowedPrefixes = [
      'action.',
      'leave.',
      'profile.',
      'role.feature.',
      's4.dynamic.audit_logs.',
      's4.lib.appointment_queue.',
      's4.lib.audit_logs.',
      's4.lib.billing_desk.',
      's4.lib.cath_lab.',
      's4.lib.radiation_oncology.',
      's4.lib.staff_diagnostics.',
      's4.lib.staff_phone_more.',
      's4.lib.staff_query.',
      's4.lib.ward_mode.',
      'settings.',
    ];

    final hits = <String>[];
    for (final file in files) {
      hits.addAll(_literalHits(file, patterns));
      hits.addAll(_interpolatedLiteralHits(file, patterns));
    }

    final keys = <String>{};
    for (final file in files) {
      keys.addAll(_appStringKeysFrom(file.readAsStringSync(), allowedPrefixes));
    }

    expect(
      hits,
      isEmpty,
      reason:
          'S4 operational labels, menu metadata, empty states, and pagination '
          'copy should use AppStrings/AppText keys.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 operational copy keys must have en/hi/ta/te entries.',
    );
  });

  test('S4 OP AI Assist copy stores keys with required locale entries', () {
    final file = File(
      'lib/features/clinical_ai/screens/op_ai_assist_screen.dart',
    );
    final patterns = [
      _Pattern(
        'AppText display copy',
        RegExp(
          r'''(?:^|[^A-Za-z0-9_.])(?:const\s+)?AppText\(\s*(?:r)?(['"])(.*?)\1''',
        ),
      ),
      _Pattern(
        'StaffScaffold title',
        RegExp(r'''StaffScaffold\(\s*\btitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('hint', RegExp(r'''\bhint\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern(
        'submitLabel',
        RegExp(r'''\bsubmitLabel\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern(
        'fallbackLabel',
        RegExp(r'''\bfallbackLabel\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern(
        'fallbackPurpose',
        RegExp(r'''\bfallbackPurpose\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
    ];
    final allowedPrefixes = [
      'action.',
      'role.feature.',
      's4.dynamic.op_ai_assist.',
      's4.lib.op_ai_assist.',
    ];

    final hits = <String>[
      ..._literalHits(file, patterns),
      ..._interpolatedLiteralHits(file, patterns),
    ];
    final keys = _appStringKeysFrom(file.readAsStringSync(), allowedPrefixes);

    expect(
      hits,
      isEmpty,
      reason:
          'S4 OP AI Assist module labels, field labels, hints, and status copy '
          'should use AppStrings keys.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 OP AI Assist keys must have en/hi/ta/te entries.',
    );
  });

  test(
    'S4 OP Doctor Workspace copy stores keys with required locale entries',
    () {
      final file = File(
        'lib/features/opd/screens/op_doctor_workspace_screen.dart',
      );
      final patterns = [
        _Pattern(
          'AppText display copy',
          RegExp(
            r'''(?:^|[^A-Za-z0-9_.])(?:const\s+)?AppText\(\s*(?:r)?(['"])(.*?)\1''',
          ),
        ),
        _Pattern(
          'StaffScaffold title',
          RegExp(r'''StaffScaffold\(\s*\btitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
        ),
        _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
        _Pattern(
          'subtitle',
          RegExp(r'''\bsubtitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
        ),
        _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
        _Pattern('hint', RegExp(r'''\bhint\s*:\s*(?:r)?(['"])(.*?)\1''')),
      ];
      final allowedPrefixes = [
        's4.dynamic.op_doctor_workspace.',
        's4.lib.op_doctor_workspace.',
      ];

      final hits = <String>[
        ..._literalHits(file, patterns),
        ..._interpolatedLiteralHits(file, patterns),
      ];
      final keys = _appStringKeysFrom(file.readAsStringSync(), allowedPrefixes);

      expect(
        hits,
        isEmpty,
        reason:
            'S4 OP Doctor Workspace panel labels, field labels, hints, and '
            'timeline copy should use AppStrings keys.',
      );
      expect(
        _missingLocaleEntries(keys),
        isEmpty,
        reason: 'S4 OP Doctor Workspace keys must have en/hi/ta/te entries.',
      );
    },
  );

  test('S4 Patient Records copy stores keys with required locale entries', () {
    final file = File(
      'lib/features/doctor/screens/patient_records_screen.dart',
    );
    final patterns = [
      _Pattern(
        'AppText display copy',
        RegExp(
          r'''(?:^|[^A-Za-z0-9_.])(?:const\s+)?AppText\(\s*(?:r)?(['"])(.*?)\1''',
        ),
      ),
      _Pattern(
        'StaffScaffold title',
        RegExp(r'''StaffScaffold\(\s*\btitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('titleKey', RegExp(r'''\btitleKey\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('body', RegExp(r'''\bbody\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('bodyKey', RegExp(r'''\bbodyKey\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('subtitle', RegExp(r'''\bsubtitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern(
        'subtitleKey',
        RegExp(r'''\bsubtitleKey\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('helper', RegExp(r'''\bhelperText\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('hint', RegExp(r'''\bhintText\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('tooltip', RegExp(r'''\btooltip\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern(
        'lookup message',
        RegExp(r'''\blookupMessage\s*=\s*(?:r)?(['"])(.*?)\1'''),
      ),
    ];
    final allowedPrefixes = [
      'action.',
      'clinical_ai.',
      'dashboard.',
      'leave.',
      'nursing_notes.',
      'patient_records.',
      'prescriptions.',
      'radiology.',
      'reception_counter.',
      's4.dynamic.patient_records.',
      's4.lib.patient_records.',
    ];

    final hits = <String>[
      ..._literalHits(file, patterns),
      ..._interpolatedLiteralHits(file, patterns),
    ];
    final keys = _appStringKeysFrom(file.readAsStringSync(), allowedPrefixes);

    expect(
      hits,
      isEmpty,
      reason:
          'S4 Patient Records empty states, upload form copy, preview labels, '
          'and extraction dialog copy should use AppStrings keys.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 Patient Records keys must have en/hi/ta/te entries.',
    );
  });

  test('S4 Front Office Workbench copy stores keys with required locale entries', () {
    final files = [
      File('lib/features/reception/screens/front_office_workbench_screen.dart'),
      File(
        'lib/features/reception/screens/components/front_office_workbench_helpers.dart',
      ),
      File(
        'lib/features/reception/screens/components/front_office_workbench_actions.dart',
      ),
      File(
        'lib/features/reception/screens/components/front_office_workbench_patient_dialogs.dart',
      ),
      File(
        'lib/features/reception/screens/components/front_office_workbench_walk_in_dialog.dart',
      ),
      File(
        'lib/features/reception/screens/components/front_office_workbench_admission_dialogs.dart',
      ),
      File(
        'lib/features/reception/screens/components/front_office_workbench_queue_dialogs.dart',
      ),
      File(
        'lib/features/reception/screens/components/front_office_workbench_sections.dart',
      ),
      File(
        'lib/features/reception/screens/components/front_office_workbench_widgets.dart',
      ),
    ];
    final patterns = [
      _Pattern(
        'AppText display copy',
        RegExp(
          r'''(?:^|[^A-Za-z0-9_.])(?:const\s+)?AppText\(\s*(?:r)?(['"])(.*?)\1''',
        ),
      ),
      _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('text', RegExp(r'''\btext\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('message', RegExp(r'''\bmessage\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern(
        'dialogError',
        RegExp(r'''\bdialogError\s*=\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern(
        'successMessage',
        RegExp(r'''\bsuccessMessage\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
    ];
    final allowedPrefixes = [
      'front_office.appointment_status.',
      's4.dynamic.front_office.',
      's4.dynamic.front_office_workbench.',
      's4.lib.front_office_workbench.',
    ];

    final hits = <String>[
      for (final file in files) ..._literalHits(file, patterns),
      for (final file in files) ..._interpolatedLiteralHits(file, patterns),
    ];
    final source = files.map((file) => file.readAsStringSync()).join('\n');
    final keys = <String>{
      ..._appStringKeysFrom(source, allowedPrefixes),
      ..._appStringCallKeysFrom(source, allowedPrefixes),
      ..._appStringPrefixedTokensFrom(source, allowedPrefixes),
    };

    expect(
      source,
      allOf(
        contains('_frontOfficeAdmissionPriorityLabel'),
        contains('_frontOfficeCodeStatusLabel'),
        contains('_frontOfficeOpAppointmentsTodayLabel'),
        contains('_frontOfficeBillsDueLabel'),
        isNot(contains('child: Text(value)')),
      ),
      reason:
          'Front Office dropdown option values and count copy must preserve '
          'stable domain values while rendering localized labels.',
    );
    expect(
      hits,
      isEmpty,
      reason:
          'S4 Front Office Workbench labels, validation errors, empty states, '
          'snackbars, and admission handoff copy should use AppStrings keys.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 Front Office Workbench keys must have en/hi/ta/te entries.',
    );
  });

  test('S4 Messaging copy stores keys with required locale entries', () {
    final files = [
      File('lib/features/messaging/screens/messaging_inbox_screen.dart'),
      File('lib/features/messaging/screens/messaging_thread_screen.dart'),
    ];
    final patterns = [
      _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('body', RegExp(r'''\bbody\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('message', RegExp(r'''\bmessage\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('tooltip', RegExp(r'''\btooltip\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern(
        'labelText',
        RegExp(r'''\blabelText\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern('hintText', RegExp(r'''\bhintText\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern(
        'fallback display value',
        RegExp(
          r'''\b(?:name|department|partnerName|fileName)\s*:\s*(?:r)?(['"])(.*?)\1''',
        ),
      ),
      _Pattern(
        'snackbar validation',
        RegExp(r'''_showError\(\s*(?:r)?(['"])(.*?)\1'''),
      ),
    ];
    final allowedPrefixes = [
      'action.',
      'clinical_inbox.',
      'messaging.',
      'priority.',
      'profile.',
      's4.dynamic.messaging.',
      's4.lib.messaging_inbox.',
      's4.lib.messaging_thread.',
    ];

    final hits = <String>[];
    for (final file in files) {
      hits.addAll(_literalHits(file, patterns));
      hits.addAll(_interpolatedLiteralHits(file, patterns));
    }

    final keys = <String>{};
    for (final file in files) {
      keys.addAll(_appStringKeysFrom(file.readAsStringSync(), allowedPrefixes));
    }

    expect(
      hits,
      isEmpty,
      reason:
          'S4 Messaging filters, empty states, snackbars, attachment statuses, '
          'and receipt tooltips should use AppStrings keys.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 Messaging keys must have en/hi/ta/te entries.',
    );
  });

  test('S4 Pharmacy copy stores keys with required locale entries', () {
    final file = File('lib/features/pharmacy/screens/pharmacy_screen.dart');
    final patterns = [
      _Pattern(
        'AppText display copy',
        RegExp(
          r'''(?:^|[^A-Za-z0-9_.])(?:const\s+)?AppText\(\s*(?:r)?(['"])(.*?)\1''',
        ),
      ),
      _Pattern(
        'StaffScaffold title',
        RegExp(r'''StaffScaffold\(\s*\btitle\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern('title', RegExp(r'''\btitle\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('content', RegExp(r'''\bcontent\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('hintText', RegExp(r'''\bhintText\s*:\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern('snackbar', RegExp(r'''_snack\(\s*(?:r)?(['"])(.*?)\1''')),
      _Pattern(
        'metric label',
        RegExp(r'''_CatalogMetric\(\s*label\s*:\s*(?:r)?(['"])(.*?)\1'''),
      ),
      _Pattern(
        'display fallback',
        RegExp(
          r'''\?\?\s*(?:r)?(['"])(?:Unknown|Unnamed item|Unnamed drug|this drug)\1''',
        ),
      ),
    ];
    final allowedPrefixes = [
      'action.',
      'lab_bookings.',
      'patient_records.',
      'pharmacy.',
      'reception_counter.',
      's4.dynamic.pharmacy.',
      's4.lib.pharmacy.',
      'theatre.',
      'vitals_chart.',
    ];

    final hits = <String>[
      ..._literalHits(file, patterns),
      ..._interpolatedLiteralHits(file, patterns),
    ];
    final keys = _appStringKeysFrom(file.readAsStringSync(), allowedPrefixes);

    expect(
      hits,
      isEmpty,
      reason:
          'S4 Pharmacy dialogs, snackbars, form validation, summaries, metrics, '
          'and fallback labels should use AppStrings keys.',
    );
    keys.addAll(
      _appStringCallKeysFrom(file.readAsStringSync(), allowedPrefixes),
    );
    keys.addAll(
      _appStringPrefixedTokensFrom(file.readAsStringSync(), allowedPrefixes),
    );
    expect(
      keys,
      contains('reception_counter.patient.phone'),
      reason:
          'The Pharmacy guard must include reused multiline lookup keys, not '
          'only same-line labels.',
    );
    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 Pharmacy keys must have en/hi/ta/te entries.',
    );
  });

  test(
    'S4 appointments and lab bookings copy stores keys with required locale entries',
    () {
      final files = [
        File('lib/features/appointments/screens/appointments_screen.dart'),
        File('lib/features/investigations/screens/lab_bookings_screen.dart'),
      ];
      final allowedPrefixes = [
        'appt_queue.',
        'lab_bookings.',
        'reception_counter.',
        's4.dynamic.appointments.',
        's4.dynamic.lab_bookings.',
        's4.lib.appointments.',
        's4.lib.lab_bookings.',
      ];
      final rawFragments = [
        "'Enter phone to check registered patient'",
        "'Checking patient registry...'",
        "'New patient - enter name to register while booking'",
        "'Existing patient found'",
        "'Existing patient found: #",
        "'Could not check registry now; new-patient booking is available'",
        "'Enter a valid phone number'",
        "'Enter patient name for new patient'",
        "'Select a doctor or department'",
        "'Enter at least 3 characters'",
        "'Creating...'",
        "'Create Appointment'",
        "'Attach prescription'",
        "'Booking...'",
        "'Book Lab'",
        "'Lab booking created'",
        "'Scan and collect'",
        "'Error: \$e'",
        "'Specimen collected, but queue update failed:",
      ];

      final keys = <String>{};
      for (final file in files) {
        final source = file.readAsStringSync();
        keys
          ..addAll(_appStringKeysFrom(source, allowedPrefixes))
          ..addAll(_appStringCallKeysFrom(source, allowedPrefixes))
          ..addAll(_appStringPrefixedTokensFrom(source, allowedPrefixes));
        for (final rawCopy in rawFragments) {
          expect(
            source,
            isNot(contains(rawCopy)),
            reason:
                'Appointments and lab bookings display copy should use '
                'AppStrings keys: $rawCopy',
          );
        }
      }

      expect(
        _missingLocaleEntries(keys),
        isEmpty,
        reason:
            'S4 appointments/lab booking keys must have en/hi/ta/te entries.',
      );
    },
  );

  test(
    'S4 EMR notes admissions and discharge copy stores keys with required locale entries',
    () {
      final files = [
        File('lib/features/emr/screens/clinical_notes_screen.dart'),
        File('lib/features/emr/screens/admission_screen.dart'),
        File('lib/features/emr/screens/discharge_summary_screen.dart'),
      ];
      final allowedPrefixes = [
        'admission.',
        'ai_assist.',
        'clinical_notes.',
        'discharge.',
        's4.dynamic.admission.',
        's4.dynamic.clinical_notes.',
        's4.dynamic.discharge_summary.',
        's4.lib.admission.',
        's4.lib.clinical_notes.',
        's4.lib.discharge_hub.',
        's4.lib.discharge_summary.',
      ];
      final rawFragments = [
        "'This OP visit is",
        "'OP Consultation'",
        "'review: pending'",
        "'gen #",
        "'Consultation note updated'",
        "'Could not load existing summary:",
        "'Failed to generate summary:",
        "'Hospital formatted summary'",
        "'AI-generated draft - doctor review required'",
        "'No safety flags'",
        "'All active inpatients'",
        "'Admitting doctor is required'",
        "'Hospital ID'",
        "'Admission status'",
        "'No discharged admissions'",
      ];

      final keys = <String>{};
      for (final file in files) {
        final source = file.readAsStringSync();
        keys
          ..addAll(_appStringKeysFrom(source, allowedPrefixes))
          ..addAll(_appStringCallKeysFrom(source, allowedPrefixes))
          ..addAll(_appStringPrefixedTokensFrom(source, allowedPrefixes));
        for (final rawCopy in rawFragments) {
          expect(
            source,
            isNot(contains(rawCopy)),
            reason:
                'S4 EMR notes/admissions/discharge copy should use '
                'AppStrings keys: $rawCopy',
          );
        }
      }

      expect(
        _missingLocaleEntries(keys),
        isEmpty,
        reason: 'S4 EMR copy keys must have en/hi/ta/te entries.',
      );
    },
  );

  test('S4 bed board sheet copy stores keys with required locale entries', () {
    final file = File('lib/features/beds/screens/bed_board_screen.dart');
    final source = file.readAsStringSync();
    final keys = <String>{
      'bed_board.load_wards_failed',
      'bed_board.server_unreachable',
      'bed_board.semantic.has_notes',
      'bed_board.semantic.view_details',
      'bed_board.semantic.view_details_edit_notes',
      'bed_sheet.action.case_sheet',
      'bed_sheet.action.discharge',
      'bed_sheet.action.drug_chart',
      'bed_sheet.admit_failed',
      'bed_sheet.bed_marked_available',
      'bed_sheet.discharge_failed',
      'bed_sheet.field.assigned_cleaning',
      'bed_sheet.field.hospital_id',
      'bed_sheet.load_available_beds_failed',
      'bed_sheet.mark_ready_failed',
      'bed_sheet.missing_bed_id_cannot_save_notes',
      'bed_sheet.patient_search_failed',
      'bed_sheet.patient_uid_missing_cannot_transfer_bed',
      'bed_sheet.save_failed',
      'bed_sheet.save_notes_failed',
      'bed_sheet.section.housekeeping',
      'bed_sheet.status_change_failed',
      'bed_sheet.target_bed_missing',
      'bed_sheet.transfer_failed',
      's4.dynamic.bed_board.cleaning_assignee',
      's4.dynamic.bed_board.semantic.cleaning_assigned_to',
      's4.dynamic.bed_board.semantic.hospital_id',
      's4.dynamic.bed_board.semantic.patient',
      's4.dynamic.bed_sheet.quick_action_for_patient',
      's4.dynamic.bed_sheet.quick_action_hint',
    };

    final rawFragments = [
      "'Cleaning: \$",
      "'Housekeeping'",
      "'Assigned cleaning'",
      "'Hospital ID'",
      "'Case Sheet'",
      "'Drug Chart'",
      "label: 'Discharge'",
      "'Opens the",
      "'Double tap",
      "'has notes'",
      "'cleaning assigned",
      "'discharge initiated'",
      "'Bed id missing",
      "'Failed to save",
      "'Could not connect to server'",
      "'Status change failed'",
      "'Bed marked available'",
      "'Could not mark ready'",
      "'Discharge failed'",
      "'Patient UID missing",
      "'Target bed id missing'",
      "'Transfer failed'",
      "'Admit failed'",
      "'Failed to load available beds'",
      "'Search failed'",
      "'Ward \$",
    ];

    for (final rawCopy in rawFragments) {
      expect(
        source,
        isNot(contains(rawCopy)),
        reason: 'S4 bed board display copy should use AppStrings: $rawCopy',
      );
    }

    expect(
      _missingLocaleEntries(keys),
      isEmpty,
      reason: 'S4 bed board sheet keys must have en/hi/ta/te entries.',
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
  _Pattern('label', RegExp(r'''\blabel\s*:\s*(?:r)?(['"])(.*?)\1''')),
  _Pattern('labelText', RegExp(r'''\blabelText\s*:\s*(?:r)?(['"])(.*?)\1''')),
  _Pattern('hintText', RegExp(r'''\bhintText\s*:\s*(?:r)?(['"])(.*?)\1''')),
  _Pattern('helperText', RegExp(r'''\bhelperText\s*:\s*(?:r)?(['"])(.*?)\1''')),
  _Pattern('errorText', RegExp(r'''\berrorText\s*:\s*(?:r)?(['"])(.*?)\1''')),
  _Pattern(
    'Toast.show',
    RegExp(
      r'''(?:SuccessToast|ErrorToast|InfoToast)\.show\([^,\n]+,\s*(?:r)?(['"])(.*?)\1''',
    ),
  ),
];

final _allowlist = <String>{
  'lib/features/about/screens/about_screen.dart|support@vhhealth.in',
  'lib/features/doctor/screens/prescriptions_screen.dart|A',
  'lib/features/doctor/screens/prescriptions_screen.dart|N',
};

final _housekeepingGuardAllowlist = <String>{
  'fallback: "08:00:00"',
  'fallback: "16:00:00"',
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

Iterable<String> _interpolatedLiteralHits(
  File file,
  List<_Pattern> patterns,
) sync* {
  final path = file.path.replaceAll('\\', '/');
  final lines = file.readAsLinesSync();
  for (var index = 0; index < lines.length; index += 1) {
    final line = lines[index];
    final trimmed = line.trimLeft();
    if (trimmed.startsWith('//') || trimmed.startsWith('///')) continue;
    for (final pattern in patterns) {
      for (final match in pattern.regex.allMatches(line)) {
        final value = match.group(2) ?? '';
        if (!value.contains(r'$')) continue;
        final copyOnly = value.replaceAll(RegExp(r'\$\{?[\w.?!\[\] ]+\}?'), '');
        if (!RegExp(r'[A-Za-z]').hasMatch(copyOnly)) continue;
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

Set<String> _appStringCallKeysFrom(String source, List<String> prefixes) {
  final keys = <String>{};
  final regex = RegExp(
    r'''(?:AppText|format|lookup)\s*\(\s*(?:r)?(['"])([^'"]+)\1''',
    dotAll: true,
  );
  for (final match in regex.allMatches(source)) {
    final key = match.group(2)!;
    if (key.contains(r'$')) continue;
    if (prefixes.any(key.startsWith)) {
      keys.add(key);
    }
  }
  return keys;
}

Set<String> _appStringPrefixedTokensFrom(String source, List<String> prefixes) {
  final keys = <String>{};
  final prefixPattern = prefixes.map(RegExp.escape).join('|');
  final regex = RegExp('(?:$prefixPattern)[A-Za-z0-9_.-]+');
  for (final match in regex.allMatches(source)) {
    final key = match.group(0)!;
    if (key.contains(r'$')) continue;
    keys.add(key);
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
