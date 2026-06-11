// Platform-conditional pinned HTTP client factory (audit finding H7).
//
// On dart:io platforms (Android/iOS/desktop) this resolves to
// pinned_http_client_io.dart, which wraps CertificatePinner's SPKI-pinned
// HttpClient in an IOClient. On web it resolves to the stub (plain client).
//
// VHHttpClient uses createPinnedHttpClient() as its default client, so every
// API call in production builds goes through the pin.

export 'pinned_http_client_stub.dart'
    if (dart.library.io) 'pinned_http_client_io.dart';
