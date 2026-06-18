// test/core/offline/api_cache_manager_bytes_test.dart
//
// Unit tests for ApiCacheManager.encryptBytes / decryptBytes — the at-rest
// encryption that CacheFileUtils and DocumentOpener reuse for downloaded PHI
// documents. Uses an in-memory fake for the flutter_secure_storage channel so
// the per-device AES key (`cache_aes_key`) can be created/read without the
// native plugin.

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final Map<String, String> store = {};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key']] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(_installSecureStorageFake);

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

    test('uses a fresh random IV each time (same input → different output)',
        () async {
      final plain = Uint8List.fromList(List<int>.filled(256, 42));
      final a = await ApiCacheManager.encryptBytes(plain);
      final b = await ApiCacheManager.encryptBytes(plain);
      expect(a, isNot(equals(b)));
      // But both still decrypt back to the same plaintext.
      expect(await ApiCacheManager.decryptBytes(a), equals(plain));
      expect(await ApiCacheManager.decryptBytes(b), equals(plain));
    });

    test('tampered ciphertext fails GCM authentication', () async {
      final plain = Uint8List.fromList(List<int>.generate(128, (i) => i));
      final encrypted = await ApiCacheManager.encryptBytes(plain);

      // Flip a bit in the ciphertext body (after the 12-byte IV).
      final tampered = Uint8List.fromList(encrypted);
      tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0x01;

      expect(
        () => ApiCacheManager.decryptBytes(tampered),
        throwsA(anything),
      );
    });

    test('truncated payload (no room for IV) is rejected', () async {
      expect(
        () => ApiCacheManager.decryptBytes(Uint8List.fromList([1, 2, 3])),
        throwsA(isA<FormatException>()),
      );
    });
  });
}
