// Web (non-dart:io) implementation of the pinned HTTP client factory.
// Browsers own the TLS stack — certificate pinning is neither possible nor
// meaningful there, so the staff-web build gets the platform default client.

import 'package:http/http.dart' as http;

http.Client createPinnedHttpClient() => http.Client();
