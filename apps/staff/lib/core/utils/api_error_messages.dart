import 'package:flutter/widgets.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/utils/request_reference.dart';

import '../../l10n/app_strings.dart';
export 'api_error_codes.dart';

import 'api_error_codes.dart';
import 'localized_failure.dart';

String? localizedApiErrorForCode(AppStrings strings, String? code) {
  return switch (code) {
    clinicalWriteDesktopOnlyCode => strings.errorClinicalWriteDesktopOnly,
    deviceTypeMissingCode => strings.errorDeviceTypeMissing,
    _ => null,
  };
}

String localizedApiFailureMessage(
  BuildContext context,
  ApiResponse response, [
  String? fallback,
]) {
  final strings = AppStrings.of(context);
  final mapped = localizedApiErrorForCode(strings, response.code);
  if (mapped != null) {
    return formatErrorWithRequestRef(mapped, requestId: response.requestId);
  }
  return localizedApiErrorFromRaw(
    strings,
    response,
    fallback: fallback ?? strings.errorSomethingWentWrong,
  );
}

String localizedApiErrorFromRaw(
  AppStrings strings,
  dynamic raw, {
  String? fallback,
  bool queued = false,
}) {
  if (raw is LocalizedFailure) {
    return localizedApiErrorFromRaw(
      strings,
      raw.localizationSource,
      fallback: strings.lookup(raw.fallbackLocalizationKey),
      queued: queued,
    );
  }
  final message = _messageFromRaw(
    raw,
    fallback: fallback ?? strings.errorSomethingWentWrong,
  );
  final requestId = _requestIdFromRaw(raw) ?? _requestRefFromMessage(message);
  final mapped = localizedApiErrorForCode(strings, apiErrorCodeFromRaw(raw));
  if (mapped != null) {
    return formatErrorWithRequestRef(mapped, requestId: requestId);
  }

  if (_looksOffline(raw, message)) {
    return queued ? strings.errorOfflineQueued : strings.errorOfflineWillRetry;
  }

  if (_statusCodeFromRaw(raw) == 403 || _looksForbidden(message)) {
    return formatErrorWithRequestRef(
      strings.errorPermissionDenied,
      requestId: requestId,
    );
  }

  final clean = stripExceptionPrefix(message);
  if (clean.isEmpty) return fallback ?? strings.errorSomethingWentWrong;
  return clean;
}

String stripExceptionPrefix(String message) {
  var clean = message.trim();
  while (clean.startsWith('Exception: ')) {
    clean = clean.substring('Exception: '.length).trimLeft();
  }
  return clean;
}

String _messageFromRaw(dynamic raw, {required String fallback}) {
  if (raw is ApiResponse) return raw.failureMessage(fallback);
  if (raw is Map) {
    final message = (raw['message'] ?? raw['error'])?.toString().trim();
    if (message != null && message.isNotEmpty) return message;
  }
  final text = raw?.toString().trim();
  return text == null || text.isEmpty ? fallback : text;
}

String? _requestIdFromRaw(dynamic raw) {
  if (raw is ApiResponse) return raw.requestId;
  if (raw is Map) {
    final value =
        raw['requestId'] ??
        raw['request_id'] ??
        raw['request-id'] ??
        raw['x-request-id'];
    final text = value?.toString().trim();
    return text == null || text.isEmpty ? null : text;
  }
  return null;
}

int? _statusCodeFromRaw(dynamic raw) {
  if (raw is ApiResponse) return raw.statusCode;
  if (raw is Map) {
    final value = raw['statusCode'] ?? raw['status_code'] ?? raw['status'];
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '');
  }
  final match = RegExp(r'\b(403)\b').firstMatch(raw?.toString() ?? '');
  return match == null ? null : int.tryParse(match.group(1)!);
}

String? _requestRefFromMessage(String message) {
  final match = RegExp(
    r'\bref\s+([A-Za-z0-9._:-]{4,64})\b',
    caseSensitive: false,
  ).firstMatch(message);
  return match?.group(1);
}

bool _looksForbidden(String message) {
  final text = stripExceptionPrefix(message).toLowerCase();
  return text.contains('403 forbidden') ||
      text == 'forbidden' ||
      text.contains('permission denied') ||
      text.contains('not authorized') ||
      text.contains('unauthorized for this action');
}

bool _looksOffline(dynamic raw, String message) {
  final text = '${raw?.runtimeType ?? ''} $message ${raw ?? ''}'.toLowerCase();
  return text.contains('socketexception') ||
      text.contains('failed host lookup') ||
      text.contains('network is unreachable') ||
      text.contains('connection refused') ||
      text.contains('connection reset') ||
      text.contains('connection timed out') ||
      text.contains('networkexception') ||
      text.contains('clientexception') ||
      text.contains('failed to fetch') ||
      text.contains('xmlhttprequest error');
}
