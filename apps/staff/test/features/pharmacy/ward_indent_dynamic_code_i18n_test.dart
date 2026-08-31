import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/pharmacy/widgets/ward_indent_workbench.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  const newKeys = <String>[
    'ward_indent.code.unknown',
    'ward_indent.sla.status.active',
    'ward_indent.sla.status.breached',
    'ward_indent.sla.status.escalated',
    'ward_indent.sla.rule.ward_indent_pharmacy_response',
    'ward_indent.sla.rule.ward_indent_substitution_authorization',
    'ward_indent.sla.rule.ward_indent_controlled_handoff',
    'ward_indent.sla.rule.ward_indent_pharmacy_issue',
    'ward_indent.sla.rule.ward_indent_ward_receipt',
    'ward_indent.sla.rule.ward_indent_reconciliation',
    'ward_indent.sla.rule.ward_indent_notification_coverage',
    'ward_indent.sla.rule.ward_indent_credit_note_review',
    'ward_indent.sla.rule.ward_indent_mar_supply_reconciliation',
    'ward_indent.controlled.recovery_status.available',
    'ward_indent.controlled.recovery_status.missing',
    'ward_indent.controlled.recovery_status.ambiguous',
    'ward_indent.controlled.recovery_status.corrupt',
  ];

  test('dynamic ward-indent codes use localized display labels', () {
    final strings = AppStrings.forLocale(const Locale('en'));
    const samples = <(WardIndentCodeKind, String)>[
      (WardIndentCodeKind.status, 'reconciliation_required'),
      (WardIndentCodeKind.slaStatus, 'breached'),
      (WardIndentCodeKind.slaRule, 'ward_indent_substitution_authorization'),
      (WardIndentCodeKind.recovery, 'ambiguous'),
      (WardIndentCodeKind.recovery, 'corrupt'),
      (WardIndentCodeKind.event, 'controlled_handoff_recorded'),
      (WardIndentCodeKind.substitution, 'pending'),
      (WardIndentCodeKind.fulfilment, 'partially_received'),
    ];

    for (final sample in samples) {
      final localized = localizedWardIndentCode(strings, sample.$1, sample.$2);
      expect(localized, isNot(sample.$2), reason: '${sample.$1} ${sample.$2}');
      expect(localized, isNot(contains('_')));
    }
    expect(
      localizedWardIndentCode(strings, WardIndentCodeKind.recovery, 'corrupt'),
      'Custody evidence conflict',
    );
    expect(
      localizedWardIndentCode(
        strings,
        WardIndentCodeKind.event,
        'future_backend_event',
      ),
      'Unrecognized workflow state',
    );
  });

  test('new dynamic-code labels have five-locale technical parity', () {
    final english = AppStrings.forLocale(const Locale('en'));
    for (final locale in const ['hi', 'ta', 'te', 'ml']) {
      final localized = AppStrings.forLocale(Locale(locale));
      for (final key in newKeys) {
        expect(localized.lookup(key), isNot(key), reason: '$locale $key');
        expect(
          localized.lookup(key),
          isNot(english.lookup(key)),
          reason: '$locale must not fall back to English for $key',
        );
      }
    }
  });
}
