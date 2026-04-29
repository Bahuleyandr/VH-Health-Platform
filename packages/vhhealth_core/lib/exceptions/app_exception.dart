class AppException implements Exception {
  final String message;
  final int? statusCode;
  final Object? cause;

  const AppException(this.message, {this.statusCode, this.cause});

  @override
  String toString() =>
      'AppException(statusCode: $statusCode, message: $message)';
}
