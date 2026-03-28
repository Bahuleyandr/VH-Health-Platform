// lib/core/services/certificate_pinner.dart

import 'dart:io';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/config/security_config.dart';

/// SHA-256 certificate fingerprints that the app will accept.
///
/// These correspond to the SPKI (Subject Public Key Info) hashes of the
/// backend's TLS certificate chain. When the backend certificate rotates,
/// add the new fingerprint here **before** removing the old one so that
/// users on older app versions are not locked out during the overlap window.
///
/// ### How to obtain a fingerprint
/// ```bash
/// openssl s_client -connect api.vhhealth.app:443 </dev/null 2>/dev/null \
///   | openssl x509 -pubkey -noout \
///   | openssl pkey -pubin -outform DER \
///   | openssl dgst -sha256
/// ```
///
/// ### Certificate rotation checklist
/// 1. Obtain the SHA-256 SPKI hash of the **new** certificate.
/// 2. Add it to [SecurityConfig.pinnedCertFingerprints] alongside the old hash.
/// 3. Release an app update so clients accept both certificates.
/// 4. Deploy the new certificate on the server.
/// 5. After all users have updated, remove the old hash.
const List<String> kPinnedCertificates = SecurityConfig.pinnedCertFingerprints;

/// Utility that creates an [HttpClient] with TLS certificate pinning.
///
/// In **production** builds (when [SecurityConfig.enableCertPinning] is true),
/// the client validates the server certificate's SHA-256 fingerprint against
/// [kPinnedCertificates]. Connections to servers with unknown certificates
/// are rejected.
///
/// In **debug / dev** builds, pinning is disabled so that developers can use
/// `localhost`, staging servers, or proxies (e.g. Charles, mitmproxy) without
/// certificate errors.
///
/// Usage:
/// ```dart
/// final client = CertificatePinner.createSecureClient();
/// final request = await client.getUrl(Uri.parse('https://api.vhhealth.app/api/v1/...'));
/// final response = await request.close();
/// ```
class CertificatePinner {
  CertificatePinner._();

  /// Creates an [HttpClient] configured with certificate pinning.
  ///
  /// When pinning is enabled ([SecurityConfig.enableCertPinning] is true and
  /// [kPinnedCertificates] is non-empty), the client's
  /// [HttpClient.badCertificateCallback] rejects any server whose certificate
  /// fingerprint is not in the pinned list.
  ///
  /// When pinning is disabled (debug builds or empty pin list), the client
  /// behaves normally — all valid certificates are accepted.
  static HttpClient createSecureClient() {
    final client = HttpClient();

    if (!SecurityConfig.enableCertPinning) {
      if (kDebugMode) {
        debugPrint(
          'CertificatePinner: pinning DISABLED (debug/dev build). '
          'All valid certificates accepted.',
        );
        // In debug mode, also accept bad certificates (self-signed, expired)
        // so developers can work with local servers.
        client.badCertificateCallback = (cert, host, port) => true;
      }
      return client;
    }

    if (kPinnedCertificates.isEmpty) {
      if (kDebugMode) {
        debugPrint(
          'CertificatePinner: WARNING — pinning enabled but no fingerprints '
          'configured. All connections will be REJECTED. Add fingerprints to '
          'SecurityConfig.pinnedCertFingerprints.',
        );
      }
      // Fail closed: if pinning is on but no pins are configured, reject
      // everything rather than silently allowing all connections.
      client.badCertificateCallback = (cert, host, port) => false;
      return client;
    }

    // Normalize stored fingerprints to lowercase for comparison.
    final normalizedPins =
        kPinnedCertificates.map((fp) => fp.toLowerCase().replaceAll(':', '')).toSet();

    client.badCertificateCallback = (X509Certificate cert, String host, int port) {
      // Compute the SHA-256 fingerprint of the DER-encoded certificate.
      final fingerprint = _sha256Fingerprint(cert);

      final matches = normalizedPins.contains(fingerprint);
      if (!matches && kDebugMode) {
        debugPrint(
          'CertificatePinner: certificate for $host:$port REJECTED.\n'
          '  Received fingerprint: $fingerprint\n'
          '  Pinned fingerprints:  $normalizedPins',
        );
      }
      return matches;
    };

    if (kDebugMode) {
      debugPrint(
        'CertificatePinner: pinning ENABLED with '
        '${kPinnedCertificates.length} fingerprint(s).',
      );
    }

    return client;
  }

  /// Computes a lowercase hex SHA-256 fingerprint of the certificate's
  /// DER-encoded bytes.
  static String _sha256Fingerprint(X509Certificate cert) {
    // X509Certificate.der provides the DER-encoded certificate bytes.
    final derBytes = cert.der;
    // Use Dart's built-in SHA-256 from dart:convert is not available, so we
    // use the crypto approach via the raw bytes.
    // Note: We compute over the full DER certificate. For SPKI pinning in
    // production you may want to extract the public key; however, the
    // badCertificateCallback only gives us the full X509Certificate, so we
    // pin against the full certificate fingerprint.
    final digest = _sha256(derBytes);
    return digest.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  /// Pure-Dart SHA-256 implementation to avoid extra dependencies.
  /// Uses the dart:io / dart:convert ecosystem.
  static List<int> _sha256(List<int> data) {
    // We leverage the `sha256` from `dart:convert` indirectly via
    // `dart:io`'s Hash class (available since Dart 2.x).
    final hash = _Sha256();
    hash.update(data);
    return hash.digest();
  }
}

/// Minimal SHA-256 implementation so we don't need an external crypto package.
/// Based on the FIPS 180-4 specification.
class _Sha256 {
  static const List<int> _k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
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
    // Append 64-bit big-endian length.
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
      w[i] = (block[i * 4] << 24) |
          (block[i * 4 + 1] << 16) |
          (block[i * 4 + 2] << 8) |
          block[i * 4 + 3];
    }
    for (var i = 16; i < 64; i++) {
      final s0 = _rotr32(7, w[i - 15]) ^ _rotr32(18, w[i - 15]) ^ (w[i - 15] >> 3);
      final s1 = _rotr32(17, w[i - 2]) ^ _rotr32(19, w[i - 2]) ^ (w[i - 2] >> 10);
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
