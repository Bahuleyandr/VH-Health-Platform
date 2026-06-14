// test/features/reception/walk_in_registration_test.dart
//
// Tests for the walk-in registration workflow's validation helpers and
// payload-building logic, covering:
//
//   1. Mirror-class tests for private helpers from `reception_counter_screen.dart`
//      (_isEmergencyWard, _wardLabel, _doctorLabel, _digitsOnly, _bedLabel) —
//      these are library-private and cannot be imported directly.
//   2. Direct import tests for `frontOfficeWalkInRegistrationPayload` from
//      `front_office_workbench_screen.dart` (public top-level function).
//
// Clinical-safety invariants under test:
//   1. OPD booking requires a valid patient identifier (10-digit phone or
//      a selected patient), a doctor, and a non-empty reason.
//   2. Emergency ward detection must trigger priority escalation so an ICU
//      or ER admission doesn't accidentally default to "Routine" priority.
//   3. Walk-in registration payload serialises visit_type in UPPERCASE so
//      the backend validator (which enforces the enum) never receives a
//      mis-cased value.
//   4. Blank/whitespace-only optional fields must be stripped from the
//      payload (no empty strings sent to the backend).
//   5. MLC, TPA, allergies, and chronic medication intake fields are
//      forwarded correctly from the walk-in registration form.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/reception/screens/front_office_workbench_screen.dart';

// ── Mirror helpers from reception_counter_screen.dart ────────────────────────
// These are library-private (`_`-prefixed) top-level functions in that file.
// The mirrors below must stay in sync with the production implementation.

/// Mirrors `_isEmergencyWard` from reception_counter_screen.dart.
/// Determines whether the selected ward label should auto-escalate the
/// admission priority to "Emergency".
bool isEmergencyWardLabel(String label) {
  final lower = label.toLowerCase();
  return lower.contains('icu') ||
      lower == 'er' ||
      lower.contains(' emergency') ||
      lower.startsWith('emergency');
}

/// Mirrors `_wardLabel` from reception_counter_screen.dart.
/// Resolves a ward display name from API data: prefers `label`, falls back
/// to `name`, then "Ward".
String wardLabel(Map<String, dynamic> ward) {
  final label = (ward['label']?.toString() ?? '').trim();
  if (label.isNotEmpty) return label;
  final name = (ward['name']?.toString() ?? '').trim();
  if (name.isNotEmpty) return name;
  return 'Ward';
}

/// Mirrors `_doctorLabel` from reception_counter_screen.dart.
/// Formats "Name - Department - Specialization" (omitting absent fields).
String doctorLabel(Map<String, dynamic> doctor) {
  int? resolvedId = int.tryParse(
    (doctor['user_id'] ?? doctor['userId'] ?? doctor['id'])?.toString() ?? '',
  );
  final name =
      doctor['name']?.toString() ??
      (resolvedId == null ? 'Doctor' : 'Doctor #$resolvedId');
  final department = doctor['department']?.toString() ?? '';
  final specialization = doctor['specialization']?.toString() ?? '';
  return [
    name,
    if (department.isNotEmpty) department,
    if (specialization.isNotEmpty) specialization,
  ].join(' - ');
}

/// Mirrors `_digitsOnly` from reception_counter_screen.dart.
/// Strips all non-digit characters from a phone number.
String digitsOnlyFromPhone(String value) => value.replaceAll(RegExp(r'\D'), '');

/// Mirrors `_bedLabel` from reception_counter_screen.dart.
/// Formats a bed's display name from API data.
String bedLabel(Map<String, dynamic> bed) {
  String text(dynamic v) => v?.toString().trim() ?? '';
  final number = text(bed['bed_number']);
  final type = text(bed['bed_type']).replaceAll('_', ' ');
  if (number.isEmpty) return type.isEmpty ? 'Bed' : type;
  if (type.isEmpty || type == 'unclassified') return number;
  return '$number - $type';
}

// ─────────────────────────────────────────────────────────────────────────────

void main() {
  // ── isEmergencyWardLabel ───────────────────────────────────────────────────
  group('isEmergencyWardLabel (ward priority auto-escalation)', () {
    test(
      'ward labels containing the substring "icu" trigger emergency priority',
      () {
        // The check is `lower.contains('icu')` — so "ICU North" and "NICU" match
        // because they contain the substring 'icu'. "Intensive Care Unit" does NOT
        // contain 'icu' as a substring and correctly returns false.
        expect(isEmergencyWardLabel('ICU North'), isTrue);
        expect(isEmergencyWardLabel('NICU'), isTrue);
        expect(isEmergencyWardLabel('icu'), isTrue);
        // "Intensive Care Unit" spelled out does NOT contain 'icu' as a substring.
        expect(isEmergencyWardLabel('Intensive Care Unit'), isFalse);
      },
    );

    test('"er" exact match (case-insensitive) triggers emergency priority', () {
      expect(isEmergencyWardLabel('ER'), isTrue);
      expect(isEmergencyWardLabel('er'), isTrue);
    });

    test(
      'ward label containing " emergency" (mid-string) triggers emergency',
      () {
        expect(isEmergencyWardLabel('Paediatric Emergency'), isTrue);
        expect(isEmergencyWardLabel('Medical Emergency Unit'), isTrue);
      },
    );

    test('ward label starting with "emergency" triggers emergency', () {
      expect(isEmergencyWardLabel('Emergency Department'), isTrue);
      expect(isEmergencyWardLabel('Emergency Ward'), isTrue);
      expect(isEmergencyWardLabel('EMERGENCY'), isTrue);
    });

    test('ordinary wards do NOT trigger emergency priority', () {
      expect(isEmergencyWardLabel('General Medicine 2'), isFalse);
      expect(isEmergencyWardLabel('Maternity Ward'), isFalse);
      expect(isEmergencyWardLabel('Geriatric Ward'), isFalse);
      expect(isEmergencyWardLabel('Post-op Recovery'), isFalse);
    });

    test('empty ward label is not an emergency ward', () {
      expect(isEmergencyWardLabel(''), isFalse);
    });

    test(
      '"er" appears mid-string but does NOT trigger (only exact-match and prefix rules)',
      () {
        // "General" contains "er" but the match is:
        //   (a) lower == 'er', or (b) startsWith 'emergency', or (c) contains ' emergency'
        // "general" does not satisfy any of these.
        expect(isEmergencyWardLabel('General Ward'), isFalse);
      },
    );
  });

  // ── wardLabel ──────────────────────────────────────────────────────────────
  group('wardLabel (IP admission ward display name resolution)', () {
    test('uses label field when non-empty', () {
      expect(wardLabel({'label': 'ICU', 'name': 'Intensive Care Unit'}), 'ICU');
    });

    test('falls back to name when label is absent', () {
      expect(wardLabel({'name': 'General Medicine'}), 'General Medicine');
    });

    test('returns "Ward" when both label and name are absent', () {
      expect(wardLabel({'id': 7}), 'Ward');
    });

    test('ignores whitespace-only label and falls back to name', () {
      expect(wardLabel({'label': '   ', 'name': 'Cardiology'}), 'Cardiology');
    });

    test('trims whitespace from the resolved label', () {
      expect(wardLabel({'label': '  ICU North  '}), 'ICU North');
    });
  });

  // ── doctorLabel ────────────────────────────────────────────────────────────
  group('doctorLabel (doctor display string for autocomplete and booking)', () {
    test('formats "name - department" when department is present', () {
      expect(
        doctorLabel({'id': 5, 'name': 'Dr. Priya', 'department': 'Cardiology'}),
        'Dr. Priya - Cardiology',
      );
    });

    test('includes specialization suffix when present', () {
      expect(
        doctorLabel({
          'id': 6,
          'name': 'Dr. Rajan',
          'specialization': 'Interventional Cardiology',
        }),
        'Dr. Rajan - Interventional Cardiology',
      );
    });

    test('includes both department and specialization when both present', () {
      expect(
        doctorLabel({
          'id': 7,
          'name': 'Dr. Meena',
          'department': 'Neurology',
          'specialization': 'Neuro-oncology',
        }),
        'Dr. Meena - Neurology - Neuro-oncology',
      );
    });

    test('uses just name when no department or specialization', () {
      expect(doctorLabel({'id': 7, 'name': 'Dr. Meena'}), 'Dr. Meena');
    });

    test(
      'falls back to "Doctor #id" when name is absent but id is present',
      () {
        final label = doctorLabel({'id': 8});
        expect(label, 'Doctor #8');
      },
    );

    test('falls back to "Doctor" when neither name nor id', () {
      expect(doctorLabel({}), 'Doctor');
    });

    test('accepts user_id as the integer id source', () {
      final label = doctorLabel({'user_id': '9', 'name': 'Dr. Rao'});
      expect(label, 'Dr. Rao');
    });
  });

  // ── digitsOnlyFromPhone ────────────────────────────────────────────────────
  group('digitsOnlyFromPhone (phone normalisation and OPD booking gate)', () {
    test('strips spaces, hyphens, parentheses, and country code prefix', () {
      expect(digitsOnlyFromPhone('+91 98765 43210'), '919876543210');
      expect(digitsOnlyFromPhone('(044) 2345-6789'), '04423456789');
    });

    test('leaves pure digit strings unchanged', () {
      expect(digitsOnlyFromPhone('9876543210'), '9876543210');
    });

    test('empty input returns empty string', () {
      expect(digitsOnlyFromPhone(''), '');
    });

    // OPD booking validation: `_digitsOnly(phone).length < 10` gates submission.
    test('phone with >= 10 digits passes the OPD booking gate', () {
      expect(digitsOnlyFromPhone('9876543210').length >= 10, isTrue);
      expect(digitsOnlyFromPhone('+91 9876543210').length >= 10, isTrue);
    });

    test('phone with fewer than 10 digits fails the OPD booking gate', () {
      expect(digitsOnlyFromPhone('98765432').length < 10, isTrue);
      expect(digitsOnlyFromPhone('123').length < 10, isTrue);
    });
  });

  // ── bedLabel ───────────────────────────────────────────────────────────────
  group('bedLabel (IP admission bed display name)', () {
    test('formats "number - type" when both are present', () {
      expect(
        bedLabel({'bed_number': 'B-12', 'bed_type': 'general_ward'}),
        'B-12 - general ward',
      );
    });

    test('underscores in bed_type are replaced with spaces', () {
      expect(
        bedLabel({'bed_number': 'C-1', 'bed_type': 'post_op_care'}),
        'C-1 - post op care',
      );
    });

    test('uses just bed number when type is "unclassified"', () {
      expect(
        bedLabel({'bed_number': 'B-7', 'bed_type': 'unclassified'}),
        'B-7',
      );
    });

    test('uses just type when bed number is absent', () {
      expect(bedLabel({'bed_type': 'icu'}), 'icu');
    });

    test('returns "Bed" when both fields are absent', () {
      expect(bedLabel({'id': 3}), 'Bed');
    });
  });

  // ── frontOfficeWalkInRegistrationPayload ──────────────────────────────────
  group(
    'frontOfficeWalkInRegistrationPayload (walk-in registration contract)',
    () {
      final basePatient = {
        'id': 10,
        'name': 'Arun Kumar',
        'phone': '9123456780',
      };
      final baseDoctor = {'id': 3, 'name': 'Dr. Sundaram', 'department': 'ENT'};

      test(
        'visit_type is serialised in UPPERCASE for backend enum validation',
        () {
          final payload = frontOfficeWalkInRegistrationPayload(
            patient: basePatient,
            doctor: baseDoctor,
            reason: 'Routine follow-up visit',
            visitType: 'routine',
          );
          expect(
            payload['visit_type'],
            'ROUTINE',
            reason: 'Backend enum validator requires uppercase visit_type',
          );
        },
      );

      test('emergency visit type is uppercased', () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: basePatient,
          doctor: baseDoctor,
          reason: 'Chest pain with diaphoresis',
          visitType: 'emergency',
        );
        expect(payload['visit_type'], 'EMERGENCY');
      });

      test('whitespace-only notes field is stripped from payload', () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: basePatient,
          doctor: baseDoctor,
          reason: 'Knee pain',
          visitType: 'routine',
          notes: '    ',
        );
        expect(
          payload.containsKey('notes'),
          isFalse,
          reason:
              'Blank notes must not be sent — backend may reject empty strings',
        );
      });

      test('whitespace-only insurer name is stripped from payload', () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: basePatient,
          doctor: baseDoctor,
          reason: 'Lab results discussion',
          visitType: 'routine',
          insurerName: '   ',
        );
        expect(payload.containsKey('insurer_name'), isFalse);
      });

      test('reason is trimmed before serialisation', () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: basePatient,
          doctor: baseDoctor,
          reason: '  Cough and cold  ',
          visitType: 'routine',
        );
        expect(payload['reason'], 'Cough and cold');
        expect(payload['chief_complaint'], 'Cough and cold');
      });

      test('patient_id is carried from selected patient', () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: {'id': 42, 'name': 'Test Patient', 'phone': '9876543210'},
          reason: 'Blood pressure review',
          visitType: 'routine',
        );
        expect(payload['patient_id'], 42);
      });

      test('lab-only walk-in without a doctor has null doctor_id', () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: {'phone': '9000000001', 'name': 'Lab Only Patient'},
          reason: 'CBC and LFT panel',
          visitType: 'lab_only',
          department: 'Laboratory',
        );
        expect(payload['doctor_id'], isNull);
        expect(payload['visit_type'], 'LAB_ONLY');
        expect(payload['department'], 'Laboratory');
      });

      test('appointment_time is always "Walk-in" (no slot booking)', () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: basePatient,
          doctor: baseDoctor,
          reason: 'Routine check',
          visitType: 'routine',
        );
        expect(payload['appointment_time'], 'Walk-in');
      });

      test('MLC flag and required fields are included when mlc=true', () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: basePatient,
          doctor: baseDoctor,
          reason: 'Road traffic accident',
          visitType: 'emergency',
          mlc: true,
          mlcNumber: 'MLC-2026-001',
          mlcNotes: 'Police intimation done — constable present',
        );
        expect(payload['mlc'], isTrue);
        expect(payload['mlc_number'], 'MLC-2026-001');
        expect(
          payload['mlc_notes'],
          'Police intimation done — constable present',
        );
      });

      test('TPA payer details are included when patientCategory is tpa', () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: basePatient,
          doctor: baseDoctor,
          reason: 'Post-surgery follow-up',
          visitType: 'routine',
          patientCategory: 'tpa',
          payerType: 'tpa',
          insurerName: 'Star Health',
          policyNumber: 'SH-123456',
        );
        expect(payload['payer_type'], 'tpa');
        expect(payload['insurer_name'], 'Star Health');
        expect(payload['policy_number'], 'SH-123456');
      });

      test('allergies and chronic medications intake fields are forwarded', () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: basePatient,
          doctor: baseDoctor,
          reason: 'Diabetes management review',
          visitType: 'routine',
          allergies: 'Penicillin, Sulfa drugs',
          chronicMedications: 'Metformin 1g BD, Atorvastatin 20mg HS',
        );
        expect(payload['allergies'], 'Penicillin, Sulfa drugs');
        expect(
          payload['chronic_medications'],
          'Metformin 1g BD, Atorvastatin 20mg HS',
        );
      });
    },
  );
}
