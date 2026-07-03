import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/api_response.dart';
import 'auth_service.dart';
import 'pinned_http_client.dart';
import 'idempotency_key.dart';

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

  /// When set, returns the UID the current request should be made on
  /// behalf of (e.g. a guardian acting as their minor dependent). When
  /// non-null + non-empty the resolver's return value is sent as the
  /// `X-Acting-As-Uid` header on every authenticated request. The
  /// backend's `jwtMiddleware` verifies guardianship + tenant parity
  /// before rewriting `req.user` to the dependent — see the acting-as
  /// delegation chip (2026-05-13).
  ///
  /// Returning `null` (or an empty string) disables delegation for the
  /// next request — exactly what the "switch back to my profile" UX
  /// action does.
  static String? Function()? actingAsUidProvider;

  /// Optional app-level device type provider.
  ///
  /// Staff sets this to its detected app/device mode so every request carries
  /// an `X-Device-Type` hint for audit correlation. The backend still treats
  /// the JWT/session `deviceType` claim as authoritative for security gates.
  static String? Function()? deviceTypeProvider;

  // ── Injectable HTTP client (for tests) ─────────────────────────────────
  // Default: the SPKI-pinned production client (audit finding H7 — the
  // pinner existed but was never wired in; all traffic went through a plain
  // http.Client). createPinnedHttpClient() returns a plain client in dev
  // builds and on web; in --dart-define=PRODUCTION=true mobile builds it is
  // an IOClient pinned to CERT_PIN_HASHES and restricted to the API host.
  static http.Client _client = createPinnedHttpClient();

  /// Replace the internal [http.Client] with a mock for testing.
  /// Always pair with [resetClientForTesting] in tearDown.
  @visibleForTesting
  static void setClientForTesting(http.Client client) {
    _client = client;
  }

  /// Restore the default (pinned) client. Call in test tearDown.
  @visibleForTesting
  static void resetClientForTesting() {
    _client = createPinnedHttpClient();
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
      () => _client
          .get(uri, headers: headers)
          .timeout(timeout ?? _defaultTimeout),
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

  /// Authenticated GET for binary payloads such as PDFs. Uses the same
  /// headers, retry, and 401 refresh path as [get], but returns the raw
  /// [http.Response] so callers can consume [http.Response.bodyBytes].
  static Future<http.Response> getBytes(
    String path, {
    Map<String, String>? queryParameters,
    bool auth = true,
    Duration? timeout,
  }) async {
    final uri = _buildUri(path, queryParameters);
    final headers = await _headers(auth: auth);
    final response = await _sendWithRetry(
      () => _client
          .get(uri, headers: headers)
          .timeout(timeout ?? _defaultTimeout),
    );
    if (auth && response.statusCode == 401) {
      final parsed = ApiResponse.fromHttp(response);
      if (!await _handleUnauthorized(parsed)) {
        _checkUnauthorized(parsed);
        return response;
      }
      final retryHeaders = await _headers(auth: true);
      final retry = await _sendWithRetry(
        () => _client
            .get(uri, headers: retryHeaders)
            .timeout(timeout ?? _defaultTimeout),
      );
      if (retry.statusCode == 401) {
        _checkUnauthorized(ApiResponse.fromHttp(retry));
      }
      return retry;
    }

    return response;
  }

  /// Authenticated POST request with JSON body. Automatically retries once
  /// on 401 after refreshing the JWT token.
  ///
  /// Pass [idempotencyKey] to send an `Idempotency-Key` header so the backend
  /// de-duplicates replays of this mutation. The retry/refresh paths reuse the
  /// SAME key across every attempt (it is fixed once by the caller, not
  /// regenerated per attempt), which is what makes a lost-2xx retry safe.
  static Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
    String? idempotencyKey,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    // Auto-mint a stable Idempotency-Key when the caller passed none, so a
    // _sendWithRetry / 401 replay reuses it and the backend dedups the write
    // instead of double-creating. Covered routes dedup; others ignore it.
    final effectiveKey = idempotencyKey ?? IdempotencyKey.generate();
    final headers = await _headers(
      auth: auth,
      json: true,
      idempotencyKey: effectiveKey,
    );
    final response = await _sendWithRetry(
      () => _client
          .post(uri, headers: headers, body: encoded)
          .timeout(timeout ?? _defaultTimeout),
    );
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(
        auth: true,
        json: true,
        idempotencyKey: effectiveKey,
      );
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
  ///
  /// Pass [idempotencyKey] to send an `Idempotency-Key` header (reused across
  /// retries) so the backend de-duplicates replays of this mutation.
  static Future<ApiResponse> put(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
    String? idempotencyKey,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    final effectiveKey = idempotencyKey ?? IdempotencyKey.generate();
    final headers = await _headers(
      auth: auth,
      json: true,
      idempotencyKey: effectiveKey,
    );
    final response = await _sendWithRetry(
      () => _client
          .put(uri, headers: headers, body: encoded)
          .timeout(timeout ?? _defaultTimeout),
    );
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(
        auth: true,
        json: true,
        idempotencyKey: effectiveKey,
      );
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
  ///
  /// Pass [idempotencyKey] to send an `Idempotency-Key` header (reused across
  /// retries) so the backend de-duplicates replays of this mutation.
  static Future<ApiResponse> patch(
    String path, {
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
    String? idempotencyKey,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    final effectiveKey = idempotencyKey ?? IdempotencyKey.generate();
    final headers = await _headers(
      auth: auth,
      json: true,
      idempotencyKey: effectiveKey,
    );
    final response = await _sendWithRetry(
      () => _client
          .patch(uri, headers: headers, body: encoded)
          .timeout(timeout ?? _defaultTimeout),
    );
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(
        auth: true,
        json: true,
        idempotencyKey: effectiveKey,
      );
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
    Map<String, dynamic>? body,
    bool auth = true,
    Duration? timeout,
    String? idempotencyKey,
  }) async {
    final uri = _buildUri(path);
    final encoded = body != null ? jsonEncode(body) : null;
    final effectiveKey =
        idempotencyKey ?? (body != null ? IdempotencyKey.generate() : null);
    final headers = await _headers(
      auth: auth,
      json: body != null,
      idempotencyKey: effectiveKey,
    );
    final response = await _sendWithRetry(
      () => _client
          .delete(uri, headers: headers, body: encoded)
          .timeout(timeout ?? _defaultTimeout),
    );
    final parsed = ApiResponse.fromHttp(response);

    if (auth && parsed.isUnauthorized && await _handleUnauthorized(parsed)) {
      final retryHeaders = await _headers(
        auth: true,
        json: body != null,
        idempotencyKey: effectiveKey,
      );
      final retry = await _sendWithRetry(
        () => _client
            .delete(uri, headers: retryHeaders, body: encoded)
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
      final streamed = await _client
          .send(req)
          .timeout(timeout ?? _uploadTimeout);
      final body = await streamed.stream.bytesToString();
      return ApiResponse.fromStreamed(streamed, body);
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
            'VHHttpClient: 5xx (${response.statusCode}) attempt $attempt — retrying',
          );
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

  static Future<Map<String, String>> _headers({
    bool auth = true,
    bool json = false,
    String? idempotencyKey,
  }) async {
    final Map<String, String> base;
    if (auth && json) {
      base = await ApiConfig.authenticatedHeaders();
    } else if (auth) {
      base = await ApiConfig.authenticatedAuthHeaders();
    } else if (json) {
      base = Map<String, String>.from(ApiConfig.jsonHeaders);
    } else {
      base = Map<String, String>.from(ApiConfig.authHeaders);
    }

    // Idempotency-Key — attached on mutating requests (POST/PUT/PATCH) so the
    // backend collapses a retried lost-2xx into the original response instead
    // of duplicating the write. The SAME key is reused across in-process
    // retries and offline-queue redrains (finding #15).
    if (idempotencyKey != null && idempotencyKey.isNotEmpty) {
      base['Idempotency-Key'] = idempotencyKey;
    }

    // Acting-as delegation header — only attached on authenticated calls.
    // The provider is null for staff/admin (and for guardians on their
    // own profile); when set + non-empty the backend rewrites req.user
    // to the named dependent.
    if (auth) {
      final actingAsUid = actingAsUidProvider?.call();
      if (actingAsUid != null && actingAsUid.isNotEmpty) {
        base['X-Acting-As-Uid'] = actingAsUid;
      }
    }

    final deviceType = _normalizedDeviceType(deviceTypeProvider?.call());
    if (deviceType != null) {
      base['X-Device-Type'] = deviceType;
    }

    return base;
  }

  static const Set<String> _allowedDeviceTypes = {
    'mobile',
    'tablet',
    'desktop',
    'web',
  };

  static String? _normalizedDeviceType(String? value) {
    final normalized = value?.trim().toLowerCase();
    if (normalized == null || normalized.isEmpty) return null;
    return _allowedDeviceTypes.contains(normalized) ? normalized : null;
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

    _performRefresh()
        .then((ok) {
          completer.complete(ok);
        })
        .catchError((Object e, StackTrace st) {
          if (kDebugMode) debugPrint('VHHttpClient: token refresh failed — $e');
          completer.complete(false);
        })
        .whenComplete(() {
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
        ? await _headers(auth: false, json: true)
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

    final newAccess =
        (data['accessToken'] as String?) ?? (data['token'] as String?);
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
      onSessionExpired?.call(
        response.message ?? 'Session expired. Please log in again.',
      );
    }
  }
}
