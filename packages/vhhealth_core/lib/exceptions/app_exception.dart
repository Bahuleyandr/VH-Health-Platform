import '../utils/request_reference.dart';

class AppException implements Exception {
  final String message;
  final int? statusCode;
  final Object? cause;
  final String? requestId;

  const AppException(
    this.message, {
    this.statusCode,
    this.cause,
    this.requestId,
  });

  String get displayMessage =>
      formatErrorWithRequestRef(message, requestId: requestId);

  @override
  String toString() =>
      'AppException(statusCode: $statusCode, message: $displayMessage)';
}
