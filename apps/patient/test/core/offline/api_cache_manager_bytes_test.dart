// test/core/offline/api_cache_manager_bytes_test.dart
//
// Unit tests for ApiCacheManager.encryptBytes / decryptBytes — the at-rest
// encryption that CacheFileUtils and DocumentOpener reuse for downloaded PHI
// documents. Uses an in-memory fake for the flutter_secure_storage channel so
// the per-device AES key (`cache_aes_key`) can be created/read without the
// native plugin.

import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';

class _SecureStorageFake {
  final Map<String, String> store = {};
  final Completer<void> allowReads = Completer<void>();
  bool delayReads = false;
  bool failKeyDelete = false;
  int keyReads = 0;
  int keyWrites = 0;
}

void _installSecureStorageFake(_SecureStorageFake fake) {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            if (args['key'] == 'cache_aes_key') {
              fake.keyReads += 1;
              if (fake.delayReads) await fake.allowReads.future;
            }
            return fake.store[args['key']];
          case 'write':
            if (args['key'] == 'cache_aes_key') fake.keyWrites += 1;
            fake.store[args['key']] = args['value'] as String;
            return null;
          case 'delete':
            if (args['key'] == 'cache_aes_key' && fake.failKeyDelete) {
              throw PlatformException(code: 'secure-storage-unavailable');
            }
            fake.store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(fake.store);
          case 'deleteAll':
            fake.store.clear();
            return null;
          case 'containsKey':
            return fake.store.containsKey(args['key']);
          default:
            return null;
        }
      });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tempDir;
  late _SecureStorageFake storage;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('api_cache_key_test_');
    storage = _SecureStorageFake();
    _installPathProviderFake(tempDir.path);
    _installSecureStorageFake(storage);
    await ApiCacheManager.clearAll();
    storage.keyReads = 0;
    storage.keyWrites = 0;
  });

  tearDown(() async {
    await ApiCacheManager.clearAll();
    if (await tempDir.exists()) await tempDir.delete(recursive: true);
  });

  group('ApiCacheManager byte encryption', () {
    test('round-trips arbitrary PHI bytes', () async {
      final plain = Uint8List.fromList(
        List<int>.generate(5000, (i) => (i * 7 + 13) % 256),
      );

      final encrypted = await ApiCacheManager.encryptBytes(plain);
      final decrypted = await ApiCacheManager.decryptBytes(encrypted);

      expect(decrypted, equals(plain));
    });

    test('round-trips empty payload', () async {
      final encrypted = await ApiCacheManager.encryptBytes(<int>[]);
      // 12-byte IV + GCM tag, no body.
      expect(encrypted.length, greaterThan(12));
      final decrypted = await ApiCacheManager.decryptBytes(encrypted);
      expect(decrypted, isEmpty);
    });

    test('ciphertext does not contain the plaintext', () async {
      // A recognisable cleartext marker must not survive into the stored bytes.
      final marker = 'PATIENT_SSN_123456789'.codeUnits;
      final plain = Uint8List.fromList([
        ...List<int>.filled(64, 0),
        ...marker,
        ...List<int>.filled(64, 0),
      ]);

      final encrypted = await ApiCacheManager.encryptBytes(plain);

      // The marker subsequence must not appear in the ciphertext.
      var found = false;
      for (var i = 0; i + marker.length <= encrypted.length; i++) {
        var match = true;
        for (var j = 0; j < marker.length; j++) {
          if (encrypted[i + j] != marker[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          found = true;
          break;
        }
      }
      expect(found, isFalse, reason: 'plaintext leaked into ciphertext');
    });

    test(
      'uses a fresh random IV each time (same input → different output)',
      () async {
        final plain = Uint8List.fromList(List<int>.filled(256, 42));
        final a = await ApiCacheManager.encryptBytes(plain);
        final b = await ApiCacheManager.encryptBytes(plain);
        expect(a, isNot(equals(b)));
        // But both still decrypt back to the same plaintext.
        expect(await ApiCacheManager.decryptBytes(a), equals(plain));
        expect(await ApiCacheManager.decryptBytes(b), equals(plain));
      },
    );

    test('tampered ciphertext fails GCM authentication', () async {
      final plain = Uint8List.fromList(List<int>.generate(128, (i) => i));
      final encrypted = await ApiCacheManager.encryptBytes(plain);

      // Flip a bit in the ciphertext body (after the 12-byte IV).
      final tampered = Uint8List.fromList(encrypted);
      tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0x01;

      expect(() => ApiCacheManager.decryptBytes(tampered), throwsA(anything));
    });

    test('truncated payload (no room for IV) is rejected', () async {
      expect(
        () => ApiCacheManager.decryptBytes(Uint8List.fromList([1, 2, 3])),
        throwsA(isA<FormatException>()),
      );
    });

    test('concurrent first use initializes exactly one shared key', () async {
      storage.delayReads = true;
      final encryptions = List.generate(
        8,
        (index) => ApiCacheManager.encryptBytes(<int>[index, 7, 9]),
      );
      await Future<void>.delayed(Duration.zero);

      expect(storage.keyReads, 1);
      storage.allowReads.complete();
      final encrypted = await Future.wait(encryptions);

      expect(storage.keyWrites, 1);
      for (var i = 0; i < encrypted.length; i++) {
        expect(await ApiCacheManager.decryptBytes(encrypted[i]), <int>[
          i,
          7,
          9,
        ]);
      }
    });

    test('logout teardown destroys and rotates the cache key', () async {
      final encryptedUnderFirstSession = await ApiCacheManager.encryptBytes(
        <int>[1, 2, 3, 4],
      );
      final firstKey = storage.store['cache_aes_key'];

      await ApiCacheManager.clearAll();
      final encryptedUnderSecondSession = await ApiCacheManager.encryptBytes(
        <int>[5, 6, 7, 8],
      );
      final secondKey = storage.store['cache_aes_key'];

      expect(secondKey, isNot(equals(firstKey)));
      expect(
        () => ApiCacheManager.decryptBytes(encryptedUnderFirstSession),
        throwsA(anything),
      );
      expect(
        await ApiCacheManager.decryptBytes(encryptedUnderSecondSession),
        <int>[5, 6, 7, 8],
      );
    });

    test('cold restart reloads the persisted key', () async {
      final encrypted = await ApiCacheManager.encryptBytes(<int>[8, 6, 7, 5]);
      final persistedKey = storage.store['cache_aes_key'];

      await ApiCacheManager.debugForgetInMemoryKey();

      expect(await ApiCacheManager.decryptBytes(encrypted), <int>[8, 6, 7, 5]);
      expect(storage.store['cache_aes_key'], persistedKey);
      expect(storage.keyWrites, 1);
      expect(storage.keyReads, 2);
    });

    test('logout wins a race with concurrent first key use', () async {
      storage.delayReads = true;
      final encryption = ApiCacheManager.encryptBytes(<int>[1, 9, 9]);
      await Future<void>.delayed(Duration.zero);
      expect(storage.keyReads, 1);

      final teardown = ApiCacheManager.clearAll();
      storage.allowReads.complete();

      await expectLater(encryption, throwsA(isA<StateError>()));
      await teardown;
      expect(storage.store['cache_aes_key'], isNull);

      final nextSession = await ApiCacheManager.encryptBytes(<int>[2, 0, 0]);
      expect(await ApiCacheManager.decryptBytes(nextSession), <int>[2, 0, 0]);
      expect(storage.store['cache_aes_key'], isNotNull);
    });

    test('cache files are wiped even when secure key deletion fails', () async {
      await ApiCacheManager.save('/patient/phi', <String, dynamic>{
        'record': 'sensitive',
      });
      final cacheDir = Directory(
        '${tempDir.path}${Platform.pathSeparator}vhhealth'
        '${Platform.pathSeparator}api_cache',
      );
      expect(await cacheDir.exists(), isTrue);

      storage.failKeyDelete = true;
      await ApiCacheManager.clearAll();

      expect(await cacheDir.exists(), isFalse);
    });
  });
}

void _installPathProviderFake(String documentsPath) {
  const channel = MethodChannel('plugins.flutter.io/path_provider');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        if (call.method == 'getApplicationDocumentsDirectory') {
          return documentsPath;
        }
        return null;
      });
}
