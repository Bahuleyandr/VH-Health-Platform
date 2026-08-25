// Coverage guard for the patient app's optional biometric lock.
//
// Re-audit lane L found the lock bypassable: `/refill` rendered the SAME
// `/prescriptions/patient/my` payload as the gated Prescriptions tab, and
// `/pharmacy`, `/investigations`, `/vitals` and `/reminders` were in the same
// position. Wrapping those five closes the instances; this guard closes the
// CLASS, by refusing to let any router route exist without a decision
// recorded in lib/core/navigation/biometric_gate_policy.dart.
//
// It reads app_router.dart as text on purpose: building the real GoRouter
// would need Firebase, secure storage and the startup gates, and the property
// under test ("this route's builder is wrapped") is a source-level property.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/navigation/biometric_gate_policy.dart';

/// Strips `//` line comments and `/* */` blocks so a route named in prose
/// (the `_biometricGated` doc comment names several) cannot satisfy or trip
/// an assertion. A guard a comment can satisfy is not a guard.
String _stripComments(String source) => source
    .replaceAll(RegExp(r'/\*.*?\*/', dotAll: true), '')
    .split('\n')
    .map((line) {
      final index = line.indexOf('//');
      return index < 0 ? line : line.substring(0, index);
    })
    .join('\n');

/// The `path:` literals declared inside the router's single [ShellRoute] —
/// the routes that get MainScaffold's bottom navigation. Found by matching
/// the ShellRoute's own parentheses, so a route added to the shell later is
/// picked up without touching this parser.
Set<String> _shellRoutePaths(String source) {
  final open = source.indexOf('ShellRoute(');
  if (open < 0) return const {};
  var depth = 0;
  var end = -1;
  for (var i = source.indexOf('(', open); i < source.length; i += 1) {
    final ch = source[i];
    if (ch == '(') depth += 1;
    if (ch == ')') {
      depth -= 1;
      if (depth == 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return const {};
  return RegExp(r"path:\s*'([^']+)'")
      .allMatches(source.substring(open, end))
      .map((m) => m.group(1)!)
      .toSet();
}

void main() {
  final source = _stripComments(
    File('lib/core/navigation/app_router.dart').readAsStringSync(),
  );

  // Each `path:` literal starts a slice that runs to the next one. A route's
  // builder always follows its own `path:`, so "is this route wrapped" ==
  // "does its slice mention _biometricGated". `Uri(path: '/login', ...)` in
  // the redirect logic produces an extra slice for an already-declared route;
  // taking the union over a route's slices handles that harmlessly.
  final pathMatches = RegExp(r"path:\s*'([^']+)'").allMatches(source).toList();
  final gatedInRouter = <String>{};
  final declaredRoutes = <String>{};
  final mislabelled = <String?>[];
  for (var i = 0; i < pathMatches.length; i += 1) {
    final route = pathMatches[i].group(1)!;
    if (!route.startsWith('/')) continue;
    declaredRoutes.add(route);
    final start = pathMatches[i].end;
    final end = i + 1 < pathMatches.length
        ? pathMatches[i + 1].start
        : source.length;
    final slice = source.substring(start, end);
    if (slice.contains('_biometricGated')) {
      gatedInRouter.add(route);
      // Every call site declares the route it is guarding. Assert the string
      // it passes matches the route it sits under, so a copy-pasted call site
      // that names a DIFFERENT route is caught here rather than silently
      // satisfying the policy assert at runtime.
      for (final call in RegExp(
        r"_biometricGated\(\s*'([^']+)'",
      ).allMatches(slice)) {
        mislabelled.add(
          call.group(1) == route
              ? null
              : "route $route passes '${call.group(1)}'",
        );
      }
    }
  }

  test('the parser actually sees the router (self-check)', () {
    // Without this, a regex that silently matched nothing would make every
    // assertion below vacuously pass.
    expect(declaredRoutes.length, greaterThan(30));
    expect(gatedInRouter, isNotEmpty);
    expect(declaredRoutes, contains('/refill'));
  });

  test('each gated call site names its own route', () {
    expect(mislabelled.whereType<String>().toList(), isEmpty);
    // The call sites are what feed the runtime assert in _biometricGated, so
    // an empty list here would mean the regex stopped matching.
    expect(mislabelled, isNotEmpty);
  });

  test('router wrapping matches the declared gated set exactly', () {
    expect(
      gatedInRouter.difference(patientBiometricGatedRoutes).toList()..sort(),
      isEmpty,
      reason:
          'Routes wrapped in _biometricGated but not declared in '
          'patientBiometricGatedRoutes.',
    );
    expect(
      patientBiometricGatedRoutes.difference(gatedInRouter).toList()..sort(),
      isEmpty,
      reason:
          'Routes declared gated but NOT wrapped in _biometricGated — the '
          'lock does not actually cover them.',
    );
  });

  test('every declared route is classified exactly once', () {
    final classified = <String, int>{};
    void count(Iterable<String> routes) {
      for (final route in routes) {
        classified[route] = (classified[route] ?? 0) + 1;
      }
    }

    count(patientBiometricGatedRoutes);
    count(patientBiometricScreenGatedRoutes.keys);
    count(patientBiometricUngatedRoutes.keys);

    final unclassified =
        declaredRoutes.where((r) => !classified.containsKey(r)).toList()
          ..sort();
    expect(
      unclassified,
      isEmpty,
      reason:
          'New patient routes must be declared gated, screen-gated, or '
          'ungated-with-a-reason in biometric_gate_policy.dart.',
    );

    final duplicated =
        classified.entries.where((e) => e.value > 1).map((e) => e.key).toList()
          ..sort();
    expect(duplicated, isEmpty, reason: 'Route classified in two collections.');
  });

  test('no stale classifications survive a route being deleted', () {
    final stale = <String>{
      ...patientBiometricGatedRoutes,
      ...patientBiometricScreenGatedRoutes.keys,
      ...patientBiometricUngatedRoutes.keys,
    }.difference(declaredRoutes).toList()..sort();
    expect(
      stale,
      isEmpty,
      reason:
          'Policy names routes the router no longer '
          'declares.',
    );
  });

  test('screen-gated routes really do embed a BiometricGate', () {
    // The router cannot show these, so assert the claim against the screen.
    const screenFor = <String, String>{
      '/health': 'lib/features/your_health/screens/your_health_screen.dart',
    };
    for (final route in patientBiometricScreenGatedRoutes.keys) {
      final path = screenFor[route];
      expect(
        path,
        isNotNull,
        reason:
            'Add $route to screenFor so this guard can verify its embedded '
            'gate instead of trusting the policy comment.',
      );
      final screen = _stripComments(File(path!).readAsStringSync());
      expect(
        screen,
        contains('BiometricGate('),
        reason: '$route claims a screen-level gate that $path does not have.',
      );
      expect(screen, isNot(contains('_biometricGated')));
    }
  });

  test('every ungated route carries a real reason', () {
    for (final entry in patientBiometricUngatedRoutes.entries) {
      expect(
        entry.value.trim().length,
        greaterThan(24),
        reason: '${entry.key} needs a reason, not a placeholder.',
      );
    }
    for (final entry in patientBiometricScreenGatedRoutes.entries) {
      expect(entry.value.trim().length, greaterThan(24), reason: entry.key);
    }
  });

  test('a gated route almost never has bottom navigation of its own', () {
    // The premise behind BiometricGate's locked pane carrying its OWN exits.
    // The pane replaces the gated screen (so that screen's AppBar and back
    // button are never built), and everything gated except /notifications
    // renders outside the ShellRoute that draws the bottom nav — so a deep
    // link into one, denied, has no navigation at all unless the pane
    // supplies it. If a future change moves gated routes into the shell,
    // this fails and the pane's design should be revisited.
    final shell = _shellRoutePaths(source);
    // Self-check: a parser that found nothing would make the rest vacuous.
    expect(shell, contains('/home'));
    expect(shell, hasLength(4));

    expect(
      patientBiometricGatedRoutes.intersection(shell),
      {'/notifications'},
      reason:
          'Gated routes inside the bottom-nav shell changed; BiometricGate '
          'assumes a denied pane usually has no navigation around it.',
    );
    expect(
      patientBiometricGatedRoutes.difference(shell),
      hasLength(patientBiometricGatedRoutes.length - 1),
    );
  });

  test('the two safety-critical exclusions stay excluded', () {
    // These are not "not gated yet". /home hosts SOS and /settings is the only
    // place the lock can be switched off, so a fail-closed gate on either one
    // is a lockout, not a protection. If a future change gates them, this
    // fails and forces the argument to be had again.
    expect(patientBiometricUngatedRoutes.keys, contains('/home'));
    expect(patientBiometricUngatedRoutes.keys, contains('/settings'));
    expect(gatedInRouter, isNot(contains('/home')));
    expect(gatedInRouter, isNot(contains('/settings')));
  });
}
