import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/api_response.dart';
import 'auth_service.dart';

/// Production-grade HTTP client for all VHHealth backend API calls.
///
/// Features:
/// - Automatic JWT auth header injection
/// - Configurable timeouts (15s default, 30s uploads)
/// - JSON response parsing via [ApiResponse]
/// - 401 session-expiry detection with callback
/// - Multipart file upload support
/// - Query parameter support
class VHHttpClient {
  VHHttpClient._();

  static const Duration _defaultTimeout = Duration(seconds: 15);
  static const Duration _uploadTimeout = Duration(seconds: 30);

  /// Called when the backend returns 401 (unauthorized / session expired).
  /// Set this from the app's root widget to trigger a redirect to login.
  static void Function(String? message)? onSessionExpired;

  // ── Injectable HTTP client (for tests) ─────────────────────────────────
  static http.Client _client = http.Client();

  /// Replace the internal [http.Client] with a mock for testing.
  /// Always pair with [resetClientForTesting] in tearDown.
  @visibleForTesting
  static void setClientForTesting(http.Client client) {
    _client = client;
  }

  /// Restore the default [http.Client]. Call in test tearDown.
  @visibleForTesting
  static void resetClientForTesting() {
    _client = http.Client();
  }

  // ── Convenience HTTP methods ──────────────────────────────────────────

  /// Authenticated GET request. Automatically retries once on 401 after
  /// refreshing the JWT token.
  static Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path, queryParameters);
    final headers = await _headers(auth: auth);
    final response = await _sendWithRetry(
      () => _client.get(uri, headers: headers).timeout(timeout ?? _defaultTimeout),
    );
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      // Token was refreshed — retry with new headers
      final retryHeaders = await _headers(auth: true);
      final retry = await _sendWithRetry(
        () => _client
            .get(uri, headers: retryHeaders)
            .timeout(timeout ?? _defaultTimeout),
      );
      return _processResponse(retry);
    }

    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated POST request with JSON body. Automatically retries once
  /// on 401 after refreshing the JWT token.
  static Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    final headers = await _headers(auth: auth, json: true);
    final response = await _sendWithRetry(
      () => _client
          .post(uri, headers: headers, body: encoded)
          .timeout(timeout ?? _defaultTimeout),
    );
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(auth: true, json: true);
      final retry = await _sendWithRetry(
        () => _client
            .post(uri, headers: retryHeaders, body: encoded)
            .timeout(timeout ?? _defaultTimeout),
      );
      return _processResponse(retry);
    }

    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated PUT request with JSON body.
  static Future<ApiResponse> put(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    final headers = await _headers(auth: auth, json: true);
    final response = await _sendWithRetry(
      () => _client
          .put(uri, headers: headers, body: encoded)
          .timeout(timeout ?? _defaultTimeout),
    );
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(auth: true, json: true);
      final retry = await _sendWithRetry(
        () => _client
            .put(uri, headers: retryHeaders, body: encoded)
            .timeout(timeout ?? _defaultTimeout),
      );
      return _processResponse(retry);
    }

    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated PATCH request with optional JSON body.
  static Future<ApiResponse> patch(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    final headers = await _headers(auth: auth, json: true);
    final response = await _sendWithRetry(
      () => _client
          .patch(uri, headers: headers, body: encoded)
          .timeout(timeout ?? _defaultTimeout),
    );
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(auth: true, json: true);
      final retry = await _sendWithRetry(
        () => _client
            .patch(uri, headers: retryHeaders, body: encoded)
            .timeout(timeout ?? _defaultTimeout),
      );
      return _processResponse(retry);
    }

    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated DELETE request.
  static Future<ApiResponse> delete(
    String path, {
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);
    final headers = await _headers(auth: auth);
    final response = await _sendWithRetry(
      () => _client.delete(uri, headers: headers).timeout(timeout ?? _defaultTimeout),
    );
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(auth: true);
      final retry = await _sendWithRetry(
        () => _client
            .delete(uri, headers: retryHeaders)
            .timeout(timeout ?? _defaultTimeout),
      );
      return _processResponse(retry);
    }

    _checkUnauthorized(parsed);
    return parsed;
  }

  /// Authenticated multipart POST (for file uploads). Retries once on 401
  /// after a successful token refresh. Multipart files must be re-read on
  /// retry, so callers pass a `fileBuilder` that returns fresh `MultipartFile`
  /// instances (the `files` param is kept for backward compat with non-401
  /// paths).
  static Future<ApiResponse> multipart(
    String path, {
    Map<String, String> fields = const {},
    List<http.MultipartFile> files = const [],
    Future<List<http.MultipartFile>> Function()? fileBuilder,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path);

    Future<ApiResponse> send() async {
      final headers = await _headers(auth: auth);
      final req = http.MultipartRequest('POST', uri)
        ..headers.addAll(headers)
        ..fields.addAll(fields)
        ..files.addAll(fileBuilder != null ? await fileBuilder() : files);
      final streamed =
          await _client.send(req).timeout(timeout ?? _uploadTimeout);
      final body = await streamed.stream.bytesToString();
      return ApiResponse.parse(streamed.statusCode, body);
    }

    final parsed = await send();
    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      // Can only retry cleanly if caller supplied a fileBuilder (streams are
      // single-use). If not, report session expiry.
      if (fileBuilder != null) {
        final retry = await send();
        _checkUnauthorized(retry);
        return retry;
      }
    }

    _checkUnauthorized(parsed);
    return parsed;
  }

  // ── Retry with exponential backoff on network + 5xx ───────────────────

  static const int _maxRetryAttempts = 3;
  static const Duration _retryBaseDelay = Duration(seconds: 1);

  /// Sends an HTTP request with exponential backoff on transient failures.
  /// Retries up to 3 attempts total (initial + 2 retries) with 1s/2s backoff
  /// on:
  ///   * [TimeoutException] — request took longer than the timeout
  ///   * [http.ClientException] — socket / DNS / connection refused
  ///   * 5xx server responses — server-side transient failure
  /// Does NOT retry 4xx responses (bad request, 401, etc.) — the caller's
  /// 401 refresh path handles auth, and 4xx bugs won't fix themselves.
  static Future<http.Response> _sendWithRetry(
    Future<http.Response> Function() send,
  ) async {
    Object? lastError;
    http.Response? lastResponse;
    for (var attempt = 1; attempt <= _maxRetryAttempts; attempt++) {
      try {
        final response = await send();
        lastResponse = response;
        // 5xx → retry; everything else (2xx, 3xx, 4xx) → return.
        if (response.statusCode < 500) return response;
        if (attempt >= _maxRetryAttempts) return response;
        if (kDebugMode) {
          debugPrint(
              'VHHttpClient: 5xx (${response.statusCode}) attempt $attempt — retrying');
        }
      } on TimeoutException catch (e) {
        lastError = e;
        if (attempt >= _maxRetryAttempts) rethrow;
        if (kDebugMode) {
          debugPrint('VHHttpClient: timeout attempt $attempt — retrying');
        }
      } on http.ClientException catch (e) {
        lastError = e;
        if (attempt >= _maxRetryAttempts) rethrow;
        if (kDebugMode) {
          debugPrint('VHHttpClient: network error attempt $attempt — retrying');
        }
      }
      // Exponential backoff: 1s, 2s.
      await Future<void>.delayed(_retryBaseDelay * (1 << (attempt - 1)));
    }
    // Unreachable in practice; the loop always returns/rethrows.
    if (lastResponse != null) return lastResponse;
    throw lastError ?? StateError('VHHttpClient retry loop exited abnormally');
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  static Future<Map<String, String>> _headers({bool auth = true, bool json = false}) async {
    if (auth && json) {
      return ApiConfig.authenticatedHeaders();
    } else if (auth) {
      return ApiConfig.authenticatedAuthHeaders();
    } else if (json) {
      return ApiConfig.jsonHeaders;
    }
    return ApiConfig.authHeaders;
  }

  static Uri _buildUri(String path, [Map<String, String>? queryParameters]) {
    final base = Uri.parse('${ApiConfig.baseUrl}$path');
    if (queryParameters != null && queryParameters.isNotEmpty) {
      return base.replace(queryParameters: queryParameters);
    }
    return base;
  }

  /// Parse HTTP response and check for 401.
  static ApiResponse _processResponse(http.Response response) {
    final parsed = ApiResponse.fromHttp(response);
    _checkUnauthorized(parsed);
    return parsed;
  }

  // ── Token refresh ────────────────────────────────────────────────────

  /// Single-flight guard: concurrent 401s await the same refresh call so
  /// the backend sees one rotation, not N.
  static Completer<bool>? _refreshInFlight;

  /// Attempt to refresh the JWT via `/auth/refresh-token`.
  ///
  /// - If a refresh token is stored (staff path), POSTs `{ refreshToken }`
  ///   in the body and parses both `accessToken` and a rotated `refreshToken`.
  /// - Otherwise (patient/admin path), POSTs with the bearer token header
  ///   and parses `token` or `accessToken` from the response.
  ///
  /// Returns `true` if a new access token was stored, `false` otherwise.
  /// Concurrent callers share a single in-flight refresh.
  /// Test-only hook to invoke [_tryRefreshToken] without going through a
  /// full request/401/retry cycle.
  @visibleForTesting
  static Future<bool> debugTryRefreshToken() => _tryRefreshToken();

  /// Public entry point into the single-flight refresh. Shared by
  /// `RealtimeClient` so a WS 4001 closure refreshes the token once (rather
  /// than giving up) and reconnects with the rotated JWT. Concurrent callers
  /// join the same in-flight refresh — no duplicate requests to the backend.
  ///
  /// Returns `true` if a new access token is now stored and callers can
  /// retry; `false` if the refresh was rejected (stored tokens cleared +
  /// [onSessionExpired] fired).
  static Future<bool> refreshAuthToken() => _tryRefreshToken();

  static Future<bool> _tryRefreshToken() {
    final existing = _refreshInFlight;
    if (existing != null) return existing.future;

    final completer = Completer<bool>();
    _refreshInFlight = completer;

    _performRefresh().then((ok) {
      completer.complete(ok);
    }).catchError((Object e, StackTrace st) {
      if (kDebugMode) debugPrint('VHHttpClient: token refresh failed — $e');
      completer.complete(false);
    }).whenComplete(() {
      _refreshInFlight = null;
    });

    return completer.future;
  }

  static Future<bool> _performRefresh() async {
    final uri = _buildUri('/auth/refresh-token');
    final storedRefresh = await AuthService.getRefreshToken();

    // If we have a refresh token (staff path), send it in the body.
    // Otherwise fall back to bearer-based rotation (patient/admin path).
    final headers = storedRefresh != null && storedRefresh.isNotEmpty
        ? ApiConfig.jsonHeaders
        : await _headers(auth: true, json: true);
    final body = storedRefresh != null && storedRefresh.isNotEmpty
        ? jsonEncode({'refreshToken': storedRefresh})
        : null;

    final response = await _client
        .post(uri, headers: headers, body: body)
        .timeout(_defaultTimeout);
    final parsed = ApiResponse.fromHttp(response);
    if (!parsed.isSuccess) return false;

    final data = parsed.data;
    if (data is! Map) return false;

    final newAccess = (data['accessToken'] as String?) ?? (data['token'] as String?);
    if (newAccess == null || newAccess.isEmpty) return false;

    final rotatedRefresh = data['refreshToken'] as String?;
    await AuthService.setTokens(
      accessToken: newAccess,
      refreshToken: rotatedRefresh,
    );
    if (kDebugMode) debugPrint('VHHttpClient: token refreshed');
    return true;
  }

  /// If the response is 401, attempt a single token refresh.
  /// If refresh succeeds, the caller should retry the request.
  /// If refresh fails, clear stored tokens and notify the app to
  /// redirect to login.
  static Future<bool> _handleUnauthorized(ApiResponse response) async {
    if (!response.isUnauthorized) return false;

    final refreshed = await _tryRefreshToken();
    if (refreshed) return true; // caller should retry

    if (kDebugMode) {
      debugPrint('VHHttpClient: 401 Unauthorized — session expired');
    }
    // Clear both access + refresh — forces a full re-login.
    await AuthService.clearJwt();
    await AuthService.clearRefreshToken();
    onSessionExpired?.call(
      response.message ?? 'Session expired. Please log in again.',
    );
    return false;
  }

  /// If the response is 401, notify the app to redirect to login.
  static void _checkUnauthorized(ApiResponse response) {
    if (response.isUnauthorized) {
      if (kDebugMode) {
        debugPrint('VHHttpClient: 401 Unauthorized — session expired');
      }
      onSessionExpired?.call(response.message ?? 'Session expired. Please log in again.');
    }
  }
}
