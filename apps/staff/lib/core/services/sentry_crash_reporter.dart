// ignore_for_file: deprecated_member_use

import 'package:sentry_flutter/sentry_flutter.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';

import 'phi_scrubber.dart';

class SentryCrashReporter implements CrashReporter {
  const SentryCrashReporter();

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    Map<String, Object?> extra = const {},
    bool fatal = false,
  }) async {
    try {
      await Sentry.captureException(
        PhiScrubber.sanitizeError(error),
        stackTrace: stack,
        withScope: (scope) async {
          await scope.setTag('fatal', fatal.toString());
          if (context != null || extra.isNotEmpty) {
            await scope.setContexts('vhhealth', {
              if (context != null) 'context': PhiScrubber.scrubText(context),
              if (extra.isNotEmpty) 'extra': PhiScrubber.scrubMap(extra),
            });
          }
        },
      );
    } catch (_) {}
  }

  @override
  Future<void> log(String message) async {
    try {
      await Sentry.addBreadcrumb(
        Breadcrumb(
          message: PhiScrubber.scrubText(message),
          category: 'app.log',
          level: SentryLevel.info,
        ),
      );
    } catch (_) {}
  }

  @override
  Future<void> setUserId(String? userId) async {
    try {
      await Sentry.configureScope((scope) async {
        if (userId == null || userId.trim().isEmpty) {
          await scope.setUser(null);
          return;
        }
        await scope.setUser(SentryUser(id: PhiScrubber.scrubText(userId)));
      });
    } catch (_) {}
  }

  @override
  Future<void> setCustomKey(String key, Object value) async {
    try {
      await Sentry.configureScope((scope) async {
        await scope.setTag(key, PhiScrubber.scrubObject(value).toString());
      });
    } catch (_) {}
  }

  static SentryEvent? scrubEvent(SentryEvent event, Hint hint) {
    return _scrubEvent(event);
  }

  static SentryTransaction? scrubTransaction(SentryTransaction transaction) {
    return _scrubTransaction(transaction);
  }

  static Breadcrumb? scrubBreadcrumb(Breadcrumb? breadcrumb, Hint hint) {
    if (breadcrumb == null) return null;
    final data = breadcrumb.data == null
        ? null
        : Map<String, dynamic>.from(
            PhiScrubber.scrubObject(breadcrumb.data) as Map,
          );
    return breadcrumb.copyWith(
      message: breadcrumb.message == null
          ? null
          : PhiScrubber.scrubText(breadcrumb.message),
      category: breadcrumb.category == null
          ? null
          : PhiScrubber.scrubText(breadcrumb.category),
      data: data,
    );
  }

  static SentryEvent _scrubEvent(SentryEvent event) {
    return event.copyWith(
      transaction: event.transaction == null
          ? null
          : PhiScrubber.normalizePath(event.transaction),
      message: _scrubMessage(event.message),
      throwable: event.throwable == null
          ? null
          : PhiScrubber.sanitizeError(event.throwable),
      tags: _scrubTags(event.tags),
      // ignore: deprecated_member_use_from_same_package
      extra: _scrubExtra(event.extra),
      user: _safeUser(event.user),
      request: _safeRequest(event.request),
      breadcrumbs: event.breadcrumbs
          ?.map((breadcrumb) => scrubBreadcrumb(breadcrumb, Hint()))
          .whereType<Breadcrumb>()
          .toList(growable: false),
      exceptions: event.exceptions
          ?.map(_scrubException)
          .toList(growable: false),
    );
  }

  static SentryTransaction _scrubTransaction(SentryTransaction transaction) {
    return transaction.copyWith(
      transaction: PhiScrubber.normalizePath(transaction.transaction),
      tags: _scrubTags(transaction.tags),
      // ignore: deprecated_member_use_from_same_package
      extra: _scrubExtra(transaction.extra),
      user: _safeUser(transaction.user),
      request: _safeRequest(transaction.request),
      breadcrumbs: transaction.breadcrumbs
          ?.map((breadcrumb) => scrubBreadcrumb(breadcrumb, Hint()))
          .whereType<Breadcrumb>()
          .toList(growable: false),
    );
  }

  static SentryMessage? _scrubMessage(SentryMessage? message) {
    if (message == null) return null;
    return message.copyWith(
      formatted: PhiScrubber.scrubText(message.formatted),
      template: message.template == null
          ? null
          : PhiScrubber.scrubText(message.template),
      params: message.params
          ?.map((item) => PhiScrubber.scrubObject(item))
          .toList(growable: false),
    );
  }

  static SentryException _scrubException(SentryException exception) {
    return exception.copyWith(
      value: exception.value == null
          ? null
          : PhiScrubber.scrubText(exception.value),
      throwable: exception.throwable == null
          ? null
          : PhiScrubber.sanitizeError(exception.throwable),
    );
  }

  static SentryRequest? _safeRequest(SentryRequest? request) {
    if (request == null) return null;
    return SentryRequest(
      url: request.url == null ? null : PhiScrubber.normalizePath(request.url),
      method: request.method,
      headers: PhiScrubber.scrubStringMap(request.headers),
      apiTarget: request.apiTarget,
    );
  }

  static SentryUser? _safeUser(SentryUser? user) {
    if (user == null) return null;
    final rawId = user.id?.trim();
    final id = rawId == null || rawId.isEmpty
        ? '[REDACTED_USER]'
        : PhiScrubber.scrubText(rawId);
    return SentryUser(id: id);
  }

  static Map<String, String>? _scrubTags(Map<String, String>? tags) {
    if (tags == null) return null;
    return tags.map(
      (key, value) =>
          MapEntry(PhiScrubber.scrubText(key), PhiScrubber.scrubText(value)),
    );
  }

  static Map<String, dynamic>? _scrubExtra(Map<String, dynamic>? extra) {
    if (extra == null) return null;
    return Map<String, dynamic>.from(PhiScrubber.scrubObject(extra) as Map);
  }
}
