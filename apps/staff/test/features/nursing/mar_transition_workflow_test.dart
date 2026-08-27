import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/nursing/screens/due_meds_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  const transitionKeys = <String>[
    'due_meds.actions.label',
    'due_meds.actions.miss',
    'due_meds.actions.hold',
    'due_meds.actions.miss_title',
    'due_meds.actions.hold_title',
    'due_meds.actions.miss_body',
    'due_meds.actions.hold_body',
    'due_meds.actions.reason_label',
    'due_meds.actions.reason_hint',
    'due_meds.actions.reason_required',
    'due_meds.actions.cancel',
    'due_meds.actions.confirm_miss',
    'due_meds.actions.confirm_hold',
    'due_meds.actions.miss_success',
    'due_meds.actions.hold_success',
  ];

  test('only a scheduled dose exposes miss and hold transitions', () {
    expect(availableMarDueTransitions({'status': 'scheduled'}), const [
      MarDueTransition.miss,
      MarDueTransition.hold,
    ]);
    for (final status in ['held', 'missed', 'administered', null]) {
      expect(
        availableMarDueTransitions({'status': status}),
        isEmpty,
        reason: '$status must not expose another transition',
      );
    }
  });

  test('MAR miss and hold safety copy exists in all five locales', () {
    final english = AppStrings.forLocale(const Locale('en'));
    for (final locale in const ['hi', 'ta', 'te', 'ml']) {
      final localized = AppStrings.forLocale(Locale(locale));
      for (final key in transitionKeys) {
        expect(localized.lookup(key), isNot(key), reason: '$locale $key');
        expect(
          localized.lookup(key),
          isNot(english.lookup(key)),
          reason: '$locale must not fall back to English for $key',
        );
      }
    }
  });

  test('Malayalam due-med filters and timing copy do not fall back', () {
    final english = AppStrings.forLocale(const Locale('en'));
    final malayalam = AppStrings.forLocale(const Locale('ml'));
    for (final key in const [
      'due_meds.filter.all_wards',
      'due_meds.filter.all_routes',
      'due_meds.filter.route_label',
      's4.dynamic.due_meds.ward_fallback',
      'due_meds.unscheduled',
      's4.dynamic.due_meds.due_late',
      's4.dynamic.due_meds.due_in',
    ]) {
      expect(malayalam.lookup(key), isNot(english.lookup(key)), reason: key);
    }
  });
}
