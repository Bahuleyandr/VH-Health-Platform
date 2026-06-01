import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/hr/screens/staff_management_screen.dart';

void main() {
  group('staff department options', () {
    test('deduplicates blank and case-insensitive department values', () {
      expect(
        uniqueSortedStaffDepartments([
          ' ICU ',
          'icu',
          null,
          '',
          'Billing',
          ' billing ',
        ]),
        ['Billing', 'ICU'],
      );
    });

    test(
      'includes default, existing staff, and current custom departments',
      () {
        final options = buildStaffDepartmentOptions(
          existingDepartments: ['Dialysis', 'nursing', ' Dialysis '],
          currentValue: ' Endoscopy ',
        );

        expect(options, containsAll(['Admissions', 'Dialysis', 'Endoscopy']));
        expect(
          options.where((value) => value.toLowerCase() == 'dialysis'),
          hasLength(1),
        );
        expect(
          options.where((value) => value.toLowerCase() == 'nursing'),
          hasLength(1),
        );
      },
    );

    test('filters suggestions as the user types', () {
      final options = ['Admissions', 'Billing', 'Nursing', 'Radiology'];

      expect(filterStaffDepartmentOptions(options: options, query: '  nur '), [
        'Nursing',
      ]);
      expect(filterStaffDepartmentOptions(options: options, query: 'ing'), [
        'Billing',
        'Nursing',
      ]);
    });

    test('can show the full scrollable department list', () {
      final options = ['Admissions', 'Billing', 'Nursing'];

      expect(
        filterStaffDepartmentOptions(
          options: options,
          query: 'nur',
          showAllOptions: true,
        ),
        options,
      );
      expect(
        filterStaffDepartmentOptions(options: options, query: ''),
        options,
      );
    });
  });

  group('staff onboarding role options', () {
    test(
      'includes front-office, billing, clinical specialty, and safety roles',
      () {
        expect(
          staffOnboardingRoleValues(),
          containsAll([
            'ANESTHETIST',
            'RADIOLOGY_STAFF',
            'BILLING_STAFF',
            'BILLING_INCHARGE',
            'FINANCE_INCHARGE',
            'ADMISSION_OFFICER',
            'INSURANCE_COORDINATOR',
            'IPD_COUNSELLOR',
            'SECURITY',
            'EMERGENCY_RESPONDER',
          ]),
        );
      },
    );
  });
}
