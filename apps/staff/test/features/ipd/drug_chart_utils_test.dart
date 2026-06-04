import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/ipd/utils/drug_chart_utils.dart';

void main() {
  group('deriveDoseFromDrug', () {
    test('extracts tablet and injection strengths from the selected drug', () {
      expect(deriveDoseFromDrug('Paracetamol 650 mg'), '650 mg');
      expect(deriveDoseFromDrug('Pantoprazole 40mg Injection'), '40 mg');
      expect(deriveDoseFromDrug('Ceftriaxone 1 g'), '1 g');
    });

    test('prefers the volume over saline concentration for IV fluids', () {
      expect(deriveDoseFromDrug('Normal Saline 0.9% 500ml'), '500 mL');
    });

    test('returns empty when no strength is present', () {
      expect(deriveDoseFromDrug('Insulin regular'), '');
    });
  });

  group('isAntibioticMedication', () {
    test('detects common antibiotic names and explicit catalog flags', () {
      expect(isAntibioticMedication('Ceftriaxone 1 g'), isTrue);
      expect(isAntibioticMedication('Amoxicillin-Clavulanate 625 mg'), isTrue);
      expect(
        isAntibioticMedication(
          'Meropenem',
          details: {'therapeutic_class': 'Antibiotic'},
        ),
        isTrue,
      );
    });

    test('does not mark routine non-antibiotic medicines', () {
      expect(isAntibioticMedication('Pantoprazole 40 mg'), isFalse);
    });
  });

  test('antibioticDay counts calendar days from start date', () {
    final started = DateTime(2026, 6, 1, 23, 30);
    final now = DateTime(2026, 6, 4, 8, 0);
    expect(antibioticDay(started, now: now), 4);
  });
}
