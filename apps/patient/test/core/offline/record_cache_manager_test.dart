import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/offline/record_cache_manager.dart';

void main() {
  test('record manifest paths isolate tenant, patient profile, and filter', () {
    final all = RecordCacheManager.cachePath(
      patientUid: 'patient-1',
      filter: 'All',
      tenantNamespace: 'hospital-a',
    );
    final investigation = RecordCacheManager.cachePath(
      patientUid: 'patient-1',
      filter: 'Investigation',
      tenantNamespace: 'hospital-a',
    );
    final dependent = RecordCacheManager.cachePath(
      patientUid: 'dependent-1',
      filter: 'All',
      tenantNamespace: 'hospital-a',
    );
    final otherTenant = RecordCacheManager.cachePath(
      patientUid: 'patient-1',
      filter: 'All',
      tenantNamespace: 'hospital-b',
    );

    expect(<String?>{all, investigation, dependent, otherTenant}, hasLength(4));
    expect(all, contains('hospital-a_patient-1_all'));
    expect(investigation, contains('patient-1_investigation'));
  });

  test('empty patient uid fails closed', () {
    expect(
      RecordCacheManager.cachePath(
        patientUid: ' ',
        filter: 'All',
        tenantNamespace: 'hospital-a',
      ),
      isNull,
    );
  });
}
