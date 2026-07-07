import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/dental/models/dental_models.dart';

void main() {
  group('FdiToothLayout', () {
    test('maps permanent teeth into upper and lower odontogram rows', () {
      final upperCentral = FdiToothLayout.positionFor('11');
      expect(upperCentral.row, 0);
      expect(upperCentral.column, 7);
      expect(upperCentral.deciduous, isFalse);
      expect(upperCentral.quadrant, '1');

      final lowerRightMolar = FdiToothLayout.positionFor('48');
      expect(lowerRightMolar.row, 1);
      expect(lowerRightMolar.column, 0);
      expect(lowerRightMolar.deciduous, isFalse);

      final lowerLeftCentral = FdiToothLayout.positionFor('31');
      expect(lowerLeftCentral.row, 1);
      expect(lowerLeftCentral.column, 8);
    });

    test('maps deciduous teeth into child rows', () {
      final upperRight = FdiToothLayout.positionFor('55');
      expect(upperRight.row, 2);
      expect(upperRight.column, 0);
      expect(upperRight.deciduous, isTrue);

      final lowerLeft = FdiToothLayout.positionFor('75');
      expect(lowerLeft.row, 3);
      expect(lowerLeft.column, 9);
      expect(lowerLeft.deciduous, isTrue);
    });

    test('accepts only FDI permanent and deciduous tooth ranges', () {
      expect(FdiToothLayout.isValid('11'), isTrue);
      expect(FdiToothLayout.isValid('48'), isTrue);
      expect(FdiToothLayout.isValid('51'), isTrue);
      expect(FdiToothLayout.isValid('85'), isTrue);
      expect(FdiToothLayout.isValid('19'), isFalse);
      expect(FdiToothLayout.isValid('56'), isFalse);
      expect(FdiToothLayout.isValid('86'), isFalse);
      expect(FdiToothLayout.isValid('AB'), isFalse);
      expect(FdiToothLayout.allTeeth, hasLength(52));
    });
  });
}
