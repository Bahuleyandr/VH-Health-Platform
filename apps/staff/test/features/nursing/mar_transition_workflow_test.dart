import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/nursing/screens/due_meds_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  const transitionKeys = <String>[
    'due_meds.actions.label',
    'due_meds.actions.miss',
    'due_meds.actions.hold',
    'due_meds.actions.release',
    'due_meds.actions.miss_title',
    'due_meds.actions.hold_title',
    'due_meds.actions.release_title',
    'due_meds.actions.miss_body',
    'due_meds.actions.hold_body',
    'due_meds.actions.release_body',
    'due_meds.actions.reason_label',
    'due_meds.actions.reason_hint',
    'due_meds.actions.reason_required',
    'due_meds.actions.cancel',
    'due_meds.actions.confirm_miss',
    'due_meds.actions.confirm_hold',
    'due_meds.actions.confirm_release',
    'due_meds.actions.miss_success',
    'due_meds.actions.hold_success',
    'due_meds.actions.release_success',
    'due_meds.held_review_state',
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
    expect(
      availableMarDueTransitions({
        'status': 'held',
        'clinical_order_status': 'ordered',
      }, canReleaseHold: true),
      const [MarDueTransition.releaseHold],
    );
  });

  test('prescriber exception queue exposes only evidence-backed closures', () {
    expect(
      availableMarDueTransitions({
        'status': 'missed',
        'exception_case_id': 73,
        'clinical_order_status': 'ordered',
      }, canReviewException: true),
      const [MarDueTransition.reviewException],
    );
    expect(
      availableMarDueTransitions(
        {
          'status': 'held',
          'exception_case_id': 73,
          'clinical_order_status': 'stopped',
        },
        canReleaseHold: true,
        canReviewException: true,
      ),
      const [MarDueTransition.reviewException],
    );
    expect(
      availableMarDueTransitions(
        {
          'status': 'held',
          'exception_case_id': 73,
          'clinical_order_status': 'verified',
        },
        canReleaseHold: true,
        canReviewException: true,
      ),
      const [MarDueTransition.releaseHold],
    );
    expect(
      availableMarDueTransitions({
        'status': 'missed',
        'clinical_order_status': 'verified',
      }, canReviewException: true),
      isEmpty,
    );
  });

  test('held doses never open administration, including for prescribers', () {
    expect(canOpenMarScanner({'status': 'scheduled'}), isTrue);
    expect(canOpenMarScanner({'status': 'held'}), isFalse);
    expect(canOpenMarScanner({'status': 'administered'}), isFalse);
  });

  test(
    'replacement picker admits only same-patient active post-exception orders',
    () {
      final raisedAt = DateTime.parse('2026-08-28T10:00:00Z');
      const patientUid = '11111111-1111-4111-8111-111111111111';
      Map<String, dynamic> order({
        required int id,
        String patient = patientUid,
        String type = 'medication',
        String status = 'ordered',
        String createdAt = '2026-08-28T10:05:00Z',
      }) => {
        'id': id,
        'patient_uid': patient,
        'order_type': type,
        'status': status,
        'created_at': createdAt,
        'order_number': 'ORDER-$id',
        'details': {'medication_name': 'Medicine $id'},
      };

      final candidates = eligibleMarReplacementOrders(
        orders: [
          order(id: 91),
          order(id: 90, createdAt: '2026-08-28T10:04:00Z'),
          order(id: 42),
          order(id: 92, patient: '22222222-2222-4222-8222-222222222222'),
          order(id: 93, type: 'investigation'),
          order(id: 94, status: 'cancelled'),
          order(id: 95, createdAt: '2026-08-28T09:59:59Z'),
          order(id: 96, createdAt: 'not-a-date'),
        ],
        patientUid: patientUid,
        originalClinicalOrderId: 42,
        raisedAt: raisedAt,
      );

      expect(candidates.map((row) => row['id']), [91, 90]);
      expect(
        marReplacementOrderLabel(candidates.first),
        'Medicine 91 · ORDER-91 · ordered',
      );
    },
  );

  test('hold release role policy exactly mirrors backend doctor tiers', () {
    for (final role in marHoldReleaseRoleCodes) {
      expect(canReleaseHeldMarDose(role), isTrue, reason: role);
    }
    for (final role in const [
      'ADMIN',
      'SUPER_ADMIN',
      'SENIOR_DOCTOR',
      'MEDICAL_SUPERINTENDENT',
      'NURSING_INCHARGE',
      null,
    ]) {
      expect(canReleaseHeldMarDose(role), isFalse, reason: '$role');
    }
  });

  test('MAR transition safety copy exists in all five locales', () {
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
