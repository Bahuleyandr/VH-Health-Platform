import 'package:flutter/widgets.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_core/utils/request_reference.dart';

import '../../l10n/app_strings.dart';
export 'api_error_codes.dart';

import 'api_error_codes.dart';

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
  return response.failureMessage(fallback ?? strings.errorSomethingWentWrong);
}

String localizedApiErrorFromRaw(
  AppStrings strings,
  dynamic raw, {
  String? fallback,
}) {
  final mapped = localizedApiErrorForCode(strings, apiErrorCodeFromRaw(raw));
  if (mapped != null) return mapped;
  if (raw is ApiResponse) {
    return raw.failureMessage(fallback ?? strings.errorSomethingWentWrong);
  }
  if (raw is Map) {
    final message = (raw['message'] ?? raw['error'])?.toString().trim();
    if (message != null && message.isNotEmpty) return message;
  }
  return fallback ?? strings.errorSomethingWentWrong;
}
