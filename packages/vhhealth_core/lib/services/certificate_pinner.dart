import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import '../config/security_config.dart';

final List<String> kPinnedCertificates = SecurityConfig.pinnedCertFingerprints;

/// Shared TLS certificate pinning utility for VHHealth apps.
///
/// Audit finding H7 (2026-06-10): the original implementation was broken in
/// two ways — it hashed the WHOLE certificate DER and compared the hex digest
/// against `sha256/<base64-SPKI>` pins (so it would have rejected 100% of
/// connections had it ever run), and it was never wired into [VHHttpClient]
/// at all. It now:
///
///   * hashes the SubjectPublicKeyInfo (SPKI) — the industry-standard pin
///     target (survives certificate renewal with the same key), matching the
///     `openssl ... -pubkey | openssl pkey -pubin -outform DER | dgst -sha256
///     -binary | base64` extraction documented in [SecurityConfig];
///   * normalizes `sha256/`-prefixed base64 pins;
///   * creates the [HttpClient] with `withTrustedRoots: false` so EVERY
///     connection hits [HttpClient.badCertificateCallback] and the pin is the
///     sole trust anchor — a MITM proxy with a user-installed (or even
///     system-trusted) CA presents a different key and is rejected;
///   * optionally restricts the client to the API host so the pinned client
///     can never be repurposed for other origins.
///
/// Wire-up: `createPinnedHttpClient()` (see pinned_http_client.dart) is the
/// default client inside `VHHttpClient` on dart:io platforms.
class CertificatePinner {
  CertificatePinner._();

  static HttpClient createSecureClient({String? pinnedHost}) {
    if (!SecurityConfig.enableCertPinning) {
      final client = HttpClient();
      if (kDebugMode) {
        debugPrint(
          'CertificatePinner: pinning DISABLED (debug/dev build). All valid certificates accepted.',
        );
        client.badCertificateCallback = (cert, host, port) => true;
      }
      return client;
    }

    if (kPinnedCertificates.isEmpty) {
      // Fail closed: pinning enabled but unconfigured — reject everything.
      // SecurityConfig.verifyOrWarn() (called at app startup) throws before
      // we ever get here, so this is a second line of defence.
      final client = HttpClient();
      client.badCertificateCallback = (cert, host, port) => false;
      return client;
    }

    final normalizedPins = normalizePins(kPinnedCertificates);

    // No platform trust roots: every connection is forced through the
    // badCertificateCallback below, making the SPKI pin the sole trust
    // anchor for this client.
    final context = SecurityContext(withTrustedRoots: false);
    final client = HttpClient(context: context);

    client.badCertificateCallback =
        (X509Certificate cert, String host, int port) {
          if (pinnedHost != null &&
              pinnedHost.isNotEmpty &&
              host.toLowerCase() != pinnedHost.toLowerCase()) {
            // The pinned client only ever talks to the API host.
            return false;
          }
          final bool matches = certMatchesPins(cert, normalizedPins);
          if (!matches && kDebugMode) {
            debugPrint(
              'CertificatePinner: certificate for $host:$port REJECTED '
              '(SPKI pin mismatch).',
            );
          }
          return matches;
        };

    if (kDebugMode) {
      debugPrint(
        'CertificatePinner: pinning ENABLED with ${kPinnedCertificates.length} fingerprint(s).',
      );
    }

    return client;
  }

  /// Strips the `sha256/` prefix from each configured pin. Entries without
  /// the prefix are kept verbatim (already-bare base64).
  @visibleForTesting
  static Set<String> normalizePins(List<String> pins) {
    return pins
        .map((p) => p.trim())
        .where((p) => p.isNotEmpty)
        .map((p) => p.startsWith('sha256/') ? p.substring('sha256/'.length) : p)
        .toSet();
  }

  /// True when [cert]'s SPKI SHA-256 (base64) matches one of
  /// [normalizedPins] (bare base64, no `sha256/` prefix).
  static bool certMatchesPins(X509Certificate cert, Set<String> normalizedPins) {
    try {
      final spkiHash = spkiSha256Base64FromDer(
        Uint8List.fromList(cert.der),
      );
      return normalizedPins.contains(spkiHash);
    } catch (_) {
      // Unparsable certificate ⇒ fail closed.
      return false;
    }
  }

  /// Computes the base64 SHA-256 of the SubjectPublicKeyInfo extracted from
  /// a DER-encoded X.509 certificate. This matches the documented openssl
  /// pin-extraction pipeline. Throws [FormatException] on malformed DER.
  @visibleForTesting
  static String spkiSha256Base64FromDer(Uint8List certDer) {
    final spki = extractSpkiDer(certDer);
    final hash = _Sha256()
      ..update(spki);
    return base64.encode(hash.digest());
  }

  /// Extracts the SubjectPublicKeyInfo TLV from a DER X.509 certificate.
  ///
  /// Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
  /// TBSCertificate ::= SEQUENCE {
  ///   version [0] EXPLICIT OPTIONAL, serialNumber, signature(alg),
  ///   issuer, validity, subject, subjectPublicKeyInfo, ... }
  @visibleForTesting
  static Uint8List extractSpkiDer(Uint8List der) {
    final cert = _DerElement.parse(der, 0);
    if (cert.tag != 0x30) {
      throw const FormatException('Certificate: expected outer SEQUENCE');
    }
    final tbs = _DerElement.parse(der, cert.contentStart);
    if (tbs.tag != 0x30) {
      throw const FormatException('TBSCertificate: expected SEQUENCE');
    }

    var offset = tbs.contentStart;
    final tbsEnd = tbs.contentStart + tbs.contentLength;

    // Optional version, tagged [0] (0xA0).
    var element = _DerElement.parse(der, offset);
    if (element.tag == 0xa0) {
      offset = element.end;
      element = _DerElement.parse(der, offset);
    }
    // serialNumber (INTEGER), signature alg (SEQ), issuer (SEQ),
    // validity (SEQ), subject (SEQ) — skip 5 elements.
    for (var i = 0; i < 5; i++) {
      offset = element.end;
      if (offset >= tbsEnd) {
        throw const FormatException('TBSCertificate: truncated before SPKI');
      }
      element = _DerElement.parse(der, offset);
    }
    // `element` is now subjectPublicKeyInfo.
    if (element.tag != 0x30) {
      throw const FormatException('SubjectPublicKeyInfo: expected SEQUENCE');
    }
    return Uint8List.sublistView(der, offset, element.end);
  }
}

/// Minimal DER TLV reader (tag + definite-form length only — all X.509
/// certificate fields use definite lengths).
class _DerElement {
  _DerElement(this.tag, this.contentStart, this.contentLength);

  final int tag;
  final int contentStart;
  final int contentLength;

  int get end => contentStart + contentLength;

  static _DerElement parse(Uint8List bytes, int offset) {
    if (offset + 2 > bytes.length) {
      throw const FormatException('DER: truncated element header');
    }
    final tag = bytes[offset];
    var lengthByte = bytes[offset + 1];
    var contentStart = offset + 2;
    int contentLength;
    if (lengthByte < 0x80) {
      contentLength = lengthByte;
    } else {
      final numLengthBytes = lengthByte & 0x7f;
      if (numLengthBytes == 0 || numLengthBytes > 4) {
        throw const FormatException('DER: unsupported length encoding');
      }
      if (contentStart + numLengthBytes > bytes.length) {
        throw const FormatException('DER: truncated length');
      }
      contentLength = 0;
      for (var i = 0; i < numLengthBytes; i++) {
        contentLength = (contentLength << 8) | bytes[contentStart + i];
      }
      contentStart += numLengthBytes;
    }
    if (contentStart + contentLength > bytes.length) {
      throw const FormatException('DER: element overruns buffer');
    }
    return _DerElement(tag, contentStart, contentLength);
  }
}

class _Sha256 {
  static const List<int> _k = [
    0x428a2f98,
    0x71374491,
    0xb5c0fbcf,
    0xe9b5dba5,
    0x3956c25b,
    0x59f111f1,
    0x923f82a4,
    0xab1c5ed5,
    0xd807aa98,
    0x12835b01,
    0x243185be,
    0x550c7dc3,
    0x72be5d74,
    0x80deb1fe,
    0x9bdc06a7,
    0xc19bf174,
    0xe49b69c1,
    0xefbe4786,
    0x0fc19dc6,
    0x240ca1cc,
    0x2de92c6f,
    0x4a7484aa,
    0x5cb0a9dc,
    0x76f988da,
    0x983e5152,
    0xa831c66d,
    0xb00327c8,
    0xbf597fc7,
    0xc6e00bf3,
    0xd5a79147,
    0x06ca6351,
    0x14292967,
    0x27b70a85,
    0x2e1b2138,
    0x4d2c6dfc,
    0x53380d13,
    0x650a7354,
    0x766a0abb,
    0x81c2c92e,
    0x92722c85,
    0xa2bfe8a1,
    0xa81a664b,
    0xc24b8b70,
    0xc76c51a3,
    0xd192e819,
    0xd6990624,
    0xf40e3585,
    0x106aa070,
    0x19a4c116,
    0x1e376c08,
    0x2748774c,
    0x34b0bcb5,
    0x391c0cb3,
    0x4ed8aa4a,
    0x5b9cca4f,
    0x682e6ff3,
    0x748f82ee,
    0x78a5636f,
    0x84c87814,
    0x8cc70208,
    0x90befffa,
    0xa4506ceb,
    0xbef9a3f7,
    0xc67178f2,
  ];

  final List<int> _buffer = [];
  int _lengthInBytes = 0;
  int _h0 = 0x6a09e667;
  int _h1 = 0xbb67ae85;
  int _h2 = 0x3c6ef372;
  int _h3 = 0xa54ff53a;
  int _h4 = 0x510e527f;
  int _h5 = 0x9b05688c;
  int _h6 = 0x1f83d9ab;
  int _h7 = 0x5be0cd19;

  void update(List<int> data) {
    _lengthInBytes += data.length;
    _buffer.addAll(data);
    _processBlocks();
  }

  List<int> digest() {
    _pad();
    _processBlocks();
    final result = <int>[];
    void addWord(int w) {
      result.add((w >> 24) & 0xff);
      result.add((w >> 16) & 0xff);
      result.add((w >> 8) & 0xff);
      result.add(w & 0xff);
    }

    addWord(_h0);
    addWord(_h1);
    addWord(_h2);
    addWord(_h3);
    addWord(_h4);
    addWord(_h5);
    addWord(_h6);
    addWord(_h7);
    return result;
  }

  void _pad() {
    final bitLength = _lengthInBytes * 8;
    _buffer.add(0x80);
    while (_buffer.length % 64 != 56) {
      _buffer.add(0x00);
    }
    for (var i = 56; i >= 0; i -= 8) {
      _buffer.add((bitLength >> i) & 0xff);
    }
  }

  void _processBlocks() {
    while (_buffer.length >= 64) {
      _processBlock(_buffer.sublist(0, 64));
      _buffer.removeRange(0, 64);
    }
  }

  static int _rotr32(int n, int x) => ((x >> n) | (x << (32 - n))) & 0xffffffff;

  void _processBlock(List<int> block) {
    final w = List<int>.filled(64, 0);
    for (var i = 0; i < 16; i++) {
      w[i] =
          (block[i * 4] << 24) |
          (block[i * 4 + 1] << 16) |
          (block[i * 4 + 2] << 8) |
          block[i * 4 + 3];
    }
    for (var i = 16; i < 64; i++) {
      final s0 =
          _rotr32(7, w[i - 15]) ^ _rotr32(18, w[i - 15]) ^ (w[i - 15] >> 3);
      final s1 =
          _rotr32(17, w[i - 2]) ^ _rotr32(19, w[i - 2]) ^ (w[i - 2] >> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xffffffff;
    }

    var a = _h0, b = _h1, c = _h2, d = _h3;
    var e = _h4, f = _h5, g = _h6, h = _h7;

    for (var i = 0; i < 64; i++) {
      final s1 = _rotr32(6, e) ^ _rotr32(11, e) ^ _rotr32(25, e);
      final ch = (e & f) ^ (~e & 0xffffffff & g);
      final temp1 = (h + s1 + ch + _k[i] + w[i]) & 0xffffffff;
      final s0 = _rotr32(2, a) ^ _rotr32(13, a) ^ _rotr32(22, a);
      final maj = (a & b) ^ (a & c) ^ (b & c);
      final temp2 = (s0 + maj) & 0xffffffff;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) & 0xffffffff;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & 0xffffffff;
    }

    _h0 = (_h0 + a) & 0xffffffff;
    _h1 = (_h1 + b) & 0xffffffff;
    _h2 = (_h2 + c) & 0xffffffff;
    _h3 = (_h3 + d) & 0xffffffff;
    _h4 = (_h4 + e) & 0xffffffff;
    _h5 = (_h5 + f) & 0xffffffff;
    _h6 = (_h6 + g) & 0xffffffff;
    _h7 = (_h7 + h) & 0xffffffff;
  }
}
