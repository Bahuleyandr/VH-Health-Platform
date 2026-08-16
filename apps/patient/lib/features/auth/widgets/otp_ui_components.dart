// otp_ui_components.dart - All UI components
import 'package:flutter/material.dart';
import 'package:pin_code_fields/pin_code_fields.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class OtpForm extends StatelessWidget {
  final String phoneNumber;
  final TextEditingController controller;
  final bool otpSent;
  final bool isVerifying;
  final bool isResending;

  /// Inline error shown (and announced to screen readers) under the OTP
  /// field. Null hides the error.
  final String? errorText;

  /// Seconds left before another resend is allowed; 0 = no cooldown.
  final int resendCooldownSeconds;
  final VoidCallback onVerifyPressed;
  final VoidCallback onResendPressed;
  final Function(String) onOtpChanged;
  final Function(String) onOtpCompleted;

  const OtpForm({
    super.key,
    required this.phoneNumber,
    required this.controller,
    required this.otpSent,
    required this.isVerifying,
    required this.isResending,
    this.errorText,
    this.resendCooldownSeconds = 0,
    required this.onVerifyPressed,
    required this.onResendPressed,
    required this.onOtpChanged,
    required this.onOtpCompleted,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 24),
        OtpHeader(phoneNumber: phoneNumber),
        const SizedBox(height: 32),
        OtpInput(
          controller: controller,
          errorText: errorText,
          onChanged: onOtpChanged,
          onCompleted: onOtpCompleted,
        ),
        const SizedBox(height: 32),
        OtpVerifyButton(
          isVerifying: isVerifying,
          otpSent: otpSent,
          onPressed: onVerifyPressed,
        ),
        const SizedBox(height: 16),
        OtpResendButton(
          isResending: isResending,
          isVerifying: isVerifying,
          cooldownSeconds: resendCooldownSeconds,
          onPressed: onResendPressed,
        ),
        const SizedBox(height: 24),
        if (otpSent) const OtpStatusIndicator(),
      ],
    );
  }
}

class OtpHeader extends StatelessWidget {
  final String phoneNumber;

  const OtpHeader({super.key, required this.phoneNumber});

  /// Returns a masked version of an E.164 phone number for display.
  /// e.g. "+919876543210" → "+91 ******3210" (PAT-11)
  static String _maskPhone(String phone) {
    final raw = phone.startsWith('+') ? phone.substring(1) : phone;
    final ccLen = raw.startsWith('91')
        ? 2
        : raw.startsWith('1')
        ? 1
        : 2;
    if (raw.length <= ccLen + 2) return phone;
    final cc = raw.substring(0, ccLen);
    final last2 = raw.substring(raw.length - 2);
    final masked = '*' * (raw.length - ccLen - 2);
    return '+$cc $masked$last2';
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    // The phone-entry → OTP-entry swap happens in place, so screen readers
    // get no notification that the UI changed. Announcing the header as a
    // live region when it appears tells the user they are now on the OTP
    // step (audit M18); MergeSemantics reads the three lines as one unit.
    return MergeSemantics(
      child: Semantics(
        liveRegion: true,
        child: Column(
          children: [
            Text(
              l.otpVerifyPhoneHeading,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall
                  ?.copyWith(fontWeight: FontWeight.bold, color: Colors.teal),
            ),
            const SizedBox(height: 8),
            Text(
              l.otpEnterDigits,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium
                  ?.copyWith(color: Colors.grey[600]),
            ),
            const SizedBox(height: 4),
            Text(
              _maskPhone(phoneNumber),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyLarge
                  ?.copyWith(fontWeight: FontWeight.w600, color: Colors.teal),
            ),
          ],
        ),
      ),
    );
  }
}

class OtpInput extends StatefulWidget {
  final TextEditingController controller;

  /// Inline error rendered below the pin cells inside a live region so
  /// screen readers announce it as soon as it appears (audit B3/H9).
  final String? errorText;
  final Function(String) onChanged;
  final Function(String) onCompleted;

  const OtpInput({
    super.key,
    required this.controller,
    this.errorText,
    required this.onChanged,
    required this.onCompleted,
  });

  @override
  State<OtpInput> createState() => _OtpInputState();
}

class _OtpInputState extends State<OtpInput> {
  late PinInputController _pinController;

  @override
  void initState() {
    super.initState();
    _pinController = PinInputController(textController: widget.controller);
  }

  @override
  void didUpdateWidget(covariant OtpInput oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      _pinController.dispose();
      _pinController = PinInputController(textController: widget.controller);
    }
    if (oldWidget.errorText != widget.errorText) {
      // Best-effort visual feedback (shake + error-colored cells). The
      // visible/announced error text below is rendered by this widget, not
      // the package: MaterialPinField's own error row only recomputes on a
      // rebuild and its controller error state is auto-cleared by input and
      // selection changes, which makes it unreliable as the source of truth.
      _syncErrorStatePostFrame();
    }
  }

  /// Pushes [OtpInput.errorText] into the pin controller's error state.
  ///
  /// Deferred to a post-frame callback because didUpdateWidget runs during
  /// build and the controller notifies listeners that call setState.
  void _syncErrorStatePostFrame() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (widget.errorText != null) {
        _pinController.triggerError();
      } else {
        _pinController.clearError();
      }
    });
  }

  @override
  void dispose() {
    _pinController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final pinField = MaterialPinField(
      length: 6,
      pinController: _pinController,
      keyboardType: TextInputType.number,
      autoFocus: true,
      // Accessible name + role: MaterialPinField wraps the cells in a single
      // Semantics(textField: true) node carrying this label, the current
      // value, and the hint below — one coherent announcement instead of six
      // unlabeled boxes (audit blocker B3).
      semanticLabel: l.otpFieldSemanticLabel,
      semanticHintBuilder: (filled, total) => filled < total
          ? l.otpDigitsRemaining(total - filled)
          : l.otpAllDigitsEntered,
      // Let the platform offer the incoming SMS code (Android SMS Retriever /
      // iOS security-code AutoFill).
      enableAutofill: true,
      autofillHints: const [AutofillHints.oneTimeCode],
      theme: MaterialPinTheme(
        shape: MaterialPinShape.outlined,
        borderRadius: BorderRadius.circular(12),
        cellSize: const Size(45, 55),
        borderWidth: 2,
        focusedBorderWidth: 2,
        // grey[300] on the grey[50] fill was 1.26:1 — effectively invisible
        // to low-vision users (audit M8). grey[600] clears the 3:1 WCAG
        // 1.4.11 non-text minimum against the hardcoded light fills.
        borderColor: Colors.grey[600]!,
        focusedBorderColor: Colors.orange,
        filledBorderColor: Colors.teal,
        completeBorderColor: Colors.teal,
        fillColor: Colors.grey[50]!,
        focusedFillColor: Colors.orange.withValues(alpha: 0.1),
        filledFillColor: Colors.teal.withValues(alpha: 0.1),
        completeFillColor: Colors.teal.withValues(alpha: 0.1),
        followingFillColor: Colors.grey[50]!,
        cursorColor: Colors.teal,
        entryAnimation: MaterialPinAnimation.fade,
        animationDuration: const Duration(milliseconds: 300),
      ),
      onChanged: widget.onChanged,
      onCompleted: widget.onCompleted,
    );

    // Inline error owned by this widget (not MaterialPinField's errorText —
    // see _syncErrorStatePostFrame). The live region makes TalkBack/
    // VoiceOver announce the error the moment it appears (audit H9), and it
    // persists until the user edits the code (WCAG 3.3.1), unlike the old
    // 2-second snackbar.
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        pinField,
        if (widget.errorText != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Semantics(
              liveRegion: true,
              child: Text(
                widget.errorText!,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class OtpVerifyButton extends StatelessWidget {
  final bool isVerifying;
  final bool otpSent;
  final VoidCallback onPressed;

  const OtpVerifyButton({
    super.key,
    required this.isVerifying,
    required this.otpSent,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return SizedBox(
      height: 50,
      child: ElevatedButton(
        onPressed: (isVerifying || !otpSent) ? null : onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: Colors.teal,
          foregroundColor: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          elevation: 2,
        ),
        // Live region: when verification starts (including the silent
        // auto-submit on the 6th digit) this "Verifying..." swap is announced
        // so screen-reader users know why the context changed (audit H10).
        child: isVerifying
            ? MergeSemantics(
                child: Semantics(
                  liveRegion: true,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const ExcludeSemantics(
                        child: SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            valueColor: AlwaysStoppedAnimation<Color>(
                              Colors.white,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Text(l.otpVerifying),
                    ],
                  ),
                ),
              )
            : Text(
                l.otpVerifyButtonText,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
      ),
    );
  }
}

class OtpResendButton extends StatelessWidget {
  final bool isResending;
  final bool isVerifying;

  /// Seconds left before another resend is allowed; while > 0 the button is
  /// disabled and shows the countdown.
  final int cooldownSeconds;
  final VoidCallback onPressed;

  const OtpResendButton({
    super.key,
    required this.isResending,
    required this.isVerifying,
    this.cooldownSeconds = 0,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final onCooldown = cooldownSeconds > 0;
    return TextButton(
      onPressed: (isResending || isVerifying || onCooldown) ? null : onPressed,
      style: TextButton.styleFrom(
        foregroundColor: Colors.teal,
        padding: const EdgeInsets.symmetric(vertical: 12),
      ),
      child: isResending
          ? Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 8),
                Text(AppLocalizations.of(context)!.otpResendingOtp),
              ],
            )
          : Text(
              onCooldown
                  ? 'Resend OTP in ${cooldownSeconds}s'
                  : AppLocalizations.of(context)!.otpDidntReceiveResend,
              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
            ),
    );
  }
}

class OtpStatusIndicator extends StatelessWidget {
  const OtpStatusIndicator({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.green.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.green.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.check_circle, color: Colors.green, size: 20),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              AppLocalizations.of(context)!.otpSentSuccess,
              style: const TextStyle(
                color: Colors.green,
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
