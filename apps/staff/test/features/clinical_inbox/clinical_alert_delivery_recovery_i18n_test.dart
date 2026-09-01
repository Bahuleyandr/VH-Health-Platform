import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/clinical_inbox/screens/clinical_alert_delivery_recovery_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  const fixedKeys = <String>[
    'med03.alert_recovery.title',
    'med03.alert_recovery.empty',
    'med03.alert_recovery.load_failed',
    'med03.alert_recovery.action_failed',
    'med03.alert_recovery.field.case_status',
    'med03.alert_recovery.field.delivery_status',
    'med03.alert_recovery.field.task_status',
    'med03.alert_recovery.field.sla_status',
    'med03.alert_recovery.field.source',
    'med03.alert_recovery.field.failure',
    'med03.alert_recovery.field.timing',
    'med03.alert_recovery.field.last_error',
    'med03.alert_recovery.field.hold_reason',
    'med03.alert_recovery.field.resolution',
    'med03.alert_recovery.timing_value',
    'med03.notification.clinical_alert_recovery.overdue_title',
    'med03.notification.clinical_alert_recovery.overdue_body',
    'med03.notification.clinical_alert_recovery.action',
  ];
  const categoryCodes = <String, List<String>>{
    'case_kind': ['manual_hold', 'recipient_coverage', 'unknown'],
    'source': ['clinical_orders', 'icu_admissions', 'unknown'],
    'case_status': ['open', 'resolved', 'unknown'],
    'delivery_status': ['pending', 'completed', 'manual_hold', 'unknown'],
    'task_status': [
      'open',
      'in_progress',
      'blocked',
      'completed',
      'cancelled',
      'overdue',
      'unknown',
    ],
    'sla_status': [
      'active',
      'completed',
      'breached',
      'escalated',
      'cancelled',
      'unknown',
    ],
    'failure': [
      'order_mar_schedule',
      'order_mar_carryover',
      'icu_mar_carryover_query',
      'unknown',
    ],
    'resolution': ['recovered', 'manual_hold', 'superseded', 'unknown'],
    'error': [
      'no_active_clinical_recipients',
      'clinical_alert_recovery_queue_failed',
      'clinical_alert_obligation_intent_invalid',
      'clinical_alert_obligation_policy_invalid',
      'clinical_alert_obligation_source_missing',
      'clinical_alert_obligation_source_mismatch',
      'unknown',
    ],
  };

  final keys = <String>[
    ...fixedKeys,
    for (final category in categoryCodes.entries)
      for (final code in category.value)
        'med03.alert_recovery.${category.key}.$code',
  ];

  test('alert recovery presentation ships in all five staff locales', () {
    final english = AppStrings.forLocale(const Locale('en'));
    for (final locale in const ['hi', 'ta', 'te', 'ml']) {
      final localized = AppStrings.forLocale(Locale(locale));
      for (final key in keys) {
        expect(localized.lookup(key), isNot(key), reason: '$locale $key');
        expect(
          localized.lookup(key),
          isNot(english.lookup(key)),
          reason: '$locale must not fall back to English for $key',
        );
      }
    }
  });

  test('known alert recovery codes use bounded localized mappings', () {
    final strings = AppStrings.forLocale(const Locale('en'));
    final cases = <String Function(Object?), Map<String, String>>{
      (value) => localizedClinicalAlertRecoveryCaseKind(strings, value): {
        'manual_hold': 'case_kind.manual_hold',
        'recipient_coverage': 'case_kind.recipient_coverage',
      },
      (value) => localizedClinicalAlertRecoverySource(strings, value): {
        'clinical_orders': 'source.clinical_orders',
        'icu_admissions': 'source.icu_admissions',
      },
      (value) => localizedClinicalAlertRecoveryCaseStatus(strings, value): {
        'open': 'case_status.open',
        'resolved': 'case_status.resolved',
      },
      (value) => localizedClinicalAlertRecoveryDeliveryStatus(strings, value): {
        'pending': 'delivery_status.pending',
        'completed': 'delivery_status.completed',
        'manual_hold': 'delivery_status.manual_hold',
      },
      (value) => localizedClinicalAlertRecoveryTaskStatus(strings, value): {
        for (final code in categoryCodes['task_status']!.where(
          (code) => code != 'unknown',
        ))
          code: 'task_status.$code',
      },
      (value) => localizedClinicalAlertRecoverySlaStatus(strings, value): {
        for (final code in categoryCodes['sla_status']!.where(
          (code) => code != 'unknown',
        ))
          code: 'sla_status.$code',
      },
      (value) => localizedClinicalAlertRecoveryFailureKind(strings, value): {
        for (final code in categoryCodes['failure']!.where(
          (code) => code != 'unknown',
        ))
          code: 'failure.$code',
      },
      (value) => localizedClinicalAlertRecoveryResolution(strings, value): {
        for (final code in categoryCodes['resolution']!.where(
          (code) => code != 'unknown',
        ))
          code: 'resolution.$code',
      },
      (value) => localizedClinicalAlertRecoveryError(strings, value): {
        for (final code in categoryCodes['error']!.where(
          (code) => code != 'unknown',
        ))
          code: 'error.$code',
      },
    };

    for (final category in cases.entries) {
      for (final example in category.value.entries) {
        expect(
          category.key(example.key),
          strings.lookup('med03.alert_recovery.${example.value}'),
        );
      }
    }
  });

  test('unknown or future alert recovery codes never render raw values', () {
    final strings = AppStrings.forLocale(const Locale('en'));
    final mappings = <String, String Function(Object?)>{
      'case_kind': (value) =>
          localizedClinicalAlertRecoveryCaseKind(strings, value),
      'source': (value) => localizedClinicalAlertRecoverySource(strings, value),
      'case_status': (value) =>
          localizedClinicalAlertRecoveryCaseStatus(strings, value),
      'delivery_status': (value) =>
          localizedClinicalAlertRecoveryDeliveryStatus(strings, value),
      'task_status': (value) =>
          localizedClinicalAlertRecoveryTaskStatus(strings, value),
      'sla_status': (value) =>
          localizedClinicalAlertRecoverySlaStatus(strings, value),
      'failure': (value) =>
          localizedClinicalAlertRecoveryFailureKind(strings, value),
      'resolution': (value) =>
          localizedClinicalAlertRecoveryResolution(strings, value),
      'error': (value) => localizedClinicalAlertRecoveryError(strings, value),
    };
    for (final mapping in mappings.entries) {
      expect(
        mapping.value('future_backend_code'),
        strings.lookup('med03.alert_recovery.${mapping.key}.unknown'),
      );
    }
  });
}
