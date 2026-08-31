import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

NotificationItem _item(
  String type, {
  String? actionLabelKey,
  Map<String, dynamic> data = const {},
}) {
  return NotificationItem(
    title: 'SERVER ENGLISH TITLE',
    body: 'SERVER ENGLISH BODY',
    timestamp: DateTime.utc(2026, 8, 28),
    type: type,
    data: {
      'deep_link': '/billing/refunds?refund_id=31',
      'action_label_key': ?actionLabelKey,
      ...data,
    },
  );
}

void main() {
  const locales = ['en', 'hi', 'ta', 'te', 'ml'];
  const presentationTypes = [
    'mar_medication_exception',
    'mar_medication_exception_escalation',
    'mar_medication_exception_assignment_handoff',
    'counter_sale_void_refund_required',
    'counter_sale_void_refund_payout_required',
    'counter_sale_void_rejected_review_required',
    'counter_sale_void_refund_rejected',
    'counter_sale_void_completed',
    'ward_indent_credit_note_review',
    'ward_indent_credit_note_refund_approval',
    'ward_indent_credit_note_refund_payout',
    'ward_indent_mar_supply_reconciliation',
    'clinical_alert_delivery_recovery_overdue',
  ];

  test('MED-03 notifications never render backend English title or body', () {
    for (final locale in locales) {
      final strings = AppStrings.forLocale(Locale(locale));
      for (final type in presentationTypes) {
        final item = _item(type);
        expect(item.titleFor(strings), isNot('SERVER ENGLISH TITLE'));
        expect(item.bodyFor(strings), isNot('SERVER ENGLISH BODY'));
        expect(item.titleFor(strings), isNotEmpty);
        expect(item.bodyFor(strings), isNotEmpty);
        expect(item.titleFor(strings), isNot(contains('med03.')));
        expect(item.bodyFor(strings), isNot(contains('med03.')));
      }
    }
  });

  test(
    'MAR and counter-sale action labels are localized and semantically exact',
    () {
      for (final locale in locales) {
        final strings = AppStrings.forLocale(Locale(locale));
        expect(
          _item(
            'mar_medication_exception',
            actionLabelKey: 'orders.mar_recovery.action',
          ).actionLabelFor(strings),
          strings.lookup('orders.mar_recovery.action'),
        );
        expect(
          _item(
            'counter_sale_void_refund_required',
            actionLabelKey: 's4.lib.counter_sale.open_finance_workflow',
          ).actionLabelFor(strings),
          strings.lookup('s4.lib.counter_sale.open_finance_workflow'),
        );
        expect(
          _item(
            'counter_sale_void_refund_rejected',
            actionLabelKey: 's4.lib.counter_sale.open_reconciliation',
          ).actionLabelFor(strings),
          strings.lookup('s4.lib.counter_sale.open_reconciliation'),
        );
      }
    },
  );

  test(
    'clinical-alert recovery copy is case-specific in every MED-03 locale',
    () {
      for (final locale in locales) {
        final strings = AppStrings.forLocale(Locale(locale));
        for (final caseKind in const ['manual_hold', 'recipient_coverage']) {
          final item = _item(
            'clinical_alert_delivery_recovery_overdue',
            actionLabelKey: 'clinical_inbox.open_workflow',
            data: {'case_kind': caseKind},
          );
          expect(item.titleFor(strings), isNot('SERVER ENGLISH TITLE'));
          expect(item.bodyFor(strings), isNot('SERVER ENGLISH BODY'));
          expect(item.titleFor(strings), isNotEmpty);
          expect(item.bodyFor(strings), isNotEmpty);
          expect(
            item.actionLabelFor(strings),
            strings.lookup('clinical_inbox.open_workflow'),
          );
        }
      }
    },
  );

  test(
    'known MED-03 types stay localized during a rolling backend upgrade',
    () {
      final strings = AppStrings.forLocale(const Locale('ml'));
      expect(
        _item('mar_medication_exception').actionLabelFor(strings),
        strings.lookup('orders.mar_recovery.action'),
      );
      expect(
        _item('counter_sale_void_refund_payout_required')
            .actionLabelFor(strings),
        strings.lookup('s4.lib.counter_sale.open_finance_workflow'),
      );
      expect(
        _item('counter_sale_void_completed').actionLabelFor(strings),
        strings.lookup('s4.lib.counter_sale.open_reconciliation'),
      );
    },
  );
}
