import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
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
  SecretKey? _cached;
  final AesGcm _aesGcm = AesGcm.with256bits();

  Future<SecretKey> _key() async {
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
    _cached = SecretKey(base64Decode(b64));
    return _cached!;
  }

  /// Encrypt [plaintext] with AES-256-GCM and a fresh random 12-byte IV.
  /// Returns `iv_base64:ciphertext_base64`.
  Future<String> seal(String plaintext) async {
    final key = await _key();
    final nonce = _secureRandomBytes(12);
    final box = await _aesGcm.encrypt(
      utf8.encode(plaintext),
      secretKey: key,
      nonce: nonce,
    );
    final combined = Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
    return '${base64Encode(nonce)}:${base64Encode(combined)}';
  }

  /// Decrypt an envelope produced by [seal]. Throws on GCM authentication
  /// failure or malformed input.
  Future<String> open(String envelope) async {
    final key = await _key();
    final parts = envelope.split(':');
    if (parts.length != 2) {
      throw const FormatException('Invalid encrypted data');
    }
    final nonce = base64Decode(parts[0]);
    final combined = base64Decode(parts[1]);
    if (combined.length < 16) {
      throw const FormatException('Invalid encrypted data');
    }
    final cipherText = combined.sublist(0, combined.length - 16);
    final mac = Mac(combined.sublist(combined.length - 16));
    final plain = await _aesGcm.decrypt(
      SecretBox(cipherText, nonce: nonce, mac: mac),
      secretKey: key,
    );
    return utf8.decode(plain);
  }

  Uint8List _secureRandomBytes(int length) {
    final random = Random.secure();
    final bytes = Uint8List(length);
    for (var i = 0; i < length; i++) {
      bytes[i] = random.nextInt(256);
    }
    return bytes;
  }
}
