import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/navigation/route_reachability.dart';

Set<String> _matches(String source, RegExp pattern) =>
    pattern.allMatches(source).map((match) => match.group(1)!).toSet();

String _withoutQuery(String route) => route.split('?').first;

bool _resolves(String route, Set<String> patterns) {
  final routeParts = route.split('/');
  return patterns.any((pattern) {
    final patternParts = pattern.split('/');
    if (routeParts.length != patternParts.length) return false;
    for (var index = 0; index < routeParts.length; index += 1) {
      if (!patternParts[index].startsWith(':') &&
          patternParts[index] != routeParts[index]) {
        return false;
      }
    }
    return true;
  });
}

void main() {
  final routerSource = File(
    'lib/core/navigation/app_router.dart',
  ).readAsStringSync();
  final roleConfigSource = File(
    'lib/core/config/role_config.dart',
  ).readAsStringSync();
  final declaredRoutes = _matches(
    routerSource,
    RegExp(r"path:\s*'([^']+)'"),
  ).where((route) => route.startsWith('/')).toSet();
  final navigableRoutes = _matches(
    roleConfigSource,
    RegExp(r"route:\s*'([^']+)'"),
  ).map(_withoutQuery).toSet();

  test('every role navigation item resolves to a declared router path', () {
    final unresolved =
        navigableRoutes
            .where((route) => !_resolves(route, declaredRoutes))
            .toList()
          ..sort();
    expect(unresolved, isEmpty);
  });

  test('every standalone route is navigable or explicitly contextual', () {
    final missing =
        declaredRoutes
            .where((route) => !route.contains(':'))
            .where((route) => !navigableRoutes.contains(route))
            .where((route) => !staffNavExcludedRoutes.containsKey(route))
            .toList()
          ..sort();
    expect(missing, isEmpty);
  });

  test('contextual route exclusions are documented and not stale', () {
    for (final entry in staffNavExcludedRoutes.entries) {
      expect(entry.value.trim().length, greaterThan(8), reason: entry.key);
      expect(declaredRoutes, contains(entry.key), reason: entry.key);
      expect(navigableRoutes, isNot(contains(entry.key)), reason: entry.key);
    }
  });

  test('formerly orphaned staff screens are wired to canonical routes', () {
    expect(
      routerSource,
      contains('const NoTransitionPage(child: QueueScreen())'),
    );
    expect(
      navigableRoutes,
      containsAll(<String>{
        '/queue',
        '/devices/associate',
        '/housekeeping-roster',
      }),
    );
  });

  test('stale realtime boards expose degraded polling fallbacks', () {
    const boards = <String, String>{
      'lib/features/theatre/screens/theatre_screen.dart': 'staff:or-board',
      'lib/features/cath_lab/screens/cath_lab_screen.dart': 'staff:code-stemi',
      'lib/features/nursing/screens/handover_screen.dart': 'staff:handovers',
      'lib/features/investigations/screens/lab_bookings_screen.dart':
          'staff:lab',
      'lib/features/appointments/screens/appointments_screen.dart':
          'staff:appointments',
    };
    for (final entry in boards.entries) {
      final source = File(entry.key).readAsStringSync();
      expect(source, contains('RealtimeStatusBanner('), reason: entry.key);
      expect(source, contains(entry.value), reason: entry.key);
      expect(source, contains('fallbackPoll:'), reason: entry.key);
    }
  });
}
