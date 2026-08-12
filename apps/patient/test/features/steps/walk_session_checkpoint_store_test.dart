import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/steps/services/walk_session_checkpoint_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
  });

  test(
    'round-trips the active walk metrics and clears only explicitly',
    () async {
      final store = WalkSessionCheckpointStore();
      final checkpoint = WalkSessionCheckpoint(
        sessionId: 42,
        steps: 1234,
        distanceMeters: 987.6,
        durationSeconds: 456,
        savedAt: DateTime.utc(2026, 8, 12, 8, 30),
      );

      await store.save(checkpoint);
      final restored = await store.read();

      expect(restored?.sessionId, 42);
      expect(restored?.steps, 1234);
      expect(restored?.distanceMeters, 987.6);
      expect(restored?.durationSeconds, 456);
      expect(restored?.savedAt, checkpoint.savedAt);

      await store.clear();
      expect(await store.read(), isNull);
    },
  );

  test(
    'drops a corrupt checkpoint rather than inventing walk metrics',
    () async {
      FlutterSecureStorage.setMockInitialValues({
        WalkSessionCheckpointStore.storageKey: '{"sessionId":-1}',
      });
      final store = WalkSessionCheckpointStore();

      expect(await store.read(), isNull);
      expect(await store.read(), isNull);
    },
  );
}
