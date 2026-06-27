import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/mar_five_rights.dart';

void main() {
  final pid = 'A1B2C3D4-0000-4000-8000-000000000001';
  Map<String, dynamic> dose({String name = 'Paracetamol', String? d = '500mg', String? route = 'oral', String? sched}) => {
        'id': 11,
        'patient_uid': pid,
        'medication_name': name,
        'dose': d,
        'route': route,
        'scheduled_time': sched ?? DateTime.now().toUtc().toIso8601String(),
        'status': 'scheduled',
      };

  test('all rights pass for a matching scan within window', () {
    final r = evaluateFiveRights(dose: dose(), scannedPatientUid: pid.toLowerCase(), scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc());
    expect(r.patient, isTrue);
    expect(r.drug, isTrue);
    expect(r.dose, isTrue);
    expect(r.route, isTrue);
    expect(r.time, isTrue);
    expect(r.allPassed, isTrue);
  });

  test('patient mismatch is a hard-stop (allPassed false)', () {
    final r = evaluateFiveRights(dose: dose(), scannedPatientUid: 'ffffffff-0000-4000-8000-000000000099', scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc());
    expect(r.patient, isFalse);
    expect(r.allPassed, isFalse);
  });

  test('drug name substring matches either direction', () {
    expect(evaluateFiveRights(dose: dose(name: 'Paracetamol 500'), scannedPatientUid: pid, scannedBarcode: 'paracetamol', at: DateTime.now().toUtc()).drug, isTrue);
    expect(evaluateFiveRights(dose: dose(name: 'Para'), scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc()).drug, isTrue);
    expect(evaluateFiveRights(dose: dose(name: 'Ibuprofen'), scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc()).drug, isFalse);
  });

  test('dose falls back to dosage; route presence; time window 60 min', () {
    expect(evaluateFiveRights(dose: {...dose(d: null), 'dosage': '500mg'}, scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc()).dose, isTrue);
    expect(evaluateFiveRights(dose: dose(route: null), scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: DateTime.now().toUtc()).route, isFalse);
    final sched = DateTime.now().toUtc();
    expect(evaluateFiveRights(dose: dose(sched: sched.toIso8601String()), scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: sched.add(const Duration(minutes: 90))).time, isFalse);
    expect(evaluateFiveRights(dose: dose(sched: sched.toIso8601String()), scannedPatientUid: pid, scannedBarcode: 'Paracetamol', at: sched.add(const Duration(minutes: 30))).time, isTrue);
  });
}
