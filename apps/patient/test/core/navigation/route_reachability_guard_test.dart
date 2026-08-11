import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/navigation/route_reachability.dart';

Set<String> _matches(String source, RegExp pattern) =>
    pattern.allMatches(source).map((match) => match.group(1)!).toSet();

bool _resolves(String route, Set<String> patterns) {
  final routeParts = route.split('/');
  return patterns.any((pattern) {
    final patternParts = pattern.split('/');
    if (routeParts.length != patternParts.length) return false;
    for (var index = 0; index < routeParts.length; index += 1) {
      final routePart = routeParts[index];
      if (!patternParts[index].startsWith(':') &&
          !routePart.contains(r'${') &&
          patternParts[index] != routePart) {
        return false;
      }
    }
    return true;
  });
}

Iterable<File> _dartFiles(Directory directory) sync* {
  for (final entity in directory.listSync(recursive: true)) {
    if (entity is File && entity.path.endsWith('.dart')) yield entity;
  }
}

void main() {
  final routerSource = File(
    'lib/core/navigation/app_router.dart',
  ).readAsStringSync();
  final declaredRoutes = _matches(
    routerSource,
    RegExp(r"path:\s*'([^']+)'"),
  ).where((route) => route.startsWith('/')).toSet();
  final navigableRoutes = <String>{...patientDashboardCareRoutes};

  final navigationPatterns = <RegExp>[
    RegExp(r"(?:push|go)(?:<[^>]+>)?\s*\(\s*'(/[^']+)'"),
    RegExp(r"_openFeature\s*\([^,]+,\s*'(/[^']+)'"),
    RegExp(r"return\s+'(/[^']+)'"),
  ];
  for (final file in _dartFiles(Directory('lib'))) {
    if (file.path.endsWith('app_router.dart')) continue;
    final source = file.readAsStringSync();
    for (final pattern in navigationPatterns) {
      navigableRoutes.addAll(_matches(source, pattern));
    }
  }

  test('every in-app navigation target resolves to a declared route', () {
    final unresolved =
        navigableRoutes
            .where((route) => !_resolves(route, declaredRoutes))
            .toList()
          ..sort();
    expect(unresolved, isEmpty);
  });

  test('every standalone route is reachable or explicitly contextual', () {
    final missing =
        declaredRoutes
            .where((route) => !route.contains(':'))
            .where((route) => !navigableRoutes.contains(route))
            .where((route) => !patientNavExcludedRoutes.containsKey(route))
            .toList()
          ..sort();
    expect(missing, isEmpty);
  });

  test('contextual route exclusions are documented and not stale', () {
    for (final entry in patientNavExcludedRoutes.entries) {
      expect(entry.value.trim().length, greaterThan(8), reason: entry.key);
      expect(declaredRoutes, contains(entry.key), reason: entry.key);
      expect(navigableRoutes, isNot(contains(entry.key)), reason: entry.key);
    }
  });

  test('authenticated dashboard owns every restored patient shortcut', () {
    expect(patientDashboardCareRoutes, hasLength(6));
    expect(
      patientDashboardCareRoutes,
      containsAll(<String>{
        '/chatbot',
        '/calendar',
        '/refill',
        '/family',
        '/reminders',
        '/portal/maternity/timeline',
      }),
    );
    final dashboardSource = File(
      'lib/features/dashboard/screens/dashboard_screen.dart',
    ).readAsStringSync();
    expect(dashboardSource, contains('patientDashboardCareRoutes'));
    expect(dashboardSource, contains('if (!isGuest)'));
  });

  test('medication notifications open the restored reminder surface', () {
    final source = File(
      'lib/core/services/deep_link_service.dart',
    ).readAsStringSync();
    expect(
      RegExp(
        r"case 'MEDICATION_REMINDER':\s*return '/reminders';",
      ).hasMatch(source),
      isTrue,
    );
  });
}
