abstract interface class LocalizedFailure {
  String get fallbackLocalizationKey;
  Object? get localizationSource;
}

class LocalizedApiFailure implements Exception, LocalizedFailure {
  const LocalizedApiFailure({
    required this.fallbackLocalizationKey,
    this.localizationSource,
    this.diagnosticMessage,
  });

  @override
  final String fallbackLocalizationKey;

  @override
  final Object? localizationSource;

  final String? diagnosticMessage;

  @override
  String toString() => diagnosticMessage ?? fallbackLocalizationKey;
}
