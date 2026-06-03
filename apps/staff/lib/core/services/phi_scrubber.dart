class PhiScrubber {
  PhiScrubber._();

  static final _emailPattern = RegExp(
    r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
  );
  static final _phonePattern = RegExp(
    r'(^|[^\d])(?:\+?91[\s-]?)?\d[\d\s-]{8,12}\d(?=$|[^\d])',
  );
  static final _hospitalIdPattern = RegExp(
    r'\bVH-\d{4,}\b',
    caseSensitive: false,
  );
  static final _jwtPattern = RegExp(
    r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b',
  );
  static final _uuidPattern = RegExp(
    r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b',
    caseSensitive: false,
  );
  static final _numericPathSegmentPattern = RegExp(r'/\d{3,}(?=/|$)');
  static final _uuidPathSegmentPattern = RegExp(
    r'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=/|$)',
    caseSensitive: false,
  );
  static final _hospitalPathSegmentPattern = RegExp(
    r'/VH-\d{4,}(?=/|$)',
    caseSensitive: false,
  );
  static final _sensitiveKeyPattern = RegExp(
    r'password|passcode|pin|otp|token|secret|authorization|auth|cookie|api[-_ ]?key|phone|mobile|email|name|address|patient|diagnosis|symptom|note|clinical|medical|record|abha|aadhaar|mrn|hospital[-_ ]?id',
    caseSensitive: false,
  );

  static String scrubText(Object? value) {
    if (value == null) return '';
    var redacted = value.toString();
    redacted = redacted.replaceAll(_emailPattern, '[REDACTED_EMAIL]');
    redacted = redacted.replaceAllMapped(
      _phonePattern,
      (match) => '${match.group(1) ?? ''}[REDACTED_PHONE]',
    );
    redacted = redacted.replaceAll(_hospitalIdPattern, '[REDACTED_PATIENT_ID]');
    redacted = redacted.replaceAll(_jwtPattern, '[REDACTED_TOKEN]');
    redacted = redacted.replaceAll(_uuidPattern, '[REDACTED_ID]');
    return redacted;
  }

  static Object sanitizeError(Object error) {
    final redacted = scrubText(error);
    if (redacted == error.toString()) return error;
    return Exception(redacted);
  }

  static Object? scrubObject(Object? value, {String key = '', int depth = 0}) {
    if (value == null || value is num || value is bool) return value;
    if (key.isNotEmpty && _sensitiveKeyPattern.hasMatch(key)) {
      return '[REDACTED]';
    }
    if (value is String) return scrubText(value);
    if (depth >= 6) return '[REDACTED_DEPTH]';
    if (value is Map) {
      return value.map<String, Object?>((rawKey, rawValue) {
        final childKey = rawKey.toString();
        return MapEntry(
          scrubText(childKey),
          scrubObject(rawValue, key: childKey, depth: depth + 1),
        );
      });
    }
    if (value is Iterable) {
      return value
          .map((item) => scrubObject(item, depth: depth + 1))
          .toList(growable: false);
    }
    return scrubText(value);
  }

  static Map<String, Object?> scrubMap(Map<String, Object?> value) {
    return value.map((key, childValue) {
      return MapEntry(scrubText(key), scrubObject(childValue, key: key));
    });
  }

  static Map<String, String> scrubStringMap(Map<String, String> value) {
    return value.map((key, childValue) {
      if (_sensitiveKeyPattern.hasMatch(key)) {
        return MapEntry(scrubText(key), '[REDACTED]');
      }
      return MapEntry(scrubText(key), scrubText(childValue));
    });
  }

  static String normalizePath(Object? value) {
    if (value == null) return '';
    final raw = value.toString();
    final parsed = Uri.tryParse(raw);
    var path = parsed?.path.isNotEmpty == true ? parsed!.path : raw;
    path = path.split('?').first.split('#').first;
    if (path.isEmpty) return '/';
    path = path
        .replaceAll(_uuidPathSegmentPattern, '/:uuid')
        .replaceAll(_hospitalPathSegmentPattern, '/:hospitalId')
        .replaceAll(_numericPathSegmentPattern, '/:id');
    return scrubText(path);
  }
}
