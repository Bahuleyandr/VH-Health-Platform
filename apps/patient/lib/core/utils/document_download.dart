import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth_core/config/api_config.dart';
import 'package:vhhealth_core/services/http_client.dart';

class DocumentUrlException implements Exception {
  const DocumentUrlException();

  @override
  String toString() => 'Document URL is not allowed';
}

class DocumentDownload {
  DocumentDownload._();

  static const _maxRedirects = 5;

  static Future<http.Response> get(
    String url, {
    http.Client? externalClient,
    Duration? timeout,
  }) async {
    final target = _DocumentTarget.parse(url);
    if (target.backendPath != null) {
      final response = await VHHttpClient.getBytes(
        target.backendPath!,
        timeout: timeout,
      );
      if (_isRedirect(response.statusCode)) throw const DocumentUrlException();
      return response;
    }

    final client = externalClient ?? http.Client();
    try {
      var current = target.uri;
      final visited = <Uri>{};
      for (var redirects = 0; redirects <= _maxRedirects; redirects++) {
        if (!visited.add(current)) throw const DocumentUrlException();
        final request = http.Request('GET', current)..followRedirects = false;
        final response = await client
            .send(request)
            .timeout(timeout ?? const Duration(seconds: 30));
        if (!_isRedirect(response.statusCode)) {
          return await http.Response.fromStream(response)
              .timeout(timeout ?? const Duration(seconds: 30));
        }
        final location = response.headers['location'];
        if (location == null ||
            location.isEmpty ||
            redirects == _maxRedirects) {
          throw const DocumentUrlException();
        }
        final _DocumentTarget next;
        try {
          final locationUri = Uri.tryParse(location);
          if (locationUri == null) throw const DocumentUrlException();
          next = _DocumentTarget.parse(
            current.resolveUri(locationUri).toString(),
          );
        } on FormatException {
          throw const DocumentUrlException();
        } on ArgumentError {
          throw const DocumentUrlException();
        }
        if (next.backendPath != null) throw const DocumentUrlException();
        await response.stream.drain<void>().timeout(
          timeout ?? const Duration(seconds: 30),
        );
        current = next.uri;
      }
      throw const DocumentUrlException();
    } finally {
      if (externalClient == null) client.close();
    }
  }

  static bool _isRedirect(int status) =>
      status == 301 ||
      status == 302 ||
      status == 303 ||
      status == 307 ||
      status == 308;
}

class _DocumentTarget {
  const _DocumentTarget(this.uri, this.backendPath);

  final Uri uri;
  final String? backendPath;

  static _DocumentTarget parse(String value) {
    final uri = Uri.tryParse(value);
    if (uri == null ||
        !uri.isAbsolute ||
        !uri.hasAuthority ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasFragment ||
        (uri.scheme != 'https' && uri.scheme != 'http')) {
      throw const DocumentUrlException();
    }

    final backend = Uri.tryParse(ApiConfig.baseUrl);
    if (backend == null || !backend.hasAuthority || backend.host.isEmpty) {
      throw const DocumentUrlException();
    }
    if (uri.host.toLowerCase() == backend.host.toLowerCase()) {
      if (uri.scheme != backend.scheme || uri.port != backend.port) {
        throw const DocumentUrlException();
      }
      if (uri.scheme != 'https' && !kDebugMode) {
        throw const DocumentUrlException();
      }
      final text = uri.toString();
      final pathStart = text.indexOf('/', text.indexOf('://') + 3);
      if (pathStart < 0) throw const DocumentUrlException();
      final pathAndQuery = text.substring(pathStart);
      final prefix = '${backend.path}/';
      if (!pathAndQuery.startsWith(prefix) ||
          uri.pathSegments.any(_unsafePathSegment)) {
        throw const DocumentUrlException();
      }
      return _DocumentTarget(uri, pathAndQuery.substring(backend.path.length));
    }

    if (uri.scheme != 'https') throw const DocumentUrlException();
    return _DocumentTarget(uri, null);
  }

  static bool _unsafePathSegment(String segment) {
    try {
      final decoded = Uri.decodeComponent(segment);
      return decoded == '.' ||
          decoded == '..' ||
          decoded.contains('/') ||
          decoded.contains('\\');
    } on FormatException {
      return true;
    }
  }
}
