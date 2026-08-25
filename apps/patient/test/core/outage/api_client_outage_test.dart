import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/services/api_client.dart';

void main() {
  late PatientOutageController controller;

  setUp(() {
    controller = PatientOutageController.forTesting(
      request: () => throw StateError('readiness network must not be needed'),
      authentication: () async => 'patient-session',
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
    );
    controller.closeForTesting(PatientOutageReason.transportUnavailable);
    PatientOutageController.setForTesting(controller);
  });

  tearDown(() {
    PatientOutageController.resetAfterTesting();
    controller.dispose();
  });

  test('blocks a remote mutation before HTTP dispatch', () async {
    final blocked = controller.blockedMutations.first;

    final response = await ApiClient.post('/appointments', body: {'slot': 1});

    expect(response.isSuccess, isFalse);
    expect(response.code, 'PATIENT_OUTAGE_MUTATION_BLOCKED');
    expect((await blocked).path, '/appointments');
  });

  test('blocks every mutating wrapper before HTTP dispatch', () async {
    final responses = await Future.wait([
      ApiClient.post('/appointments', body: {'slot': 1}),
      ApiClient.put('/profile', body: {'name': 'Patient'}),
      ApiClient.patch('/notifications/7/read'),
      ApiClient.delete('/appointments/42'),
    ]);

    expect(
      responses.map((response) => response.code),
      everyElement('PATIENT_OUTAGE_MUTATION_BLOCKED'),
    );
  });

  test('does not evaluate multipart fileBuilder while blocked', () async {
    var fileBuilderCalls = 0;

    final response = await ApiClient.multipart(
      '/investigations/book',
      fileBuilder: () async {
        fileBuilderCalls++;
        return [];
      },
    );

    expect(response.code, 'PATIENT_OUTAGE_MUTATION_BLOCKED');
    expect(fileBuilderCalls, 0);
  });

  test('a cache-first read with nothing on disk invents no wording', () async {
    // The setUp controller is closed, so cachedGet takes its
    // offline-and-no-cache branch. ApiResponse.failureMessage prefers
    // `message` over the fallback it is handed, so any display string set
    // there would out-rank the localized string every screen passes and put
    // untranslated English in front of all five locales — which is exactly
    // what `appointments_list_tab.dart` did before this was fixed.
    const callerWording = 'the caller localized string';

    final response = await ApiClient.cachedGet('/appointments/patient/1');

    expect(response.isSuccess, isFalse);
    expect(response.code, 'NO_CONNECTION_NO_CACHE');
    expect(response.message, isNull);
    expect(response.failureMessage(callerWording), callerWording);
  });

  test('never loads a patient cache while signed out', () async {
    controller.dispose();
    controller = PatientOutageController.forTesting(
      request: () => throw StateError('network must not be used'),
      authentication: () async => null,
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
    );
    PatientOutageController.setForTesting(controller);

    final response = await ApiClient.cachedGet('/portal/clinical-notes');

    expect(response.isSuccess, isFalse);
    expect(response.response.statusCode, 401);
    expect(response.code, 'PATIENT_SIGNED_OUT_NO_CACHE');
  });
}
