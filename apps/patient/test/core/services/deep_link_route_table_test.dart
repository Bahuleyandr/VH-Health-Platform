// test/core/services/deep_link_route_table_test.dart
//
// The deep-link allowlist is a PARTITION of the router's route table, and this
// is what makes it one.
//
// `/portal/discharge-summaries` and `/portal/discharge-summaries/:id` were real
// screens that a `vhhealth://app/…` link or a `route`-carrying push payload
// dead-ended on, because nobody remembered to add them here when the routes
// landed. `/portal/diagnostic-results/:id` was the same defect wearing a
// different hat: its list route WAS allowlisted, but its detail route is keyed
// by a UUID and the only parameterised matcher took integers.
//
// Adding those three names would have fixed three instances of a class that
// stays wide open: the next route added to app_router.dart is missing from the
// allowlist the moment it is written, and nothing says so. This test closes
// that. It parses every `GoRoute` path out of the router SOURCE and asserts
// each one is accounted for exactly once — either as a link destination
// (`debugAllowedRoutes` / the parameterised prefixes) or as a documented
// non-destination (`DeepLinkService.unreachableByLinkRoutes`). Both directions
// are checked, so neither a new route nor a stale allowlist entry can hide.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/deep_link_service.dart';

/// `GoRoute(path: '…')` in both spellings the router file uses (path on its own
/// line, and the single-line `GoRoute(path: '/abdm', builder: …)` form).
final _goRoutePath = RegExp(r"GoRoute\(\s*path:\s*'([^']+)'");

/// The prefix a parameterised route contributes, e.g. `/portal/bills/:id` →
/// `/portal/bills/`. Null when the parameter is not the final segment.
String? _trailingParamPrefix(String routerPath) {
  final index = routerPath.indexOf(':');
  if (index <= 0) return null;
  final tail = routerPath.substring(index);
  if (tail.contains('/')) return null; // e.g. /teleconsult/…/:id/lobby
  return routerPath.substring(0, index);
}

void main() {
  final routerSource = File('lib/core/navigation/app_router.dart')
      .readAsStringSync();

  final routerPaths = _goRoutePath
      .allMatches(routerSource)
      .map((m) => m.group(1)!)
      .toList();

  final allowed = DeepLinkService.debugAllowedRoutes;
  final paramPrefixes = <String>{
    ...DeepLinkService.debugNumericIdPrefixes,
    ...DeepLinkService.debugUuidIdPrefixes,
  };
  final unreachable = DeepLinkService.unreachableByLinkRoutes;

  group('the allowlist is derived from the router table', () {
    test('the parse sees every GoRoute in the router source', () {
      // If the regex silently stopped matching a spelling, every assertion
      // below would go vacuous. Pin the parse against a spelling-independent
      // count of the declarations themselves.
      final declarations = 'GoRoute('.allMatches(routerSource).length;
      expect(routerPaths.length, declarations);
      expect(routerPaths.toSet().length, routerPaths.length); // no duplicates
      // Anchors: a parse that returned the wrong region would miss these.
      expect(routerPaths, contains('/home'));
      expect(routerPaths, contains('/portal/discharge-summaries/:id'));
    });

    test('every router path is either a link destination or dispositioned', () {
      final unaccounted = <String>[];
      for (final path in routerPaths) {
        if (unreachable.containsKey(path)) continue;
        final prefix = _trailingParamPrefix(path);
        if (prefix == null) {
          if (!allowed.contains(path)) unaccounted.add(path);
          continue;
        }
        if (!paramPrefixes.contains(prefix)) unaccounted.add(path);
      }
      expect(
        unaccounted,
        isEmpty,
        reason:
            'These app_router.dart routes are neither allowlisted nor listed '
            'in DeepLinkService.unreachableByLinkRoutes, so a link to them '
            'dead-ends with nothing recording that as deliberate.',
      );
    });

    test('no route is both a destination and dispositioned unreachable', () {
      for (final path in unreachable.keys) {
        expect(allowed.contains(path), isFalse, reason: path);
        final prefix = _trailingParamPrefix(path);
        if (prefix != null) {
          expect(paramPrefixes.contains(prefix), isFalse, reason: path);
        }
      }
    });

    test('every allowlisted exact route is a real router path', () {
      // The mirror direction: a renamed or deleted route must not leave a
      // phantom entry behind that reads as coverage.
      final routerSet = routerPaths.toSet();
      for (final route in allowed) {
        expect(
          routerSet.contains(route),
          isTrue,
          reason: '$route is allowlisted but no GoRoute declares it',
        );
      }
    });

    test('every parameterised prefix belongs to a real router path', () {
      final declaredPrefixes = routerPaths
          .map(_trailingParamPrefix)
          .whereType<String>()
          .toSet();
      for (final prefix in paramPrefixes) {
        expect(
          declaredPrefixes.contains(prefix),
          isTrue,
          reason: '$prefix has no `:param` GoRoute behind it',
        );
      }
    });

    test('every disposition names a real router path and gives a reason', () {
      final routerSet = routerPaths.toSet();
      const reasons = {'session-setup', 'needs-extra', 'alias'};
      for (final entry in unreachable.entries) {
        expect(
          routerSet.contains(entry.key),
          isTrue,
          reason: '${entry.key} is dispositioned but is not a router path',
        );
        expect(
          reasons.any(entry.value.startsWith),
          isTrue,
          reason:
              '${entry.key}: "${entry.value}" must start with one of '
              '$reasons so the disposition is a category, not a shrug',
        );
      }
    });
  });

  group('the routes this lane found missing', () {
    test('discharge summaries resolve, list and detail', () {
      expect(
        DeepLinkService.parseNotificationRoute({
          'route': '/portal/discharge-summaries',
        }),
        '/portal/discharge-summaries',
      );
      expect(
        DeepLinkService.parseNotificationRoute({
          'route': '/portal/discharge-summaries/7',
        }),
        '/portal/discharge-summaries/7',
      );
      expect(
        DeepLinkService.parseExternalRoute(
          'vhhealth://app/portal/discharge-summaries/7',
        ),
        '/portal/discharge-summaries/7',
      );
    });

    test('a diagnostic-result detail resolves only for a real UUID', () {
      const uuid = '3f7c1b2a-4d5e-4f6a-9b8c-0d1e2f3a4b5c';
      expect(
        DeepLinkService.parseNotificationRoute({
          'route': '/portal/diagnostic-results/$uuid',
        }),
        '/portal/diagnostic-results/$uuid',
      );
      for (final bad in <String>[
        '42',
        'not-a-uuid',
        '$uuid/edit',
        '3f7c1b2a4d5e4f6a9b8c0d1e2f3a4b5c',
        // v6+/nil variants the router's own redirect also refuses.
        '00000000-0000-0000-0000-000000000000',
      ]) {
        expect(
          DeepLinkService.parseNotificationRoute({
            'route': '/portal/diagnostic-results/$bad',
          }),
          isNull,
          reason: bad,
        );
      }
    });
  });
}
