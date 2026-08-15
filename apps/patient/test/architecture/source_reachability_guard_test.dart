import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Patient production sources stay within the reviewed import graph', () {
    final lib = Directory('lib').absolute;
    final sources = lib
        .listSync(recursive: true, followLinks: false)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'))
        .toList();
    final byPath = <String, File>{
      for (final source in sources) _relativeToLib(source, lib): source,
    };

    final reachable = <String>{};
    final pending = <String>['main.dart'];
    while (pending.isNotEmpty) {
      final path = pending.removeLast();
      if (!reachable.add(path)) continue;
      final source = byPath[path];
      if (source == null) continue;
      for (final dependency in _localDartDependencies(source, lib)) {
        if (byPath.containsKey(dependency) && !reachable.contains(dependency)) {
          pending.add(dependency);
        }
      }
    }

    final unreachable = byPath.keys.toSet().difference(reachable);
    final unexpected = unreachable.difference(_reviewedExceptions);
    final retiredExceptions = _reviewedExceptions.difference(unreachable);

    expect(
      unexpected,
      isEmpty,
      reason:
          'New Patient Dart sources are unreachable from lib/main.dart. '
          'Wire, delete, or explicitly review them before extending the baseline.',
    );
    expect(
      retiredExceptions,
      isEmpty,
      reason:
          'A reviewed exception is now reachable or deleted; remove it from '
          'the baseline so the guard records the improvement.',
    );
  });
}

Set<String> _localDartDependencies(File source, Directory lib) {
  final dependencies = <String>{};
  final directives = RegExp(
    r'''(?:^|\n)\s*(?:import|export|part)\s+([^;]+);''',
    multiLine: true,
  );
  final dartUris = RegExp(r'''['"]([^'"]+\.dart)['"]''');

  for (final directive in directives.allMatches(source.readAsStringSync())) {
    final body = directive.group(1)!;
    for (final match in dartUris.allMatches(body)) {
      final uri = match.group(1)!;
      File? dependency;
      if (uri.startsWith('package:vhhealth/')) {
        dependency = File.fromUri(
          lib.uri.resolve(uri.substring('package:vhhealth/'.length)),
        );
      } else if (!uri.contains(':')) {
        dependency = File.fromUri(source.parent.uri.resolve(uri));
      }
      if (dependency != null) {
        dependencies.add(_relativeToLib(dependency.absolute, lib));
      }
    }
  }
  return dependencies;
}

String _relativeToLib(File file, Directory lib) => file.path
    .substring(lib.path.length + 1)
    .replaceAll(Platform.pathSeparator, '/');

const _reviewedExceptions = <String>{
  // Compatibility/config surfaces retained deliberately until their public
  // consumers are either migrated or formally removed.
  'core/config/firebase_config.dart',
  'core/config/security_config.dart',
  'core/models/api_models.dart',
  'core/services/api_retry.dart',
  'core/services/certificate_pinner.dart',
  'core/theme/theme_colors.dart',
  'core/utils/font_scaler.dart',
  'core/widgets/accessible_button.dart',
  'core/widgets/accessible_card.dart',
  'core/widgets/accessible_image.dart',
  'features/investigations/widgets/result_trend_chart.dart',
  // Generated/public barrels are retained for their respective generators
  // and downstream import contracts even when main.dart has no direct edge.
  'gen/assets.gen.dart',
  'generated/intl/messages_all.dart',
  'generated/intl/messages_en.dart',
  'generated/l10n.dart',
  'l10n/l10n.dart',
};
