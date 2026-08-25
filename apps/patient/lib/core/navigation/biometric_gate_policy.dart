// lib/core/navigation/biometric_gate_policy.dart
//
// The patient app's optional biometric lock — Settings → SECURITY, the toggle
// labelled `settingsBiometricLogin` ("Use biometric login"), which arms both
// the splash quick-login AND this per-route record lock — is applied per route
// by `AppRouter._biometricGated`. Before
// re-audit lane L, which routes got the wrapper was decided ad hoc, so five
// screens rendered exactly the data classes the lock claims to protect while
// sitting outside it — most starkly `/refill`, which calls the SAME
// `/prescriptions/patient/my` endpoint as the gated Prescriptions tab.
//
// This file is the declared policy. Every route the router declares must
// appear in exactly one of the three collections below, and
// `test/core/navigation/biometric_gate_coverage_test.dart` fails the build
// when the router and this file disagree — so a NEW route cannot quietly
// re-open the class the way `/refill` did.
//
// ── What the lock protects ────────────────────────────────────────────────
// The patient's hospital clinical record and the money derived from it:
//   • prescriptions and medication schedules
//   • lab / pathology / radiology / investigation results and report files
//   • consultation notes, AI explanations, discharge summaries, health
//     summary (conditions + allergies), the ANC timeline
//   • hospital documents, patient uploads, the records timeline
//   • care-team secure messages
//   • bills, payments and TPA claims
//   • notifications, whose titles quote all of the above
//
// ── What it does NOT protect ─────────────────────────────────────────────
// Stated here, in docs/ROADMAP.md, and — the part that matters — in the
// patient-facing copy: `settingsBiometricLockSubtitle`, rendered under the
// toggle itself, names what the lock covers AND says Home, appointments and
// video consultations stay unlocked. (`biometricGateLockedMessage` on the
// denied pane deliberately says nothing about scope; it speaks only for the
// screen the patient is being kept out of.) A hole the user knows about is a
// trade-off; a hole they do not know about is a false promise.
//
// The two boundaries that carry real residual risk are Home and the
// appointment/teleconsult flow; both are spelled out in
// [patientBiometricUngatedRoutes] with the reason they cannot be gated.

/// Routes whose screen is wrapped by `AppRouter._biometricGated`.
///
/// Keep this in sync with the router — the coverage guard asserts equality in
/// BOTH directions, so adding a route here without wrapping it fails just as
/// loudly as wrapping one without declaring it.
const patientBiometricGatedRoutes = <String>{
  '/notifications',
  '/pharmacy',
  '/investigations',
  '/vitals',
  '/refill',
  '/reminders',
  '/portal/bills',
  '/portal/bills/:id',
  '/portal/lab-results',
  '/portal/lab-results/:id',
  '/portal/diagnostic-results',
  '/portal/diagnostic-results/:id',
  '/portal/referrals',
  '/portal/lab-orders',
  '/portal/discharge-summaries',
  '/portal/discharge-summaries/:id',
  '/portal/maternity/timeline',
  '/portal/tpa/claims',
  '/portal/tpa/claims/:id',
  '/portal/messages',
  '/portal/messages/:id',
  '/health/explanations/:id',
  '/health/consultation-notes/:id',
};

/// Routes gated by the screen itself rather than by the router wrapper,
/// because the screen has an ungatable branch.
const patientBiometricScreenGatedRoutes = <String, String>{
  '/health':
      'YourHealthScreen wraps its authenticated body in BiometricGate '
      'directly; the guest branch is deliberately not gated because a '
      'guest session has no record to protect.',
};

/// Routes deliberately left outside the lock, each with the reason.
///
/// These are not "not looked at yet" — every entry is a decision. The guard
/// requires a non-trivial reason string, so the cheapest way to add a route
/// is still to classify it honestly.
const patientBiometricUngatedRoutes = <String, String>{
  // ── Safety-critical: must never sit behind a fail-closed sensor ────────
  '/home':
      'RESIDUAL RISK, ACCEPTED. DashboardScreen hosts the SOS button. '
      'BiometricGateService fails CLOSED, so gating Home would put an '
      'emergency control behind a sensor that can deny — the one outcome '
      'worse than the leak. Home therefore keeps showing summary-level '
      'record signals (a Today card can name a test or quote an abnormal '
      'flag, the next-visit card names the doctor, the stats strip shows '
      'the wellness score and cycle estimate). Redacting only some of '
      'those would leave the rest and read as a complete lock, so nothing '
      'on Home is redacted and the user-facing copy says so.',
  '/appointments':
      'RESIDUAL RISK, ACCEPTED. Appointment date, department and doctor are '
      'already visible on the ungated Home card, so gating the list would '
      'be a partial fix that reads as a complete one. Appointments also '
      'carry no result, note or prescription content.',
  '/appointments/:id':
      'Same class as /appointments, and it is the entry point to the '
      'teleconsult lobby below.',
  '/teleconsult/appointments/:appointmentId/lobby':
      'Time-critical: a fail-closed prompt between the patient and a '
      'consultation that is starting now can make them miss it. The '
      'consultation itself is live video, not stored record content.',
  '/teleconsult/appointments/:appointmentId/consult':
      'Same as the lobby — a live call must not be interruptible by a '
      'biometric denial.',
  '/settings':
      'MUST stay reachable. Settings is where the lock is turned OFF, so it '
      'is the escape hatch for a patient whose sensor has broken; gating '
      'it would make a fail-closed denial unrecoverable in-app. The denied '
      'pane links straight here (BiometricGate._leaveFor), which is what '
      'makes the hatch reachable from a gated route that a deep link opened '
      'with an empty back stack.',

  // ── Not the protected data classes ────────────────────────────────────
  '/': 'Splash / startup redirect. Renders no patient data.',
  '/login':
      'Pre-authentication: no session, therefore no record to protect, and '
      'gating sign-in would lock the patient out of their own account.',
  '/terms': 'Static legal text, identical for every patient.',
  '/profile-setup':
      'Pre-record onboarding; the patient is typing their own '
      'demographics, and no record exists yet.',
  '/profile-edit':
      'Demographics the patient authored (name, phone, address). Not clinical '
      'record content, and the same fields are echoed in the Home header.',
  '/settings/record-access':
      'Proxy-grant consent management — who MAY see the record, not the '
      'record. Gating it would make revoking access harder than granting '
      'it, which is the wrong way round for a consent control.',
  '/book-investigation':
      'Booking wizard — writes a new order, reads no result. Results live on '
      '/investigations, which IS gated.',
  '/ask-a-doubt':
      'A form the patient is composing right now; it renders no stored '
      'clinical content. Replies arrive as portal messages, and '
      '/portal/messages IS gated.',
  '/feedback-history':
      'The patient\'s own service ratings and free-text feedback about the '
      'hospital. Not clinical record content.',
  '/chatbot':
      'Symptom triage typed in this session and not persisted to the record '
      'by this screen.',
  '/calendar':
      'A month view of the same appointment/booking schedule as '
      '/appointments; gated separately it would only move the leak.',
  '/family':
      'Dependent roster (names and relationships). Switching to a '
      'dependent still lands on gated record screens for their data.',
  '/add-dependent': 'Form for adding a dependent; renders no record.',
  '/steps': 'Self-tracked step activity, also shown on ungated Home.',
  '/trivia': 'Health quiz content, identical for every patient.',
  '/departments': 'Hospital directory, identical for every patient.',
  '/about-us': 'Hospital contact and location, identical for every patient.',
  '/abdm':
      'ABHA linkage and enrolment — a national health ID and identity '
      'documents, not the hospital record. It is a distinct sensitivity '
      'class that the lock copy does not claim to cover.',
  '/health-points': 'Gamification points and milestones; also on Home.',
  '/period-tracker':
      'Self-tracked cycle data. The same estimate is rendered on ungated '
      'Home, so gating only this screen would be a partial fix.',

  // ── Redirect-only aliases (no screen of their own) ────────────────────
  '/records': 'Alias that redirects to /health, which is gated.',
  '/your-health': 'Alias that redirects to /health, which is gated.',
  '/dashboard': 'Alias that redirects to /home.',
};
