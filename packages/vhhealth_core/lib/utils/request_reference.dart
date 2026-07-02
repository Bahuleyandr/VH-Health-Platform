String? shortRequestReference(String? requestId) {
  final normalized = requestId?.trim();
  if (normalized == null || normalized.isEmpty) return null;
  return normalized.length <= 8 ? normalized : normalized.substring(0, 8);
}

String formatErrorWithRequestRef(String message, {String? requestId}) {
  final clean = message.trim();
  final ref = shortRequestReference(requestId);
  if (ref == null) return clean;
  final existing = RegExp(
    r'\bref\s+' + RegExp.escape(ref) + r'\b',
    caseSensitive: false,
  );
  if (existing.hasMatch(clean)) return clean;
  return '$clean · ref $ref';
}
