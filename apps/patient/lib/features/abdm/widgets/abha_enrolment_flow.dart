// abha_enrolment_flow.dart
//
// Patient self-enrolment for a NEW ABHA via Aadhaar OTP — the Flutter half of
// P13/#809. The backend flow (migration 701, /portal/abdm/enrolment/*) shipped
// complete: start → OTP verify → enrolled/linked, with resend + cancel. Until
// 2026-08-23 the app only supported LINKING an existing ABHA, so a patient
// without one could not enrol from the app at all.
//
// Re-audit lane L: this wizard shipped as hardcoded English inside a
// five-language app, so a Tamil/Telugu/Hindi/Malayalam patient met an English
// identity-and-consent flow. Every user-visible string below now resolves
// through AppLocalizations (`abhaEnrol*` keys in lib/l10n/intl_*.arb).
//
// TRANSLATION STATUS — do not read the non-English copy as signed off. The
// Aadhaar / OTP / ABHA strings are statutory identity terms; their ARB
// metadata marks them LEGAL/IDENTITY and docs/TRANSLATION_REVIEW_TRACKER.md
// carries them as a first-pass fill awaiting human review. "ABHA", "OTP" and
// the Aadhaar term are deliberately kept in their standard forms rather than
// translated as common nouns.
//
// STILL ENGLISH-ONLY: the rest of abdm_screen.dart (existing-ABHA link form,
// consent grant/deny/revoke dialogs). Those are consent-bearing strings whose
// verbs are grammatically English-specific, so they are parked in
// docs/ROADMAP.md rather than guessed at here.
//
// RECOVERING FROM ABHA_ENROLMENT_IN_PROGRESS (re-audit lane L, 2026-08-25).
// The backend allows exactly ONE live enrolment session per patient (unique
// index ux_abha_enrolment_patient_live, over the four statuses migration 707
// lists). This widget never asked whether one existed, so a patient who
// backgrounded or killed the app mid-flow came back to a blank Aadhaar form,
// pressed Send OTP, and got a flat 409 ABHA_ENROLMENT_IN_PROGRESS rendered as
// "could not start, please retry" — retrying could not work, and the session
// id needed to cancel it had died with the widget. The wait was however long
// the wedged row had left: `abhaEnrolmentService` sets expires_at to ten
// minutes after the last OTP was sent (thirty for a session that never got
// one), and only the every-5-minute expiry sweep retires it.
//
// The 409 is now the trigger to recover. GET /portal/abdm/enrolment/status
// names the session holding the slot; the flow CANCELS it and starts again
// with the Aadhaar that is in the form right now.
//
// WHY IT DOES NOT RESUME THE OLD SESSION. Adopting it and continuing at the
// OTP step is cheaper by one SMS, and wrong. That session was started with
// whatever Aadhaar the abandoned attempt used — the recovery runs precisely
// because the number now on screen was refused — and nothing can tell the two
// apart: the backend never stores the Aadhaar (privacy contract, migration
// 701), `publicSession` exposes no identifier for it, and
// `resendEnrolmentOtp` validates only the FORMAT of what it is handed. So
// verifying the adopted OTP would enrol the OTHER number while the screen
// says the patient is enrolling this one, and resending would re-point the
// session's gateway txn at the new number mid-session. Cancel-and-restart
// makes the whole class impossible: the only session this flow ever verifies
// is one it started, from the digits in the form.
//
// What that costs: one extra OTP SMS, and one extra token from the
// `otpRateLimiter` budget that `/enrolment/start` and `/enrolment/resend`
// share (3 per 10 minutes). A recovering patient therefore spends two of
// those three on the single Send OTP press that recovers.
//
// One recovery per widget lifetime, and the restart it performs never
// recovers again — a flag, not a retry loop, is what bounds it.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AbhaEnrolmentFlow extends StatefulWidget {
  const AbhaEnrolmentFlow({
    super.key,
    required this.onEnrolled,
    required this.onCancelled,
  });

  /// Called after the session reaches its terminal enrolled/linked state so
  /// the parent tab can re-fetch the authoritative linkage.
  final VoidCallback onEnrolled;
  final VoidCallback onCancelled;

  @override
  State<AbhaEnrolmentFlow> createState() => _AbhaEnrolmentFlowState();
}

enum _Step { aadhaar, otp, done }

/// Outcome of the ABHA_ENROLMENT_IN_PROGRESS recovery — see [_start].
enum _Recovery {
  /// The session that held the slot had already finished. The done step is
  /// showing its ABHA; there is nothing left to start.
  completed,

  /// Nothing holds the one-live-session slot any more, so a fresh start with
  /// the Aadhaar in the form can be made.
  slotFree,

  /// A gateway OTP verification is genuinely in flight on the blocking
  /// session. The backend refuses to cancel under it (a cancelled row could
  /// strand an ABHA the gateway has already minted), so waiting is the only
  /// move.
  verifyInFlight,

  /// The server could not be asked, or answered something this flow does not
  /// recognise. Falls back to the ordinary start-failure message.
  unknown,
}

class _AbhaEnrolmentFlowState extends State<AbhaEnrolmentFlow> {
  final _formKey = GlobalKey<FormState>();
  final _aadhaarController = TextEditingController();
  final _mobileController = TextEditingController();
  final _otpController = TextEditingController();

  _Step _step = _Step.aadhaar;
  bool _busy = false;
  String? _error;
  int? _sessionId;
  String? _mobileLast4;
  String? _abhaNumber;
  String? _abhaAddress;
  int _resendCooldown = 0;
  Timer? _cooldownTimer;

  /// One recovery attempt per widget lifetime. The recovery below issues
  /// further requests off the back of a failed one; a flag — not a retry loop
  /// — is what keeps that bounded.
  bool _triedRecoveringLiveSession = false;

  String get _aadhaarDigits =>
      _aadhaarController.text.replaceAll(RegExp(r'\D'), '');

  @override
  void dispose() {
    _cooldownTimer?.cancel();
    _aadhaarController.dispose();
    _mobileController.dispose();
    _otpController.dispose();
    super.dispose();
  }

  void _startCooldown() {
    _cooldownTimer?.cancel();
    setState(() => _resendCooldown = 30);
    _cooldownTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _resendCooldown = _resendCooldown - 1);
      if (_resendCooldown <= 0) t.cancel();
    });
  }

  Map<String, dynamic>? _sessionFrom(dynamic data) =>
      data is Map<String, dynamic> && data['session'] is Map<String, dynamic>
      ? data['session'] as Map<String, dynamic>
      : null;

  /// What the server says the patient's latest enrolment session is.
  ///
  /// `asked` is false when the question could not be put to the server at all
  /// — the caller is already on a failure path and must not be made worse, so
  /// this never throws. `session` is null when the server answered that there
  /// is none.
  Future<({bool asked, Map<String, dynamic>? session})>
  _fetchLatestSession() async {
    try {
      final response = await ApiClient.get('/portal/abdm/enrolment/status');
      if (!response.isSuccess) return (asked: false, session: null);
      return (asked: true, session: _sessionFrom(response.dataAsMap()));
    } catch (_) {
      return (asked: false, session: null);
    }
  }

  /// Cancel the session that is holding the one-live-session slot.
  Future<_Recovery> _cancelSession(int sessionId) async {
    try {
      final response = await ApiClient.post(
        '/portal/abdm/enrolment/cancel',
        body: {'session_id': sessionId},
      );
      if (response.isSuccess) return _Recovery.slotFree;
      switch (response.code) {
        // The server had already retired it — same outcome, slot free.
        case 'ABHA_ENROLMENT_SESSION_NOT_FOUND':
          return _Recovery.slotFree;
        // A verifier is inside the gateway call on that session, so the
        // backend will not cancel under it. Neither will we.
        case 'ABHA_ENROLMENT_VERIFY_IN_PROGRESS':
          return _Recovery.verifyInFlight;
        default:
          return _Recovery.unknown;
      }
    } catch (_) {
      return _Recovery.unknown;
    }
  }

  /// Free the one-live-session slot after a 409 ABHA_ENROLMENT_IN_PROGRESS.
  Future<_Recovery> _recoverLiveSession() async {
    final probe = await _fetchLatestSession();
    if (!mounted || !probe.asked) return _Recovery.unknown;
    final session = probe.session;
    // `/status` returns the LATEST session, and that is the blocking one
    // whenever a blocking one exists: a newer row could not have been
    // inserted while the older one held the partial unique index. So "latest
    // is terminal" means nothing is holding the slot.
    if (session == null) return _Recovery.slotFree;

    final status = session['status']?.toString();
    if (status == 'linked' || status == 'enrolled') {
      // The blocking session completed elsewhere between our start and this
      // probe. Show what it produced rather than starting a second one.
      setState(() {
        _sessionId = null;
        _abhaNumber = session['abha_number']?.toString();
        _abhaAddress = session['abha_address']?.toString();
        _step = _Step.done;
      });
      return _Recovery.completed;
    }

    final id = (session['id'] as num?)?.toInt();
    if (id == null) return _Recovery.unknown;
    return _cancelSession(id);
  }

  Future<ApiResponse> _postStart() => ApiClient.post(
    '/portal/abdm/enrolment/start',
    body: {
      'flow': 'aadhaar_otp',
      'aadhaar_number': _aadhaarDigits,
      if (_mobileController.text.trim().isNotEmpty)
        'mobile': _mobileController.text.trim(),
    },
  );

  /// Moves to the OTP step when [response] started a session. False leaves the
  /// caller to deal with the failure.
  bool _applyStartedSession(ApiResponse response) {
    final session = _sessionFrom(response.dataAsMap());
    if (!response.isSuccess || session == null) return false;
    setState(() {
      _sessionId = (session['id'] as num?)?.toInt();
      _mobileLast4 = session['mobile_last4']?.toString();
      _step = _Step.otp;
    });
    _startCooldown();
    return true;
  }

  Future<void> _start() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    // Resolved before the first await: `context` must not be read across one.
    final l10n = AppLocalizations.of(context)!;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      var response = await _postStart();
      if (!mounted) return;
      if (_applyStartedSession(response)) return;

      // ABHA_ENROLMENT_IN_PROGRESS: the one-live-session slot is already
      // claimed by an attempt this process lost track of. Without the
      // recovery the patient read "Please retry" and retrying could not work
      // until the expiry sweep passed that session's expires_at.
      if (response.code == 'ABHA_ENROLMENT_IN_PROGRESS' &&
          !_triedRecoveringLiveSession) {
        _triedRecoveringLiveSession = true;
        final outcome = await _recoverLiveSession();
        if (!mounted) return;
        switch (outcome) {
          case _Recovery.completed:
            return; // The done step is already on screen.
          case _Recovery.verifyInFlight:
            setState(() => _error = l10n.abhaEnrolVerifyInProgress);
            return;
          case _Recovery.slotFree:
            // The slot is free, so start again — and THIS session is built
            // from the digits now in the form, which is what makes verify and
            // resend below safe. The flag above means this start cannot
            // recover a second time.
            response = await _postStart();
            if (!mounted) return;
            if (_applyStartedSession(response)) return;
          case _Recovery.unknown:
            break;
        }
      }
      setState(
        () => _error = response.failureMessage(l10n.abhaEnrolStartFailed),
      );
    } catch (e) {
      if (mounted) {
        setState(() => _error = l10n.abhaEnrolServerUnreachable('$e'));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final l10n = AppLocalizations.of(context)!;
    final otp = _otpController.text.trim();
    if (otp.length != 6) {
      setState(() => _error = l10n.abhaEnrolOtpLengthError);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await ApiClient.post(
        '/portal/abdm/enrolment/otp',
        body: {'session_id': _sessionId, 'otp': otp},
      );
      if (!mounted) return;
      final session = _sessionFrom(response.dataAsMap());
      final status = session?['status']?.toString();
      if (response.isSuccess && (status == 'enrolled' || status == 'linked')) {
        setState(() {
          _abhaNumber = session?['abha_number']?.toString();
          _abhaAddress = session?['abha_address']?.toString();
          _step = _Step.done;
        });
      } else if (response.isSuccess) {
        // Multi-leg flows (e.g. mobile OTP after Aadhaar OTP) come back
        // otp_sent again with a fresh OTP on the enrolment mobile.
        setState(() {
          _otpController.clear();
          _mobileLast4 = session?['mobile_last4']?.toString() ?? _mobileLast4;
          final last4 = _mobileLast4;
          _error = last4 == null
              ? l10n.abhaEnrolOneMoreStep
              : l10n.abhaEnrolOneMoreStepMasked(last4);
        });
        _startCooldown();
      } else {
        setState(
          () => _error = response.failureMessage(l10n.abhaEnrolOtpFailed),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = l10n.abhaEnrolServerUnreachable('$e'));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Re-send the OTP.
  ///
  /// The aadhaar_otp leg REQUIRES the Aadhaar number again: the backend never
  /// stores it, so `resendEnrolmentOtp` runs `requireValidAadhaar` over what
  /// the caller sends. This posted only `session_id`, so every resend came
  /// back 400 INVALID_AADHAAR — the button was wired to something that could
  /// not succeed.
  ///
  /// `requireValidAadhaar` checks the FORMAT only; it cannot compare the
  /// number against the one the session was started with, and the backend has
  /// nothing to compare it to. What makes that safe here is that the OTP step
  /// is only ever reached from a start THIS widget made from
  /// [_aadhaarDigits], so the number posted below is the number the session
  /// was created from.
  Future<void> _resend() async {
    final l10n = AppLocalizations.of(context)!;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await ApiClient.post(
        '/portal/abdm/enrolment/resend',
        body: {'session_id': _sessionId, 'aadhaar_number': _aadhaarDigits},
      );
      if (!mounted) return;
      if (response.isSuccess) {
        _startCooldown();
      } else {
        setState(
          () => _error = response.failureMessage(l10n.abhaEnrolResendFailed),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = l10n.abhaEnrolServerUnreachable('$e'));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _cancel() async {
    if (_sessionId != null) {
      // Best-effort server-side cancel; the session also hard-expires.
      try {
        await ApiClient.post(
          '/portal/abdm/enrolment/cancel',
          body: {'session_id': _sessionId},
        );
      } catch (_) {
        // Leaving the flow is never blocked on the cancel call.
      }
    }
    if (mounted) widget.onCancelled();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    final last4 = _mobileLast4;
    return SingleChildScrollView(
      key: const ValueKey('abha_enrolment_flow'),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            l10n.abhaEnrolTitle,
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            switch (_step) {
              _Step.aadhaar => l10n.abhaEnrolAadhaarIntro,
              _Step.otp =>
                last4 == null
                    ? l10n.abhaEnrolOtpIntro
                    : l10n.abhaEnrolOtpIntroMasked(last4),
              _Step.done => l10n.abhaEnrolDoneIntro,
            },
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 16),
          if (_error != null) ...[
            Text(
              _error!,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
            const SizedBox(height: 12),
          ],
          if (_step == _Step.aadhaar) _buildAadhaarStep(l10n),
          if (_step == _Step.otp) _buildOtpStep(l10n),
          if (_step == _Step.done) _buildDoneStep(theme, l10n),
        ],
      ),
    );
  }

  Widget _buildAadhaarStep(AppLocalizations l10n) {
    return Form(
      key: _formKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextFormField(
            key: const ValueKey('enrolment_aadhaar'),
            controller: _aadhaarController,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            maxLength: 12,
            decoration: InputDecoration(
              labelText: l10n.abhaEnrolAadhaarLabel,
              hintText: l10n.abhaEnrolAadhaarHint,
              prefixIcon: const Icon(Icons.fingerprint),
              border: const OutlineInputBorder(),
              counterText: '',
            ),
            validator: (v) {
              final digits = (v ?? '').replaceAll(RegExp(r'\D'), '');
              if (digits.length != 12) {
                return l10n.abhaEnrolAadhaarInvalid;
              }
              return null;
            },
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _mobileController,
            keyboardType: TextInputType.phone,
            decoration: InputDecoration(
              labelText: l10n.abhaEnrolMobileLabel,
              hintText: l10n.abhaEnrolMobileHint,
              prefixIcon: const Icon(Icons.phone_android),
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : _cancel,
                  child: Text(l10n.commonBackButton),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  key: const ValueKey('enrolment_start'),
                  onPressed: _busy ? null : _start,
                  child: _busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text(l10n.abhaEnrolSendOtp),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildOtpStep(AppLocalizations l10n) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const ValueKey('enrolment_otp'),
          controller: _otpController,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          maxLength: 6,
          decoration: InputDecoration(
            labelText: l10n.abhaEnrolOtpLabel,
            prefixIcon: const Icon(Icons.sms_outlined),
            border: const OutlineInputBorder(),
            counterText: '',
          ),
        ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            onPressed: (_busy || _resendCooldown > 0) ? null : _resend,
            child: Text(
              _resendCooldown > 0
                  ? l10n.abhaEnrolResendOtpIn(_resendCooldown)
                  : l10n.abhaEnrolResendOtp,
            ),
          ),
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: _busy ? null : _cancel,
                child: Text(l10n.commonCancelButton),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: FilledButton(
                key: const ValueKey('enrolment_verify'),
                onPressed: _busy ? null : _verify,
                child: _busy
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(l10n.abhaEnrolVerify),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildDoneStep(ThemeData theme, AppLocalizations l10n) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(Icons.verified, size: 56, color: theme.colorScheme.primary),
        const SizedBox(height: 12),
        if (_abhaNumber != null)
          Center(
            child: Text(
              _abhaNumber!,
              style: theme.textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.bold,
                letterSpacing: 1.2,
              ),
            ),
          ),
        if (_abhaAddress != null)
          Center(
            child: Text(
              _abhaAddress!,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        const SizedBox(height: 24),
        FilledButton(
          key: const ValueKey('enrolment_done'),
          onPressed: widget.onEnrolled,
          child: Text(l10n.abhaEnrolViewMyAbha),
        ),
      ],
    );
  }
}
