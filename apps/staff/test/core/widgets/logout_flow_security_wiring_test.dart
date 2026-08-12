import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('combined logout failures retain both recovery instructions', () async {
    final flow = await File('lib/core/widgets/logout_flow.dart').readAsString();
    final strings = await File('lib/l10n/app_strings.dart').readAsString();

    expect(
      flow,
      contains('(true, true) => strings.logoutCombinedTeardownFailed'),
    );
    expect(strings, contains('server did not confirm the session was revoked'));
    expect(strings, contains('previous notification channel was removed'));
    expect(strings, contains('sign in and out again'));
  });
}
