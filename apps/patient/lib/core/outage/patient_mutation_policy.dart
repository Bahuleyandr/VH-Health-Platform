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

    if (path.startsWith('/notifications/') ||
        path.endsWith('/read') ||
        path == '/feedback/quick-rating' ||
        (path.startsWith('/gamification/milestones/') &&
            path.endsWith('/claim')) ||
        path.startsWith('/devices/') ||
        path == '/auth/firebase/update-fcm-token' ||
        path == '/auth/firebase/revoke-session') {
      return PatientMutationCategory.remoteState;
    }

    return PatientMutationCategory.highRisk;
  }
}
