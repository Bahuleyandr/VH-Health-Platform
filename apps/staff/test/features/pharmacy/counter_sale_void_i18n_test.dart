import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/pharmacy/screens/counter_sale_screen.dart';
import 'package:vhhealth_staff/features/reception/screens/counter_sale_refund_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  const counterSaleKeys = <String>[
    's4.lib.counter_sale.payment_reference_required',
    's4.lib.counter_sale.legacy_payment_reference_missing',
    's4.lib.counter_sale.status.void_pending_refund',
    's4.lib.counter_sale.workflow_status.not_requested',
    's4.lib.counter_sale.workflow_status.awaiting_finance_approval',
    's4.lib.counter_sale.workflow_status.awaiting_finance_payout',
    's4.lib.counter_sale.workflow_status.awaiting_gateway_payout',
    's4.lib.counter_sale.workflow_status.awaiting_gateway_evidence',
    's4.lib.counter_sale.workflow_status.awaiting_payout_evidence',
    's4.lib.counter_sale.workflow_status.ready_to_reconcile',
    's4.lib.counter_sale.workflow_status.refund_rejected',
    's4.lib.counter_sale.workflow_status.refund_rejected_review',
    's4.lib.counter_sale.workflow_status.voided',
    's4.lib.counter_sale.workflow_status.cancelled_handover_confirmed',
    's4.lib.counter_sale.workflow_status.pending_review',
    's4.lib.counter_sale.workflow_status.unknown',
    's4.lib.counter_sale.void_readiness.ready',
    's4.lib.counter_sale.void_readiness.original_payment_reference_missing',
    's4.lib.counter_sale.void_readiness.outside_same_day_window',
    's4.lib.counter_sale.void_readiness.pending_refund',
    's4.lib.counter_sale.void_readiness.voided',
    's4.lib.counter_sale.void_readiness.not_completed',
    's4.lib.counter_sale.void_readiness.unknown',
    's4.lib.counter_sale.retry_sale',
    's4.lib.counter_sale.sale_response_unconfirmed',
    's4.lib.counter_sale.sale_changed_title',
    's4.lib.counter_sale.sale_changed_body',
    's4.lib.counter_sale.new_attempt_confirm',
    's4.lib.counter_sale.void_nonterminal_hint',
    's4.lib.counter_sale.void_disposition',
    's4.lib.counter_sale.disposition.never_handed_over',
    's4.lib.counter_sale.disposition.patient_returned',
    's4.lib.counter_sale.disposition_required_hint',
    's4.lib.counter_sale.never_handed_over_restock',
    's4.lib.counter_sale.patient_returned_quarantine',
    's4.lib.counter_sale.patient_returned_blocked',
    's4.lib.counter_sale.void_changed_title',
    's4.lib.counter_sale.void_changed_body',
    's4.lib.counter_sale.retry_void',
    's4.lib.counter_sale.void_response_unconfirmed',
    's4.lib.counter_sale.void_pending_refund',
    's4.lib.counter_sale.void_reconciled',
    's4.lib.counter_sale.restock_pending_evidence',
    's4.lib.counter_sale.open_finance_workflow',
    's4.lib.counter_sale.open_reconciliation',
    's4.lib.counter_sale.reconcile_action',
    's4.lib.counter_sale.reconcile_still_pending',
    's4.lib.counter_sale.reconcile_response_unconfirmed',
    's4.lib.counter_sale.handover_resolution_title',
    's4.lib.counter_sale.handover_resolution_warning',
    's4.lib.counter_sale.handover_resolution_reason',
    's4.lib.counter_sale.handover_resolution_confirm',
    's4.lib.counter_sale.handover_resolution_changed_title',
    's4.lib.counter_sale.handover_resolution_changed_body',
    's4.lib.counter_sale.handover_resolution_action',
    's4.lib.counter_sale.handover_resolution_retry',
    's4.lib.counter_sale.handover_resolution_completed',
    's4.lib.counter_sale.handover_resolution_response_unconfirmed',
  ];

  const financeKeys = <String>[
    'med03.counter_sale_refund.title',
    'med03.counter_sale_refund.access_denied',
    'med03.counter_sale_refund.invalid_target',
    'med03.counter_sale_refund.target_mismatch',
    'med03.counter_sale_refund.load_failed',
    'med03.counter_sale_refund.summary',
    'med03.counter_sale_refund.reconciliation_status',
    'med03.counter_sale_refund.open_reconciliation',
    'med03.counter_sale_refund.approval_ready',
    'med03.counter_sale_refund.approval_waiting',
    'med03.counter_sale_refund.approve_action',
    'med03.counter_sale_refund.confirm_title',
    'med03.counter_sale_refund.approve_confirm',
    'med03.counter_sale_refund.manual_confirm',
    'med03.counter_sale_refund.offline_electronic_confirm',
    'med03.counter_sale_refund.gateway_confirm',
    'med03.counter_sale_refund.action_confirmed',
    'med03.counter_sale_refund.action_failed',
    'med03.counter_sale_refund.action_response_unconfirmed',
    'med03.counter_sale_refund.retry_same_attempt',
    'med03.counter_sale_refund.changed_attempt_title',
    'med03.counter_sale_refund.changed_attempt_body',
    'med03.counter_sale_refund.changed_attempt_confirm',
    'med03.counter_sale_refund.payer_must_differ',
    'med03.counter_sale_refund.payout_not_authorized',
    'med03.counter_sale_refund.payout_in_progress',
    'med03.counter_sale_refund.no_authoritative_rail',
    'med03.counter_sale_refund.rail_conflict',
    'med03.counter_sale_refund.cash_drawer',
    'med03.counter_sale_refund.cash_voucher',
    'med03.counter_sale_refund.manual_reference',
    'med03.counter_sale_refund.drawer_identity_missing',
    'med03.counter_sale_refund.drawer_load_failed',
    'med03.counter_sale_refund.no_open_drawer',
    'med03.counter_sale_refund.cash_drawer_error',
    'med03.counter_sale_refund.original_reference_missing',
    'med03.counter_sale_refund.record_offline_electronic',
    'med03.counter_sale_refund.electronic_evidence_error',
    'med03.counter_sale_refund.provider_evidence_error',
    'med03.counter_sale_refund.load_gateway_candidates',
    'med03.counter_sale_refund.gateway_candidates_failed',
    'med03.counter_sale_refund.no_gateway_candidates',
    'med03.counter_sale_refund.start_gateway_refund',
    'med03.counter_sale_refund.rail.manual',
    'med03.counter_sale_refund.rail.offline_electronic',
    'med03.counter_sale_refund.rail.gateway',
    'med03.counter_sale_refund.rail.unknown',
    'med03.counter_sale_refund.workflow.awaiting_approval',
    'med03.counter_sale_refund.workflow.ready_for_payout',
    'med03.counter_sale_refund.workflow.paid',
    'med03.counter_sale_refund.workflow.rejected',
    'med03.counter_sale_refund.workflow.refund_rejected_review',
    'med03.counter_sale_refund.workflow.reconciliation_required',
    'med03.counter_sale_refund.workflow.counter_sale_void_completed',
    'med03.counter_sale_refund.workflow.unknown',
  ];

  test('counter-sale void and finance keys ship in all five locales', () {
    final english = AppStrings.forLocale(const Locale('en'));
    for (final locale in const ['hi', 'ta', 'te', 'ml']) {
      final localized = AppStrings.forLocale(Locale(locale));
      for (final key in [...counterSaleKeys, ...financeKeys]) {
        expect(localized.lookup(key), isNot(key), reason: '$locale $key');
        expect(
          localized.lookup(key),
          isNot(english.lookup(key)),
          reason: '$locale must not fall back to English for $key',
        );
      }
    }
  });

  test('every authoritative counter-sale workflow code is localized', () {
    final strings = AppStrings.forLocale(const Locale('en'));
    const codes = <String, String>{
      'NOT_REQUESTED': 'not_requested',
      'AWAITING_FINANCE_APPROVAL': 'awaiting_finance_approval',
      'AWAITING_FINANCE_PAYOUT': 'awaiting_finance_payout',
      'AWAITING_GATEWAY_PAYOUT': 'awaiting_gateway_payout',
      'AWAITING_GATEWAY_EVIDENCE': 'awaiting_gateway_evidence',
      'AWAITING_PAYOUT_EVIDENCE': 'awaiting_payout_evidence',
      'READY_TO_RECONCILE': 'ready_to_reconcile',
      'REFUND_REJECTED_REVIEW': 'refund_rejected_review',
      'VOIDED': 'voided',
      'CANCELLED_HANDOVER_CONFIRMED': 'cancelled_handover_confirmed',
      'PENDING_REVIEW': 'pending_review',
    };

    for (final entry in codes.entries) {
      expect(
        localizedCounterSaleVoidWorkflowStatus(strings, entry.key),
        strings.lookup('s4.lib.counter_sale.workflow_status.${entry.value}'),
        reason: entry.key,
      );
    }
    expect(
      localizedCounterSaleVoidWorkflowStatus(strings, 'UNSUPPORTED'),
      strings.lookup('s4.lib.counter_sale.workflow_status.unknown'),
    );
  });

  test('finance statuses and payout rails never expose raw enums', () {
    final strings = AppStrings.forLocale(const Locale('en'));
    for (final code in const [
      'awaiting_approval',
      'ready_for_payout',
      'paid',
      'rejected',
      'refund_rejected_review',
      'reconciliation_required',
      'counter_sale_void_completed',
    ]) {
      expect(
        localizedCounterSaleRefundWorkflow(strings, code),
        strings.lookup('med03.counter_sale_refund.workflow.$code'),
      );
    }
    for (final code in const ['manual', 'offline_electronic', 'gateway']) {
      expect(
        localizedCounterSaleRefundRail(strings, code),
        strings.lookup('med03.counter_sale_refund.rail.$code'),
      );
    }
    expect(
      localizedCounterSaleVoidRequestStatus(strings, 'PENDING_REFUND'),
      strings.lookup('s4.lib.counter_sale.status.void_pending_refund'),
    );
    expect(
      localizedCounterSaleVoidRequestStatus(
        strings,
        'CANCELLED_HANDOVER_CONFIRMED',
      ),
      strings.lookup(
        's4.lib.counter_sale.workflow_status.cancelled_handover_confirmed',
      ),
    );
  });
}
