import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/features/reception/screens/billing_credit_notes_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  const keys = <String>[
    'med03.credit_note.title',
    'med03.credit_note.open_queue',
    'med03.credit_note.access_denied',
    'med03.credit_note.queue',
    'med03.credit_note.empty',
    'med03.credit_note.select',
    'med03.credit_note.approve_body',
    'med03.credit_note.apply_body',
    'med03.credit_note.refund_approve_body',
    'med03.credit_note.gateway_body',
    'med03.credit_note.application_owned',
    'med03.credit_note.refund_pending',
    'med03.credit_note.gateway_in_progress',
    'med03.credit_note.manual_help',
    'med03.credit_note.gateway_help',
    'med03.credit_note.gateway_candidates_empty',
    'med03.credit_note.insurance_hold',
    'med03.credit_note.refund_paid',
    'med03.credit_note.status.paid',
    'med03.credit_note.status.unknown',
    'med03.credit_note.event.raised',
    'med03.credit_note.notification_action',
    'med03.credit_note.refund_mode.cash',
    'med03.credit_note.refund_mode.card',
    'med03.credit_note.refund_mode.netbanking',
    'med03.credit_note.refund_mode.cheque',
    'med03.credit_note.refund_mode.dd',
    'med03.credit_note.refund_mode.wallet',
    'med03.credit_note.refund_mode.insurance',
    'med03.credit_note.refund_mode.unknown',
  ];

  test(
    'credit-note ownership and payout copy is localized in five locales',
    () {
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
    },
  );

  test('credit-note wire statuses and events never render raw codes', () {
    final strings = AppStrings.forLocale(const Locale('en'));
    for (final status in const [
      'pending',
      'approved',
      'applied',
      'rejected',
      'paid',
    ]) {
      expect(localizedBillingCreditNoteStatus(strings, status), isNot(status));
    }
    expect(localizedBillingCreditNoteEvent(strings, 'raised'), 'Raised');
    expect(
      localizedBillingCreditNoteEvent(strings, 'future_backend_code'),
      'Unknown status',
    );
    expect(
      localizedBillingCreditNoteStatus(strings, 'future_backend_code'),
      isNot(contains('future_backend_code')),
    );
  });

  test(
    'refund tender codes render localized labels or a safe unknown label',
    () {
      for (final locale in const ['en', 'hi', 'ta', 'te', 'ml']) {
        final strings = AppStrings.forLocale(Locale(locale));
        for (final mode in const [
          'CASH',
          'CARD',
          'UPI',
          'NETBANKING',
          'CHEQUE',
          'DD',
          'WALLET',
          'INSURANCE',
        ]) {
          final localized = localizedBillingRefundMode(strings, mode);
          final key = 'med03.credit_note.refund_mode.${mode.toLowerCase()}';
          expect(localized, strings.lookup(key));
          expect(localized, isNot(key));
          if (mode != 'UPI') {
            expect(
              localized,
              isNot(mode),
              reason: '$locale rendered raw $mode',
            );
          }
        }
        expect(
          localizedBillingRefundMode(strings, 'FUTURE_RAIL'),
          strings.lookup('med03.credit_note.refund_mode.unknown'),
        );
      }
    },
  );

  test('credit-note notification action key localizes without bypassing route safety', () {
    final item = NotificationItem(
      title: 'Credit note review',
      body: 'Review required',
      timestamp: DateTime.utc(2026, 8, 27),
      type: 'ward_indent_credit_note_review',
      data: const {
        'deep_link': '/billing/credit-notes/42',
        'action_label_key': 'med03.credit_note.notification_action',
      },
    );

    expect(item.actionRoute, '/billing/credit-notes/42');
    for (final locale in const ['en', 'hi', 'ta', 'te', 'ml']) {
      final strings = AppStrings.forLocale(Locale(locale));
      expect(
        item.actionLabelFor(strings),
        strings.lookup('med03.credit_note.notification_action'),
      );
    }

    final unsafe = NotificationItem(
      title: 'Credit note review',
      body: 'Review required',
      timestamp: DateTime.utc(2026, 8, 27),
      type: 'ward_indent_credit_note_review',
      data: const {
        'deep_link': 'https://example.test/billing/credit-notes/42',
        'action_label_key': 'med03.credit_note.notification_action',
      },
    );
    expect(unsafe.actionRoute, isNull);
  });
}
