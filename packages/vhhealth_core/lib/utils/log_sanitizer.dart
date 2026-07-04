String logSafePath(Object? value) {
  final raw = value?.toString().trim() ?? '';
  if (raw.isEmpty) return '<empty>';

  final uri = Uri.tryParse(raw);
  var path = uri != null && uri.hasScheme ? uri.path : raw;
  if (path.isEmpty) path = '/';

  path = _stripQueryAndFragment(path);
  path = path.replaceFirst(RegExp(r'^as_.+?__'), '');
  path = path.replaceFirst(RegExp(r'_[^/_\s?=]+=.*$'), '');
  return redactLogText(path);
}

String logSafeError(Object? error) => redactLogText(error);

String redactLogText(Object? value) {
  var text = value?.toString() ?? '';
  if (text.isEmpty) return text;

  text = text.replaceAllMapped(
    RegExp(r'([?&][A-Za-z0-9_.-]+=)[^\s&#,)]*'),
    (match) => '${match.group(1)}<redacted>',
  );
  text = text.replaceAll(
    RegExp(r'\bBearer\s+[A-Za-z0-9._~+/=-]+', caseSensitive: false),
    'Bearer <redacted>',
  );
  text = text.replaceAll(
    RegExp(r'\bAuthorization\s*[:=]\s*[^,\s)}]+', caseSensitive: false),
    'Authorization=<redacted>',
  );
  text = text.replaceAllMapped(
    RegExp(
      r'\b(token|accessToken|refreshToken|jwt|fcmToken|idToken|phone|mobile|email|abhaNumber|otp)\s*[:=]\s*[^,&\s)}]+',
      caseSensitive: false,
    ),
    (match) => '${match.group(1)}=<redacted>',
  );
  text = text.replaceAll(
    RegExp(r'\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b'),
    '<redacted-jwt>',
  );
  text = text.replaceAll(RegExp(r'[\w.+-]+@[\w.-]+\.\w+'), '<redacted-email>');
  text = text.replaceAllMapped(
    RegExp(r'(^|[^0-9])([0-9]{10,15})(?=$|[^0-9])'),
    (match) => '${match.group(1)}<redacted-number>',
  );
  return text;
}

String _stripQueryAndFragment(String value) {
  var stripped = value;
  final queryIndex = stripped.indexOf('?');
  if (queryIndex != -1) stripped = stripped.substring(0, queryIndex);
  final fragmentIndex = stripped.indexOf('#');
  if (fragmentIndex != -1) stripped = stripped.substring(0, fragmentIndex);
  return stripped;
}
