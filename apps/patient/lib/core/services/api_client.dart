// lib/core/services/api_client.dart
//
// Thin façade over `vhhealth_core.VHHttpClient`. All HTTP + JWT refresh + 401
// single-flight + retry logic lives in core; this file exists so existing
// call sites (`ApiClient.get(...)`) keep compiling. The only patient-specific
// extension is [cachedGet] — offline-first wrapper tied to the patient app's
// [ApiCacheManager] and [ConnectivityService].
//
// Deprecation path: migrate individual call sites to `VHHttpClient.xxx`
// directly when convenient. `cachedGet` stays here because its caching
// strategy is patient-specific.

import 'package:http/http.dart' as http;
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

export 'package:vhhealth_core/models/api_response.dart'
    show ApiResponse, CachedApiResponse;

class ApiClient {
  ApiClient._();

  /// Registered once at startup (see `main.dart`). Forwards to
  /// [VHHttpClient.onSessionExpired] so the same refresh/relogin flow
  /// owns HTTP + realtime WS auth.
  static set onSessionExpired(void Function(String? message)? cb) {
    VHHttpClient.onSessionExpired = cb;
  }

  // ── Delegated HTTP methods ────────────────────────────────────────────────

  static Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
    Duration? timeout,
  }) async {
    if (!await _allowLiveRead()) return _outageReadUnavailable();
    return _observe(
      () => VHHttpClient.get(
        path,
        queryParameters: queryParameters,
        timeout: timeout,
      ),
    );
  }

  static Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
    String? idempotencyKey,
  }) => _mutate(
    'POST',
    path,
    () => VHHttpClient.post(
      path,
      body: body,
      timeout: timeout,
      idempotencyKey: idempotencyKey,
    ),
  );

  static Future<ApiResponse> put(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
    String? idempotencyKey,
  }) => _mutate(
    'PUT',
    path,
    () => VHHttpClient.put(
      path,
      body: body,
      timeout: timeout,
      idempotencyKey: idempotencyKey,
    ),
  );

  static Future<ApiResponse> patch(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
    String? idempotencyKey,
  }) => _mutate(
    'PATCH',
    path,
    () => VHHttpClient.patch(
      path,
      body: body,
      timeout: timeout,
      idempotencyKey: idempotencyKey,
    ),
  );

  static Future<ApiResponse> delete(
    String path, {
    Map<String, dynamic>? body,
    Duration? timeout,
    String? idempotencyKey,
  }) => _mutate(
    'DELETE',
    path,
    () => VHHttpClient.delete(
      path,
      body: body,
      timeout: timeout,
      idempotencyKey: idempotencyKey,
    ),
  );

  static Future<ApiResponse> multipart(
    String path, {
    Map<String, String> fields = const {},
    List<http.MultipartFile> files = const [],
    Future<List<http.MultipartFile>> Function()? fileBuilder,
    Duration? timeout,
  }) => _mutate(
    'MULTIPART',
    path,
    () => VHHttpClient.multipart(
      path,
      fields: fields,
      files: files,
      fileBuilder: fileBuilder,
      timeout: timeout,
    ),
  );

  static String failureMessage(ApiResponse response, String fallback) {
    return response.failureMessage(fallback);
  }

  // ── Patient-specific: cache-first GET ─────────────────────────────────────

  /// Returns cached data immediately (if available, fresh-or-stale), then
  /// fetches fresh data in the background and updates the cache. Used by
  /// the dashboard + record-list screens for snappy offline-first UX.
  ///
  /// Returns [CachedApiResponse]:
  ///   * `response` — immediately available payload (cached or live)
  ///   * `fromCache` — true when `response` was served from disk
  ///   * `staleLabel` — human-readable "2 hours ago" when serving stale
  ///   * `onFresh` — a future for the network response, when the cached
  ///     copy was fresh enough that we returned it synchronously
  static Future<CachedApiResponse> cachedGet(
    String path, {
    Map<String, String>? queryParameters,
    Duration? timeout,
    Duration cacheTtl = ApiCacheManager.defaultTtl,
  }) async {
    final cacheKey = queryParameters != null && queryParameters.isNotEmpty
        ? '${path}_${queryParameters.entries.map((e) => '${e.key}=${e.value}').join('_')}'
        : path;

    final controller = PatientOutageController.instance;
    if (controller.status == PatientOutageStatus.signedOut) {
      await controller.refreshForCurrentSession();
    }
    if (controller.status == PatientOutageStatus.signedOut) {
      return CachedApiResponse(
        response: const ApiResponse(
          statusCode: 401,
          isSuccess: false,
          code: 'PATIENT_SIGNED_OUT_NO_CACHE',
          raw: {'code': 'PATIENT_SIGNED_OUT_NO_CACHE'},
        ),
        fromCache: false,
        staleLabel: null,
      );
    }

    final cached = await ApiCacheManager.load(cacheKey);

    if (!ConnectivityService.isOnline ||
        controller.isOutage ||
        controller.isChecking) {
      if (cached != null) {
        return CachedApiResponse(
          response: ApiResponse(
            statusCode: 200,
            isSuccess: true,
            data: cached.data,
            raw: {'data': cached.data},
            message: null,
          ),
          fromCache: true,
          staleLabel: cached.ageLabel,
          cachedAt: cached.cachedAt,
        );
      }
      return CachedApiResponse(
        response: ApiResponse(
          statusCode: 0,
          isSuccess: false,
          data: null,
          raw: null,
          message: 'No internet connection',
        ),
        fromCache: false,
        staleLabel: null,
      );
    }

    if (cached != null && !cached.isStale(cacheTtl)) {
      // Cache is fresh — return immediately, refresh in background.
      final freshFuture =
          get(path, queryParameters: queryParameters, timeout: timeout)
              .then((response) async {
                if (response.isSuccess) {
                  await ApiCacheManager.save(cacheKey, response.data);
                }
                return response;
              })
              .catchError(
                (_) => ApiResponse(
                  statusCode: 0,
                  isSuccess: false,
                  data: cached.data,
                  raw: null,
                  message: 'Background refresh failed',
                ),
              );

      return CachedApiResponse(
        response: ApiResponse(
          statusCode: 200,
          isSuccess: true,
          data: cached.data,
          raw: {'data': cached.data},
          message: null,
        ),
        fromCache: true,
        staleLabel: null,
        cachedAt: cached.cachedAt,
        onFresh: freshFuture,
      );
    }

    // Cache is stale or missing — fetch live, fall back to stale cache on error.
    try {
      final response = await get(
        path,
        queryParameters: queryParameters,
        timeout: timeout,
      );
      if (response.isSuccess) {
        final savedAt = await ApiCacheManager.save(cacheKey, response.data);
        return CachedApiResponse(
          response: response,
          fromCache: false,
          staleLabel: null,
          cachedAt: savedAt,
        );
      }
      if (controller.isOutage && cached != null) {
        return CachedApiResponse(
          response: ApiResponse(
            statusCode: 200,
            isSuccess: true,
            data: cached.data,
            raw: {'data': cached.data},
          ),
          fromCache: true,
          staleLabel: cached.ageLabel,
          cachedAt: cached.cachedAt,
        );
      }
      return CachedApiResponse(
        response: response,
        fromCache: false,
        staleLabel: null,
      );
    } catch (e) {
      if (cached != null) {
        return CachedApiResponse(
          response: ApiResponse(
            statusCode: 200,
            isSuccess: true,
            data: cached.data,
            raw: {'data': cached.data},
            message: null,
          ),
          fromCache: true,
          staleLabel: cached.ageLabel,
          cachedAt: cached.cachedAt,
        );
      }
      rethrow;
    }
  }

  static Future<bool> _allowLiveRead() async {
    final controller = PatientOutageController.instance;
    if (controller.status == PatientOutageStatus.signedOut) {
      await controller.refreshForCurrentSession();
    }
    return !controller.isOutage && !controller.isChecking;
  }

  static Future<ApiResponse> _mutate(
    String method,
    String path,
    Future<ApiResponse> Function() send,
  ) async {
    final controller = PatientOutageController.instance;
    if (controller.status == PatientOutageStatus.signedOut) {
      await controller.refreshForCurrentSession();
    }
    if (controller.blocksHospitalMutations) {
      controller.reportBlockedMutation(method, path);
      return _outageMutationBlocked();
    }
    return _observe(send);
  }

  static Future<ApiResponse> _observe(
    Future<ApiResponse> Function() send,
  ) async {
    try {
      final response = await send();
      await PatientOutageController.instance.observeResponse(response);
      return _withFailureReference(response);
    } catch (_) {
      PatientOutageController.instance.observeTransportFailure();
      rethrow;
    }
  }

  static ApiResponse _outageReadUnavailable() => const ApiResponse(
    statusCode: 503,
    isSuccess: false,
    raw: {'code': 'PATIENT_OUTAGE_CACHE_ONLY'},
    code: 'PATIENT_OUTAGE_CACHE_ONLY',
  );

  static ApiResponse _outageMutationBlocked() => const ApiResponse(
    statusCode: 503,
    isSuccess: false,
    raw: {'code': 'PATIENT_OUTAGE_MUTATION_BLOCKED'},
    code: 'PATIENT_OUTAGE_MUTATION_BLOCKED',
  );

  static ApiResponse _withFailureReference(ApiResponse response) {
    if (response.isSuccess) return response;

    final message = response.message;
    if (message == null || message.trim().isEmpty) return response;

    final displayMessage = response.failureMessage();
    if (displayMessage == message) return response;

    return ApiResponse(
      statusCode: response.statusCode,
      isSuccess: response.isSuccess,
      data: response.data,
      raw: response.raw,
      message: displayMessage,
      code: response.code,
      requestId: response.requestId,
    );
  }
}
