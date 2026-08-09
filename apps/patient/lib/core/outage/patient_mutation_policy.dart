enum PatientMutationCategory { highRisk, remoteState, emergency }

class PatientMutationPolicy {
  PatientMutationPolicy._();

  static PatientMutationCategory classify(String method, String path) {
    final normalizedMethod = method.toUpperCase();
    if (!const {
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'MULTIPART',
    }.contains(normalizedMethod)) {
      throw ArgumentError.value(method, 'method');
    }

    if (path == '/sos/' || path.startsWith('/sos/cancel/')) {
      return PatientMutationCategory.emergency;
    }

    // Ending the session is session bookkeeping, not a hospital write, so it is
    // remoteState rather than highRisk. Note the outage gate blocks EVERY
    // mutation regardless of category, so during an outage this call never
    // leaves the device — LogoutService still clears local state and reports
    // the server-side revocation as not done.
    if (path == '/auth/logout') {
      return PatientMutationCategory.remoteState;
    }

    if (path.startsWith('/notifications/') ||
        path.endsWith('/read') ||
        path == '/feedback/quick-rating' ||
        (path.startsWith('/gamification/milestones/') &&
            path.endsWith('/claim')) ||
        path.startsWith('/devices/') ||
        path == '/auth/firebase/update-fcm-token' ||
        path == '/auth/firebase/revoke-my-session') {
      return PatientMutationCategory.remoteState;
    }

    return PatientMutationCategory.highRisk;
  }
}
