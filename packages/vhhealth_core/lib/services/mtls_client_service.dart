import 'dart:async';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'secure_storage.dart';

/// Client-side mTLS plumbing.
///
/// Loads a device-provisioned client certificate + private key from secure
/// storage and returns an `http.Client` whose underlying `HttpClient` presents
/// them on every request. Consumers can plumb this into `VHHttpClient` via
/// its `setClientForTesting` hook in production builds once the backend
/// requires a client certificate at TLS handshake.
///
/// **Out of scope here** (flagged as follow-up):
///   * Backend enforcement — nginx/Cloudflare-tunnel must be configured to
///     require and validate client certs against the hospital CA.
///   * Cert provisioning / rotation — new devices need to receive a cert on
///     first login (e.g. via a one-time enrolment endpoint signed with the
///     user's JWT). Rotation cron runs independently.
///
/// This service is a self-contained hook: when the backend is ready, toggle a
/// feature flag and swap the HTTP client in one place.
class MtlsClientService {
  MtlsClientService._();
  static final MtlsClientService instance = MtlsClientService._();

  static const _certStorageKey = 'mtls_client_cert_pem';
  static const _keyStorageKey = 'mtls_client_key_pem';

  final _storage = VHSecureStorage.instance;

  /// Persist a newly provisioned cert + key.
  Future<void> installCertificate({
    required String certPem,
    required String keyPem,
  }) async {
    await _storage.write(key: _certStorageKey, value: certPem);
    await _storage.write(key: _keyStorageKey, value: keyPem);
  }

  /// Wipe the local cert + key (used on logout or failed attestation).
  Future<void> clear() async {
    await _storage.delete(key: _certStorageKey);
    await _storage.delete(key: _keyStorageKey);
  }

  /// True when a usable certificate is installed locally. Consumers should
  /// fall back to a non-mTLS client if this is false (e.g. during rollout).
  Future<bool> hasCertificate() async {
    final cert = await _storage.read(key: _certStorageKey);
    final key = await _storage.read(key: _keyStorageKey);
    return cert != null && cert.isNotEmpty && key != null && key.isNotEmpty;
  }

  /// Build an `http.Client` that presents the installed client certificate
  /// on every TLS handshake. Returns null if no cert is installed — callers
  /// should use the default non-mTLS client in that case.
  ///
  /// Note: `http` package on the web platform doesn't support client certs —
  /// this method returns null there and consumers must fall back.
  Future<http.Client?> buildClient({String? password}) async {
    if (!Platform.isAndroid &&
        !Platform.isIOS &&
        !Platform.isMacOS &&
        !Platform.isLinux &&
        !Platform.isWindows) {
      return null;
    }
    final certPem = await _storage.read(key: _certStorageKey);
    final keyPem = await _storage.read(key: _keyStorageKey);
    if (certPem == null || keyPem == null) return null;

    final ctx = SecurityContext(withTrustedRoots: true);
    ctx.useCertificateChainBytes(certPem.codeUnits);
    ctx.usePrivateKeyBytes(keyPem.codeUnits, password: password);

    final httpClient = HttpClient(context: ctx);
    return IOClient(httpClient);
  }
}
