// Operation overlays for the Firebase auth surface (/api/v1/auth/firebase/*).
//
// Only the self-service session-revocation route is documented here. The pair
// of revocation endpoints is easy to confuse — one names its target in the
// body and is ADMIN-only, the other derives the target from the JWT — so the
// distinction is worth stating in the published contract rather than leaving a
// reader to infer it from the route table.

export const schemas = {};

export const operations = {
  'POST /api/v1/auth/firebase/revoke-my-session': {
    summary: "Revoke the caller's own Firebase session",
    description:
      'Self-service logout companion: revokes the Firebase refresh tokens belonging to the ' +
      'authenticated caller, so a leaked refresh token cannot mint fresh ID tokens (and thus ' +
      'cannot be traded for a new VH JWT) after sign-out. Takes no request body — the Firebase ' +
      'UID is resolved server-side from the JWT subject, which is what makes this safe to expose ' +
      'to any authenticated role. Contrast POST /api/v1/auth/firebase/revoke-session, which ' +
      'takes an arbitrary firebaseUid in the body and is therefore ADMIN-only force-logout. ' +
      'Responds 200 with revoked=false and reason=NO_FIREBASE_SESSION when the caller has no ' +
      'linked Firebase credential (for example a staff identity), rather than reporting a ' +
      'revocation that did not happen. Does not blacklist the caller VH JWT — that is the ' +
      'separate concern of POST /api/v1/auth/logout.',
  },
};
