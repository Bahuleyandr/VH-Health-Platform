import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/clinical_local_draft_store.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';
import 'package:vhhealth_core/services/secure_blob.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    const channel = MethodChannel(
      'plugins.it_nomads.com/flutter_secure_storage',
    );
    final secureValues = <String, String>{};
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          final arguments = Map<String, dynamic>.from(call.arguments as Map);
          switch (call.method) {
            case 'read':
              return secureValues[arguments['key']];
            case 'write':
              secureValues[arguments['key'] as String] =
                  arguments['value'] as String;
              return null;
            case 'delete':
              secureValues.remove(arguments['key']);
              return null;
          }
          return null;
        });
  });

  test(
    'stores only encrypted bytes and explicitly reopens the draft',
    () async {
      final persistence = _MemoryPersistence();
      final store = ClinicalLocalDraftStore(
        persistence: persistence,
        codec: SecureBlobCodec('clinical_local_draft_test_key'),
      );
      final draft = _draft(
        id: 'rx:patient-1',
        payload: const {
          'medications': [
            {'drug': 'test medicine', 'dose': '5 mg'},
          ],
        },
      );

      await store.save(draft);

      final stored = persistence.values[draft.id]!;
      expect(stored, isNot(contains('test medicine')));
      expect(stored, isNot(contains('patient-1')));
      expect((await store.read(draft.id))!.payload, draft.payload);
    },
  );

  test('scopes listing to tenant, facility, device, and actor', () async {
    final store = ClinicalLocalDraftStore(
      persistence: _MemoryPersistence(),
      codec: SecureBlobCodec('clinical_local_draft_scope_test_key'),
    );
    await store.save(_draft(id: 'a'));
    await store.save(_draft(id: 'b', actorId: 'other-actor'));

    final visible = await store.list(
      tenantId: 'tenant-1',
      facilityId: 41,
      deviceId: 'device-1',
      actorId: 'actor-1',
    );

    expect(visible.map((draft) => draft.id), ['a']);
  });

  test('rejects queue, physical-action, and unknown action IDs', () async {
    final store = ClinicalLocalDraftStore(
      persistence: _MemoryPersistence(),
      codec: SecureBlobCodec('clinical_local_draft_reject_test_key'),
    );

    for (final actionId in [
      OfflineActionIds.nursingNoteDraftStore,
      OfflineActionIds.vitalsCapture,
      OfflineActionIds.marAdministrationBackfill,
      OfflineActionIds.unknown,
    ]) {
      expect(
        () => store.save(_draft(id: actionId, actionId: actionId)),
        throwsA(isA<FormatException>()),
      );
    }
  });

  test('delete removes the encrypted record and index entry', () async {
    final persistence = _MemoryPersistence();
    final store = ClinicalLocalDraftStore(
      persistence: persistence,
      codec: SecureBlobCodec('clinical_local_draft_delete_test_key'),
    );
    await store.save(_draft(id: 'delete-me'));

    await store.delete('delete-me');

    expect(await store.read('delete-me'), isNull);
    expect(persistence.ids, isEmpty);
  });
}

ClinicalLocalDraft _draft({
  required String id,
  String actionId = OfflineActionIds.opPrescriptionDraft,
  String actorId = 'actor-1',
  Map<String, Object?> payload = const {'draft': true},
}) {
  final createdAt = DateTime.utc(2026, 7, 31, 12);
  return ClinicalLocalDraft(
    id: id,
    actionId: actionId,
    tenantId: 'tenant-1',
    facilityId: 41,
    deviceId: 'device-1',
    actorId: actorId,
    role: 'DOCTOR',
    patientReference: 'patient-1',
    payload: payload,
    createdAt: createdAt,
    updatedAt: createdAt,
  );
}

class _MemoryPersistence implements ClinicalLocalDraftPersistence {
  final values = <String, String>{};
  List<String> ids = [];

  @override
  Future<void> delete(String id) async => values.remove(id);

  @override
  Future<String?> read(String id) async => values[id];

  @override
  Future<List<String>> readIds() async => List.of(ids);

  @override
  Future<void> write(String id, String value) async => values[id] = value;

  @override
  Future<void> writeIds(List<String> ids) async => this.ids = List.of(ids);
}
