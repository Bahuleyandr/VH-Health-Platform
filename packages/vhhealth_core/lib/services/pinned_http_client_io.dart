// dart:io implementation of the pinned HTTP client factory (audit finding
// H7). Selected via conditional import from pinned_http_client.dart on
// mobile/desktop; web builds get the stub (browsers manage TLS themselves —
// SPKI pinning is not possible there).

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

import '../config/api_config.dart';
import '../config/security_config.dart';
import 'certificate_pinner.dart';

/// Returns the default [http.Client] for VHHealth API traffic.
///
/// Production builds (`--dart-define=PRODUCTION=true`): an [IOClient] backed
/// by [CertificatePinner.createSecureClient] — SPKI-pinned to
/// `CERT_PIN_HASHES` and restricted to the API host.
/// Dev builds: a plain [http.Client] (pinning disabled so localhost/staging
/// self-signed certs keep working).
http.Client createPinnedHttpClient() {
  if (!SecurityConfig.enableCertPinning) {
    return http.Client();
  }
  final apiHost = Uri.tryParse(ApiConfig.baseUrl)?.host;
  return IOClient(CertificatePinner.createSecureClient(pinnedHost: apiHost));
}
