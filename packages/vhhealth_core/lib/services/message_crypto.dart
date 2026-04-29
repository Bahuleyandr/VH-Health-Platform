import 'dart:convert';
import 'dart:math' show Random;
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// End-to-end encrypted messaging primitive for VHHealth.
///
/// Each user holds a long-lived X25519 key pair (private in
/// [FlutterSecureStorage]; public published via `/users/me/public-key`).
/// Sending a message:
///
///   1. Derive a 32-byte shared secret with X25519(my_priv, their_pub).
///   2. HKDF(shared, salt=random(16)) → 32-byte session key.
///   3. AES-GCM-256(session_key, nonce=random(12)) over the plaintext.
///   4. Ship `{ v, salt, nonce, ct }` (base64) as the opaque payload.
///
/// Backend relays the payload verbatim — it holds no keys.
///
/// Trade-offs:
///   * No forward secrecy — long-lived identity keys. For clinical messaging
///     this is acceptable; a double-ratchet upgrade is flagged as follow-up.
///   * Per-message salt gives per-message key isolation so compromising one
///     ciphertext doesn't reveal others.
class MessageCrypto {
  MessageCrypto._();
  static final MessageCrypto instance = MessageCrypto._();

  static const _privKeyStorageKey = 'e2e_x25519_priv';

  final _storage = const FlutterSecureStorage();
  final _x25519 = X25519();
  final _aes = AesGcm.with256bits();
  final _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
  final Random _random = Random.secure();

  SimpleKeyPair? _cachedKeyPair;

  Future<SimpleKeyPair> _myKeyPair() async {
    if (_cachedKeyPair != null) return _cachedKeyPair!;
    final stored = await _storage.read(key: _privKeyStorageKey);
    if (stored != null) {
      final seed = base64Decode(stored);
      _cachedKeyPair = await _x25519.newKeyPairFromSeed(seed);
      return _cachedKeyPair!;
    }
    final pair = await _x25519.newKeyPair();
    final priv = await pair.extractPrivateKeyBytes();
    await _storage.write(key: _privKeyStorageKey, value: base64Encode(priv));
    _cachedKeyPair = pair;
    return pair;
  }

  /// Public key as base64. Publish to backend for peers to fetch.
  Future<String> myPublicKeyBase64() async {
    final pair = await _myKeyPair();
    final pub = await pair.extractPublicKey();
    return base64Encode(pub.bytes);
  }

  /// Encrypt [plaintext] for a peer identified by their public key.
  Future<Map<String, String>> encrypt({
    required String plaintext,
    required String peerPublicKeyBase64,
  }) async {
    final myPair = await _myKeyPair();
    final peerPub = SimplePublicKey(
      base64Decode(peerPublicKeyBase64),
      type: KeyPairType.x25519,
    );
    final shared = await _x25519.sharedSecretKey(
      keyPair: myPair,
      remotePublicKey: peerPub,
    );
    final salt = _randomBytes(16);
    final sessionKey = await _hkdf.deriveKey(secretKey: shared, nonce: salt);
    final nonce = _randomBytes(12);
    final box = await _aes.encrypt(
      utf8.encode(plaintext),
      secretKey: sessionKey,
      nonce: nonce,
    );
    final ctMac = Uint8List(box.cipherText.length + box.mac.bytes.length)
      ..setRange(0, box.cipherText.length, box.cipherText)
      ..setRange(
        box.cipherText.length,
        box.cipherText.length + box.mac.bytes.length,
        box.mac.bytes,
      );
    return {
      'v': '1',
      'salt': base64Encode(salt),
      'nonce': base64Encode(nonce),
      'ct': base64Encode(ctMac),
    };
  }

  /// Decrypt a payload produced by [encrypt] on the peer's device.
  Future<String> decrypt({
    required Map<String, dynamic> payload,
    required String peerPublicKeyBase64,
  }) async {
    final version = payload['v']?.toString() ?? '1';
    if (version != '1') {
      throw StateError('Unsupported ciphertext version: $version');
    }
    final myPair = await _myKeyPair();
    final peerPub = SimplePublicKey(
      base64Decode(peerPublicKeyBase64),
      type: KeyPairType.x25519,
    );
    final shared = await _x25519.sharedSecretKey(
      keyPair: myPair,
      remotePublicKey: peerPub,
    );
    final salt = base64Decode(payload['salt'] as String);
    final sessionKey = await _hkdf.deriveKey(secretKey: shared, nonce: salt);
    final nonce = base64Decode(payload['nonce'] as String);
    final ctMac = base64Decode(payload['ct'] as String);
    // Last 16 bytes = AES-GCM MAC.
    final macBytes = ctMac.sublist(ctMac.length - 16);
    final ctOnly = ctMac.sublist(0, ctMac.length - 16);
    final box = SecretBox(ctOnly, nonce: nonce, mac: Mac(macBytes));
    final plain = await _aes.decrypt(box, secretKey: sessionKey);
    return utf8.decode(plain);
  }

  /// Wipe local identity — used on logout.
  Future<void> resetIdentity() async {
    await _storage.delete(key: _privKeyStorageKey);
    _cachedKeyPair = null;
  }

  Uint8List _randomBytes(int n) {
    final out = Uint8List(n);
    for (var i = 0; i < n; i++) {
      out[i] = _random.nextInt(256);
    }
    return out;
  }
}
