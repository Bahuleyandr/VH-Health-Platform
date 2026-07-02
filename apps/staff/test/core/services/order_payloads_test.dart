import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/order_payloads.dart';

void main() {
  test('builds the canonical medication order body; omits null optionals', () {
    final body = buildInpatientMedicationOrderBody(
      patientUid: 'p-uid',
      encounterId: 'enc-1',
      medicationName: 'Paracetamol',
      dose: '500mg',
      route: 'oral',
      frequency: 'BD',
      doseTimes: ['morning', 'night'],
      startDate: DateTime.utc(2026, 6, 27, 9),
    );
    expect(body['patient_uid'], 'p-uid');
    expect(body['encounter_id'], 'enc-1');
    expect(body['order_type'], 'medication');
    expect(body['priority'], 'routine');
    expect(body['start_date'], '2026-06-27T09:00:00.000Z');
    final details = body['details'] as Map<String, dynamic>;
    expect(details['medication_name'], 'Paracetamol');
    expect(details['dose'], '500mg');
    expect(details['route'], 'oral');
    expect(details['frequency'], 'BD');
    expect(details['dose_times'], ['morning', 'night']);
    expect(details.containsKey('food_timing'), isFalse);
    expect(details.containsKey('instructions'), isFalse);
    expect(details.containsKey('duration_days'), isFalse);
  });

  test('omits encounter_id when null', () {
    final body = buildInpatientMedicationOrderBody(
      patientUid: 'p',
      encounterId: null,
      medicationName: 'X',
      dose: '1',
      route: 'oral',
      frequency: 'OD',
      startDate: DateTime.utc(2026),
    );
    expect(body.containsKey('encounter_id'), isFalse);
  });

  test(
    'carries catalog identity for server-derived composition enrichment',
    () {
      final body = buildInpatientMedicationOrderBody(
        patientUid: 'p',
        encounterId: null,
        medicationName: 'Clavam 625',
        dose: '1 tab',
        route: 'oral',
        frequency: 'BD',
        catalogId: 12,
        originalCatalogId: 10,
        compositionId: 3,
        compositionLabel: 'Amoxicillin + Clavulanic acid',
        compositionConfidence: 'high',
        genericName: 'Amoxicillin + Clavulanate',
        strength: '625 mg',
        strengthKey: '625mg',
        form: 'Tablet',
        formKey: 'tablet',
        releaseKey: 'ir',
        doNotSubstitute: true,
        startDate: DateTime.utc(2026),
      );

      final details = body['details'] as Map<String, dynamic>;
      expect(details['catalog_id'], 12);
      expect(details['original_catalog_id'], 10);
      expect(details['composition_id'], 3);
      expect(details['composition_label'], 'Amoxicillin + Clavulanic acid');
      expect(details['composition_confidence'], 'high');
      expect(details['generic_name'], 'Amoxicillin + Clavulanate');
      expect(details['strength'], '625 mg');
      expect(details['strength_key'], '625mg');
      expect(details['form'], 'Tablet');
      expect(details['form_key'], 'tablet');
      expect(details['release_key'], 'ir');
      expect(details['do_not_substitute'], isTrue);
    },
  );

  test('omits original_catalog_id when selected catalog was not swapped', () {
    final body = buildInpatientMedicationOrderBody(
      patientUid: 'p',
      encounterId: null,
      medicationName: 'Augmentin 625',
      dose: '1 tab',
      route: 'oral',
      frequency: 'BD',
      catalogId: 10,
      originalCatalogId: 10,
      startDate: DateTime.utc(2026),
    );

    final details = body['details'] as Map<String, dynamic>;
    expect(details['catalog_id'], 10);
    expect(details.containsKey('original_catalog_id'), isFalse);
  });
}
