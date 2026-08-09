import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/outage/patient_mutation_policy.dart';

void main() {
  test('default-denies booking, cancellation, and medical request writes', () {
    expect(
      PatientMutationPolicy.classify('POST', '/appointments'),
      PatientMutationCategory.highRisk,
    );
    expect(
      PatientMutationPolicy.classify('DELETE', '/appointments/42'),
      PatientMutationCategory.highRisk,
    );
    expect(
      PatientMutationPolicy.classify('MULTIPART', '/investigations/book'),
      PatientMutationCategory.highRisk,
    );
    expect(
      PatientMutationPolicy.classify('POST', '/unknown/future-mutation'),
      PatientMutationCategory.highRisk,
    );
  });

  test(
    'classifies remote-state and emergency writes without allowing them',
    () {
      expect(
        PatientMutationPolicy.classify('PATCH', '/notifications/7/read'),
        PatientMutationCategory.remoteState,
      );
      expect(
        PatientMutationPolicy.classify('POST', '/devices/register'),
        PatientMutationCategory.remoteState,
      );
      expect(
        PatientMutationPolicy.classify('POST', '/sos/'),
        PatientMutationCategory.emergency,
      );
    },
  );

  // Logout's server-side Firebase revocation is remote-state, not a high-risk
  // clinical write. The allowlist matches this path by exact string, so a
  // rename that misses it silently downgrades logout to highRisk — pin it.
  test(
    'classifies the self-service Firebase session revoke as remote-state',
    () {
      expect(
        PatientMutationPolicy.classify(
          'POST',
          '/auth/firebase/revoke-my-session',
        ),
        PatientMutationCategory.remoteState,
      );
    },
  );

  test('classifies logout as session bookkeeping, not a hospital write', () {
    // Falling through to highRisk would mislabel the outage banner for a call
    // that writes no clinical data. The gate still blocks it during an outage —
    // LogoutService reports that as "server session not revoked".
    // Distinct credential from the Firebase revoke above: that ends the
    // Firebase session, this ends the VH JWT. Both paths need an entry.
    expect(
      PatientMutationPolicy.classify('POST', '/auth/logout'),
      PatientMutationCategory.remoteState,
    );
  });
}
