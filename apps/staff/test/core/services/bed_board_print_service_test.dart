import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/bed_board_print_service.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const nativeContent = <String, ({String ward, String patient, String notes})>{
    'en': (
      ward: 'General Ward',
      patient: 'Asha Rao',
      notes: 'Observation continues',
    ),
    'hi': (
      ward: 'सामान्य वार्ड',
      patient: 'आशा शर्मा',
      notes: 'निगरानी जारी है',
    ),
    'ta': (
      ward: 'பொது வார்டு',
      patient: 'மீனா குமார்',
      notes: 'கண்காணிப்பு தொடர்கிறது',
    ),
    'te': (
      ward: 'సాధారణ వార్డు',
      patient: 'ఆశ కుమారి',
      notes: 'పర్యవేక్షణ కొనసాగుతోంది',
    ),
    'ml': (
      ward: 'പൊതു വാർഡ്',
      patient: 'ആശ നായർ',
      notes: 'നിരീക്ഷണം തുടരുന്നു',
    ),
  };

  for (final entry in nativeContent.entries) {
    testWidgets(
      'saves ${entry.key} bed-board PDF with native regular and bold text',
      (tester) async {
        final bytes = await BedBoardPrintService.buildPdf(
          wardName: entry.value.ward,
          beds: [
            {
              'bed_number': 'A-101',
              'status': 'occupied',
              'patient_full_name': entry.value.patient,
              'patient_age': 42,
              'admission_admitted_at': '2026-09-02T08:15:00Z',
              'notes': entry.value.notes,
            },
          ],
          strings: AppStrings.forLocale(Locale(entry.key)),
          generatedBy: entry.value.patient,
        );

        expect(utf8.decode(bytes.take(5).toList()), '%PDF-');
        expect(bytes.length, greaterThan(3000));
      },
    );
  }

  test('font fallbacks are bundled and never fetched at runtime', () {
    final source = File('lib/core/services/bed_board_print_service.dart')
        .readAsStringSync();
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final provenance = File('assets/fonts/noto/PROVENANCE.md')
        .readAsStringSync();

    expect(source, isNot(contains('PdfGoogleFonts')));
    expect(source, isNot(contains('http://')));
    expect(source, isNot(contains('https://')));
    expect(pubspec, contains('- assets/fonts/noto/'));
    expect(provenance, contains('SIL Open Font License 1.1'));
    expect(provenance, contains('no `fvar` table'));
  });
}
