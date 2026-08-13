// test/core/widgets/logout_warning_copy_test.dart
//
// `LogoutOutcome` is only honest if something reads it. Before these tests the
// ONLY production consumer of any outcome field was this snackbar, and it read
// `serverSessionRevoked` alone: it showed the identical sentence — "other
// devices may stay signed in until you retry" — whether or not a retry had
// actually been queued, which is precisely the false reassurance
// `revocationRetryQueued`'s own docstring says to avoid. It also implied a
// user action that does not exist anywhere in the app; the retry is automatic
// and runs at the next signed-out app start.

import 'package:flutter_test/flutter_test.dart';

import 'package:vhhealth/core/services/logout_service.dart';
import 'package:vhhealth/core/widgets/logout_button.dart';

const _revoked = LogoutOutcome(
  firebaseSessionRevoked: true,
  vhSessionRevoked: true,
);

const _unconfirmedWithRetry = LogoutOutcome(
  firebaseSessionRevoked: true,
  vhSessionRevoked: false,
  revocationRetryQueued: true,
);

const _unconfirmedWithoutRetry = LogoutOutcome(
  firebaseSessionRevoked: true,
  vhSessionRevoked: false,
  revocationRetryQueued: false,
);

void main() {
  test('a confirmed server revocation warns about nothing', () {
    expect(LogoutButton.logoutWarningMessage(_revoked), isNull);
  });

  test('the two unconfirmed branches must not say the same thing', () {
    // THE defect, stated directly: one sentence for both states means the
    // field it is supposed to reflect changes nothing a user can see.
    expect(
      LogoutButton.logoutWarningMessage(_unconfirmedWithRetry),
      isNot(
        equals(LogoutButton.logoutWarningMessage(_unconfirmedWithoutRetry)),
      ),
    );
  });

  test('a queued retry is described as AUTOMATIC, not as a user action', () {
    final message = LogoutButton.logoutWarningMessage(_unconfirmedWithRetry)!;

    expect(message, contains('automatically'));
    expect(
      message.toLowerCase(),
      isNot(contains('until you retry')),
      reason:
          'there is no retry affordance in the app — the drain runs at the '
          'next signed-out start',
    );
  });

  test('no queued retry must not promise one', () {
    final message = LogoutButton.logoutWarningMessage(
      _unconfirmedWithoutRetry,
    )!;

    expect(
      message,
      isNot(contains('automatically')),
      reason:
          'nothing on this device can revoke the session; saying it will '
          'happen anyway is the false reassurance the outcome exists to stop',
    );
    expect(message.toLowerCase(), contains('cannot try again'));
    // The user is told what they CAN do instead.
    expect(message.toLowerCase(), contains('sign out from them directly'));
  });
}
