// abha_enrolment_flow.dart
//
// Patient self-enrolment for a NEW ABHA via Aadhaar OTP — the Flutter half of
// P13/#809. The backend flow (migration 701, /portal/abdm/enrolment/*) shipped
// complete: start → OTP verify → enrolled/linked, with resend + cancel. Until
// 2026-08-23 the app only supported LINKING an existing ABHA, so a patient
// without one could not enrol from the app at all.
//
// String style matches the surrounding ABDM screen (English-first, like the
// link form beside it).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:vhhealth/core/services/api_client.dart';

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

  Future<void> _start() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await ApiClient.post(
        '/portal/abdm/enrolment/start',
        body: {
          'flow': 'aadhaar_otp',
          'aadhaar_number': _aadhaarController.text.replaceAll(
            RegExp(r'\D'),
            '',
          ),
          if (_mobileController.text.trim().isNotEmpty)
            'mobile': _mobileController.text.trim(),
        },
      );
      if (!mounted) return;
      final session = _sessionFrom(response.dataAsMap());
      if (response.isSuccess && session != null) {
        setState(() {
          _sessionId = (session['id'] as num?)?.toInt();
          _mobileLast4 = session['mobile_last4']?.toString();
          _step = _Step.otp;
        });
        _startCooldown();
      } else {
        setState(
          () => _error = response.failureMessage(
            'Could not start ABHA enrolment. Please retry.',
          ),
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not reach the server: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final otp = _otpController.text.trim();
    if (otp.length != 6) {
      setState(() => _error = 'Enter the 6-digit OTP');
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
          _error =
              'One more step — a new OTP has been sent'
              '${_mobileLast4 != null ? ' to ••$_mobileLast4' : ''}.';
        });
        _startCooldown();
      } else {
        setState(
          () => _error = response.failureMessage(
            'OTP verification failed. Please retry.',
          ),
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not reach the server: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resend() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await ApiClient.post(
        '/portal/abdm/enrolment/resend',
        body: {'session_id': _sessionId},
      );
      if (!mounted) return;
      if (response.isSuccess) {
        _startCooldown();
      } else {
        setState(
          () => _error = response.failureMessage('Could not resend the OTP.'),
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not reach the server: $e');
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
    return SingleChildScrollView(
      key: const ValueKey('abha_enrolment_flow'),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Create a new ABHA',
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            _step == _Step.aadhaar
                ? 'Your ABHA is created with Aadhaar OTP verification. The '
                      'OTP goes to the mobile number linked with your Aadhaar.'
                : _step == _Step.otp
                ? 'Enter the OTP sent to your Aadhaar-linked mobile'
                      '${_mobileLast4 != null ? ' (••$_mobileLast4)' : ''}.'
                : 'Your ABHA is ready and linked to your hospital record.',
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
          if (_step == _Step.aadhaar) _buildAadhaarStep(),
          if (_step == _Step.otp) _buildOtpStep(),
          if (_step == _Step.done) _buildDoneStep(theme),
        ],
      ),
    );
  }

  Widget _buildAadhaarStep() {
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
            decoration: const InputDecoration(
              labelText: 'Aadhaar number *',
              hintText: '12-digit Aadhaar',
              prefixIcon: Icon(Icons.fingerprint),
              border: OutlineInputBorder(),
              counterText: '',
            ),
            validator: (v) {
              final digits = (v ?? '').replaceAll(RegExp(r'\D'), '');
              if (digits.length != 12) {
                return 'Aadhaar number must be 12 digits';
              }
              return null;
            },
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _mobileController,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(
              labelText: 'Mobile for ABHA (optional)',
              hintText: 'Defaults to your Aadhaar-linked mobile',
              prefixIcon: Icon(Icons.phone_android),
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : _cancel,
                  child: const Text('Back'),
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
                      : const Text('Send OTP'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildOtpStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const ValueKey('enrolment_otp'),
          controller: _otpController,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          maxLength: 6,
          decoration: const InputDecoration(
            labelText: 'OTP *',
            prefixIcon: Icon(Icons.sms_outlined),
            border: OutlineInputBorder(),
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
                  ? 'Resend OTP (${_resendCooldown}s)'
                  : 'Resend OTP',
            ),
          ),
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: _busy ? null : _cancel,
                child: const Text('Cancel'),
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
                    : const Text('Verify'),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildDoneStep(ThemeData theme) {
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
          child: const Text('View my ABHA'),
        ),
      ],
    );
  }
}
