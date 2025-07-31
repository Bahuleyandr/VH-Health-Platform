// otp_ui_components.dart - All UI components
import 'package:flutter/material.dart';
import 'package:pin_code_fields/pin_code_fields.dart';

class OtpForm extends StatelessWidget {
  final String phoneNumber;
  final TextEditingController controller;
  final bool otpSent;
  final bool isVerifying;
  final bool isResending;
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

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(
          "Verify Your Phone Number",
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.bold,
            color: Colors.teal,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          "Enter the 6-digit OTP sent to",
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: Colors.grey[600],
          ),
        ),
        const SizedBox(height: 4),
        Text(
          phoneNumber,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyLarge?.copyWith(
            fontWeight: FontWeight.w600,
            color: Colors.teal,
          ),
        ),
      ],
    );
  }
}

class OtpInput extends StatelessWidget {
  final TextEditingController controller;
  final Function(String) onChanged;
  final Function(String) onCompleted;

  const OtpInput({
    super.key,
    required this.controller,
    required this.onChanged,
    required this.onCompleted,
  });

  @override
  Widget build(BuildContext context) {
    return PinCodeTextField(
      appContext: context,
      length: 6,
      controller: controller,
      keyboardType: TextInputType.number,
      animationType: AnimationType.fade,
      autoFocus: true,
      pinTheme: PinTheme(
        shape: PinCodeFieldShape.box,
        borderRadius: BorderRadius.circular(12),
        fieldHeight: 55,
        fieldWidth: 45,
        borderWidth: 2,
        activeColor: Colors.teal,
        selectedColor: Colors.orange,
        inactiveColor: Colors.grey[300]!,
        activeFillColor: Colors.teal.withOpacity(0.1),
        selectedFillColor: Colors.orange.withOpacity(0.1),
        inactiveFillColor: Colors.grey[50]!,
      ),
      enableActiveFill: true,
      cursorColor: Colors.teal,
      animationDuration: const Duration(milliseconds: 300),
      onChanged: onChanged,
      onCompleted: onCompleted,
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
        child: isVerifying
            ? const Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                    ),
                  ),
                  SizedBox(width: 12),
                  Text('Verifying...'),
                ],
              )
            : const Text(
                'Verify OTP',
                style: TextStyle(
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
  final VoidCallback onPressed;

  const OtpResendButton({
    super.key,
    required this.isResending,
    required this.isVerifying,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: (isResending || isVerifying) ? null : onPressed,
      style: TextButton.styleFrom(
        foregroundColor: Colors.teal,
        padding: const EdgeInsets.symmetric(vertical: 12),
      ),
      child: isResending
          ? const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                SizedBox(width: 8),
                Text("Resending OTP..."),
              ],
            )
          : const Text(
              "Didn't receive OTP? Resend",
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
              ),
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
        color: Colors.green.withOpacity(0.1),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.green.withOpacity(0.3)),
      ),
      child: const Row(
        children: [
          Icon(Icons.check_circle, color: Colors.green, size: 20),
          SizedBox(width: 8),
          Expanded(
            child: Text(
              "OTP has been sent to your phone number",
              style: TextStyle(
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