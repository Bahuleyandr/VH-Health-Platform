import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:encrypt/encrypt.dart' as encrypt;
import 'secure_storage.dart';

/// AES-256-GCM seal/open codec for a named secure-storage key. Mirrors the
/// proven pattern in OfflineQueue (random 12-byte IV, `iv_base64:ciphertext`
/// envelope) so encrypted-at-rest clinical caches reuse one audited impl
/// instead of a second copy. The 256-bit key is generated once per [keyName]
/// and stored in the platform keychain via VHSecureStorage.
///
/// Public API uses [seal]/[open] rather than encrypt/decrypt to avoid a Dart
/// prefix-shadowing error (`import 'package:encrypt/...' as encrypt` is
/// shadowed by a class method named `encrypt`).
class SecureBlobCodec {
  SecureBlobCodec(this.keyName);
  final String keyName;
  encrypt.Key? _cached;

  Future<encrypt.Key> _key() async {
    if (_cached != null) return _cached!;
    final storage = VHSecureStorage.instance;
    var b64 = await storage.read(key: keyName);
    if (b64 == null) {
      final rnd = Random.secure();
      final bytes = Uint8List(32);
      for (var i = 0; i < 32; i++) {
        bytes[i] = rnd.nextInt(256);
      }
      b64 = base64Encode(bytes);
      await storage.write(key: keyName, value: b64);
    }
    _cached = encrypt.Key.fromBase64(b64);
    return _cached!;
  }

  /// Encrypt [plaintext] with AES-256-GCM and a fresh random 12-byte IV.
  /// Returns `iv_base64:ciphertext_base64`.
  Future<String> seal(String plaintext) async {
    final key = await _key();
    final iv = encrypt.IV.fromSecureRandom(12);
    final enc = encrypt.Encrypter(encrypt.AES(key, mode: encrypt.AESMode.gcm));
    final ct = enc.encrypt(plaintext, iv: iv);
    return '${iv.base64}:${ct.base64}';
  }

  /// Decrypt an envelope produced by [seal]. Throws on GCM authentication
  /// failure or malformed input.
  Future<String> open(String envelope) async {
    final key = await _key();
    final parts = envelope.split(':');
    if (parts.length != 2) throw const FormatException('Invalid encrypted data');
    final iv = encrypt.IV.fromBase64(parts[0]);
    final enc = encrypt.Encrypter(encrypt.AES(key, mode: encrypt.AESMode.gcm));
    return enc.decrypt(encrypt.Encrypted.fromBase64(parts[1]), iv: iv);
  }
}
