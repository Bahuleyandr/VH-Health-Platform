import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  const supplyKeys = <String>[
    'mar_scan.supply.title',
    'mar_scan.supply.status.available',
    'mar_scan.supply.status.quantity_required',
    'mar_scan.supply.status.custody_unavailable',
    'mar_scan.supply.status.substitution_acknowledgement_required',
    'mar_scan.supply.status.order_link_required',
    'mar_scan.supply.status.ward_item_required',
    'mar_scan.supply.status.ward_item_ambiguous',
    'mar_scan.supply.status.reconciliation_required',
    'mar_scan.supply.status.batch_unavailable',
    'mar_scan.supply.status.unknown',
    'mar_scan.supply.available_quantity',
    'mar_scan.supply.required_quantity',
    'mar_scan.supply.batch_line',
    'mar_scan.supply.blocked',
    'mar_scan.supply.quantity_label',
    'mar_scan.supply.override_reason_label',
    'mar_scan.supply.override_warning',
    'mar_scan.supply.quantity_error',
    'mar_scan.supply.override_error',
    'mar_scan.supply.hard_stop_error',
    'mar_supply.notification_action',
  ];

  test('MAR supply safety copy is localized in all five shipped locales', () {
    final english = AppStrings.forLocale(const Locale('en'));
    for (final locale in const ['hi', 'ta', 'te', 'ml']) {
      final localized = AppStrings.forLocale(Locale(locale));
      for (final key in supplyKeys) {
        expect(localized.lookup(key), isNot(key), reason: '$locale $key');
        expect(
          localized.lookup(key),
          isNot(english.lookup(key)),
          reason: '$locale must not fall back to English for $key',
        );
      }
    }
  });

  test('Malayalam carries the non-overridable identity hard-stop copy', () {
    final english = AppStrings.forLocale(const Locale('en'));
    final malayalam = AppStrings.forLocale(const Locale('ml'));
    for (final key in const [
      'mar_scan.hardstop.title',
      'mar_scan.hardstop.patient',
      'mar_scan.hardstop.drug',
      'mar_scan.hardstop.body',
    ]) {
      expect(malayalam.lookup(key), isNot(english.lookup(key)), reason: key);
    }
  });

  test('MAR reconciliation notification action follows the active locale', () {
    final item = NotificationItem(
      title: 'MAR supply evidence required',
      body: 'Reconcile exact allocation quantities',
      timestamp: DateTime.utc(2026, 8, 27),
      type: 'ward_indent_mar_supply_reconciliation',
    );

    for (final locale in AppStrings.supportedLocales) {
      final strings = AppStrings.forLocale(locale);
      expect(
        item.actionLabelFor(strings),
        strings.lookup('mar_supply.notification_action'),
        reason: locale.languageCode,
      );
    }
    expect(item.actionLabel, 'Reconcile MAR supply');
  });

  test('ward allocation label is not cross-wired between scripts', () {
    expect(
      AppStrings.forLocale(const Locale('en')).lookup('mar_supply.allocation'),
      'Ward allocation',
    );
    expect(
      AppStrings.forLocale(const Locale('ta')).lookup('mar_supply.allocation'),
      'வார்டு ஒதுக்கீடு',
    );
    expect(
      AppStrings.forLocale(const Locale('te')).lookup('mar_supply.allocation'),
      'వార్డు కేటాయింపు',
    );
  });
}
