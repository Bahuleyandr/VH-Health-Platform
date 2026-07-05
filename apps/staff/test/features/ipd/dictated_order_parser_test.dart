import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/ipd/dictated_order_parser.dart';

void main() {
  const parser = DictatedOrderParser();

  DictatedOrderParseResult parse(String text) => parser.parse(text);

  test('parses simple BD oral tablet order', () {
    final result = parse('paracetamol 650 milligrams oral twice daily');
    expect(result.drugQuery, 'paracetamol');
    expect(result.dose, '650 mg');
    expect(result.route, 'oral');
    expect(result.doseTimes, ['08:00', '20:00']);
  });

  test('parses common BD speech form', () {
    final result = parse('pantoprazole 40 mg by mouth two times a day');
    expect(result.drugQuery, 'pantoprazole');
    expect(result.route, 'oral');
    expect(result.doseTimes, ['08:00', '20:00']);
  });

  test('parses OD speech form', () {
    final result = parse('atorvastatin 10 mg once daily');
    expect(result.doseTimes, ['08:00']);
  });

  test('parses TDS speech form', () {
    final result = parse('ondansetron 4 mg three times daily');
    expect(result.doseTimes, ['08:00', '14:00', '20:00']);
  });

  test('parses QID abbreviation', () {
    final result = parse('sucralfate 1 g qid');
    expect(result.doseTimes, ['08:00', '14:00', '20:00', '22:00']);
  });

  test('parses explicit dose slots', () {
    final result = parse('insulin regular 6 units morning night');
    expect(result.dose, '6 units');
    expect(result.doseTimes, ['08:00', '22:00']);
  });

  test('parses IV route', () {
    final result = parse('ceftriaxone 1 gram intravenous OD');
    expect(result.route, 'iv');
    expect(result.dose, '1 g');
  });

  test('parses IM route', () {
    final result = parse('diclofenac 75 mg im sos');
    expect(result.route, 'im');
    expect(result.prn, isTrue);
    expect(result.foodTiming, 'prn');
  });

  test('parses subcutaneous route', () {
    final result = parse('enoxaparin 40 mg subcutaneous daily');
    expect(result.route, 'sc');
  });

  test('parses inhaled route', () {
    final result = parse('salbutamol 2 puffs inhaled qid');
    expect(result.route, 'inhaled');
    expect(result.doseTimes.length, 4);
  });

  test('parses topical route', () {
    final result = parse('mupirocin topical twice daily');
    expect(result.route, 'topical');
    expect(result.dose, '');
  });

  test('parses PRN phrase', () {
    final result = parse('tramadol 50 mg as needed for pain');
    expect(result.prn, isTrue);
    expect(result.foodTiming, 'prn');
    expect(result.notes, 'pain');
  });

  test('parses after food timing', () {
    final result = parse('metformin 500 mg after food BD');
    expect(result.foodTiming, 'after_food');
  });

  test('parses before food timing', () {
    final result = parse('thyroxine 50 mcg empty stomach OD');
    expect(result.foodTiming, 'empty_stomach');
  });

  test('parses duration days', () {
    final result = parse('amoxicillin clavulanate 625 mg BD for 5 days');
    expect(result.drugQuery, 'amoxicillin clavulanate');
    expect(result.durationDays, 5);
  });

  test('parses duration weeks as days', () {
    final result = parse('calcium 500 mg daily for two weeks');
    expect(result.durationDays, 14);
  });

  test('keeps leftover tokens as notes', () {
    final result = parse('ceftriaxone 1 g IV OD dilute in NS slow push');
    expect(result.notes, 'dilute in NS slow push');
  });

  test('parses combo drug leading span', () {
    final result = parse('piperacillin tazobactam 4.5 g iv tds');
    expect(result.drugQuery, 'piperacillin tazobactam');
    expect(result.dose, '4.5 g');
  });

  test('handles missing dose without inventing one', () {
    final result = parse('pantoprazole oral once daily');
    expect(result.drugQuery, 'pantoprazole');
    expect(result.dose, '');
    expect(result.route, 'oral');
  });

  test('removes command prefixes from drug query', () {
    final result = parse('start paracetamol 650 mg BD');
    expect(result.drugQuery, 'paracetamol');
  });

  test('parses Hindi twice daily', () {
    final result = parse('पैरासिटामोल 500 mg दिन में दो बार');
    expect(result.drugQuery, 'पैरासिटामोल');
    expect(result.doseTimes, ['08:00', '20:00']);
  });

  test('parses Hindi morning evening', () {
    final result = parse('पैंटोप्राजोल 40 mg सुबह शाम');
    expect(result.doseTimes, ['08:00', '20:00']);
  });

  test('parses Hindi PRN', () {
    final result = parse('ट्रामाडोल 50 mg जरूरत पर दर्द');
    expect(result.prn, isTrue);
    expect(result.notes, 'दर्द');
  });

  test('parses Hindi duration', () {
    final result = parse('सेफिक्सिम 200 mg दो बार तीन दिन');
    expect(result.durationDays, 3);
    expect(result.doseTimes, ['08:00', '20:00']);
  });

  test('garbage input fills only notes', () {
    final result = parse('please check once patient family asked');
    expect(result.drugQuery, '');
    expect(result.hasStructuredFields, isFalse);
    expect(result.notes, 'please check once patient family asked');
  });

  test('does not match frequency inside longer words', () {
    final result = parse('bday reminder no medicine');
    expect(result.hasStructuredFields, isFalse);
    expect(result.notes, 'bday reminder no medicine');
  });

  test('auto-selects a strong catalog match', () {
    final decision = DictatedOrderParser.chooseCatalogMatch('paracetamol', [
      const DictatedCatalogCandidate(
        label: 'Paracetamol 650 mg',
        row: {'id': 1},
      ),
      const DictatedCatalogCandidate(
        label: 'Pantoprazole 40 mg',
        row: {'id': 2},
      ),
    ]);
    expect(decision.autoSelected?.row['id'], 1);
  });

  test('does not auto-select ambiguous catalog names', () {
    final decision = DictatedOrderParser.chooseCatalogMatch('met', [
      const DictatedCatalogCandidate(label: 'Metformin 500 mg', row: {'id': 1}),
      const DictatedCatalogCandidate(label: 'Metoprolol 25 mg', row: {'id': 2}),
    ]);
    expect(decision.autoSelected, isNull);
    expect(decision.candidates, hasLength(2));
  });

  test('does not auto-select when same generic has multiple strengths', () {
    final decision = DictatedOrderParser.chooseCatalogMatch('paracetamol', [
      const DictatedCatalogCandidate(
        label: 'Paracetamol 500 mg',
        row: {'id': 1},
      ),
      const DictatedCatalogCandidate(
        label: 'Paracetamol 650 mg',
        row: {'id': 2},
      ),
    ]);
    expect(decision.autoSelected, isNull);
  });
}
