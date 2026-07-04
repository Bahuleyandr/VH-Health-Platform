import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../../core/providers/session_timeout_provider.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import '../services/login_service.dart';

// All seeded staff IDs use the `EMP-NNNN` format. Showing `EMP-` as a
// non-editable prefix on the field means the user only types the digits.
// If a different prefix becomes necessary later, change this constant +
// the validator below — LoginService's regex already accepts any 2-6
// letter prefix so the rest of the stack doesn't care.
const String _empIdPrefix = 'EMP-';

enum _LoginMode { password, pin, quickLogin }

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _empIdController = TextEditingController();
  final _passwordController = TextEditingController();
  final _pinController = TextEditingController();

  _LoginMode _mode = _LoginMode.password;
  bool _obscurePassword = true;
  bool _loading = false;
  bool _rememberMe = true;
  bool _deviceRegistered = false;
  String? _error;
  bool _isLockedOut = false;

  /// Matches the backend lockout message so we can render a distinct UI.
  /// Backend currently throws
  /// `Error('Account temporarily locked due to multiple failed attempts')`
  /// — match generously in case the wording evolves.
  static bool _looksLikeLockout(String msg) {
    final lower = msg.toLowerCase();
    return lower.contains('locked') ||
        lower.contains('too many') ||
        lower.contains('temporarily');
  }

  @override
  void initState() {
    super.initState();
    _loadSavedCredentials();
  }

  Future<void> _loadSavedCredentials() async {
    final saved = await AuthService.getSavedCredentials();
    if (saved != null && saved['employeeId'] != null && mounted) {
      // Saved value is the full ID (e.g. 'EMP-1001'); strip the prefix so
      // the field reflects only what the user types.
      final raw = saved['employeeId']!;
      setState(() {
        _empIdController.text = raw.startsWith(_empIdPrefix)
            ? raw.substring(_empIdPrefix.length)
            : raw;
      });
    }
    // Check if device is registered for quick login
    final registered = await AuthService.isDeviceRegistered();
    if (mounted && registered && _empIdController.text.isNotEmpty) {
      setState(() => _deviceRegistered = true);
    }
  }

  @override
  void dispose() {
    _empIdController.dispose();
    _passwordController.dispose();
    _pinController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _loading = true;
      _error = null;
      _isLockedOut = false;
    });
    // Reassemble the full ID (`EMP-NNNN`) — the field only collects the
    // digit portion now; LoginService still validates the full string.
    final employeeId = '$_empIdPrefix${_empIdController.text.trim()}';
    try {
      if (_mode == _LoginMode.quickLogin) {
        final deviceToken = await AuthService.getDeviceToken();
        await AuthService.quickLogin(
          employeeId: employeeId,
          pin: _pinController.text.isNotEmpty ? _pinController.text : null,
          deviceToken: deviceToken,
        );
      } else if (_mode == _LoginMode.password) {
        await LoginService.loginWithPassword(
          employeeId: employeeId,
          password: _passwordController.text,
        );
      } else {
        await LoginService.loginWithPin(
          employeeId: employeeId,
          pin: _pinController.text,
        );
      }
      if (mounted) {
        // Reset the idle-timeout flag BEFORE navigating. Without this, if a
        // previous session timed out (which sets `_expired = true` and wipes
        // the JWT via clearAll), the router's redirect guard would see
        // `isSessionExpired == true` on the very next /dashboard navigation
        // and bounce the freshly-logged-in user back to /login. Calling
        // resetSession() here flips `_expired` to false synchronously so the
        // redirect chain resolves to /dashboard on the first hop.
        try {
          context.read<SessionTimeoutProvider>().resetSession();
        } catch (_) {
          // Provider may not be in scope under unusual mount conditions —
          // the on-/login redirect path will still call startTracking().
        }
        context.go('/dashboard');
      }
    } catch (e) {
      final msg = e.toString().replaceFirst('Exception: ', '');
      setState(() {
        _error = msg;
        _isLockedOut = _looksLikeLockout(msg);
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final sessionTimeout = context.watch<SessionTimeoutProvider>();
    final preservedQueueCount = sessionTimeout.isSessionExpired
        ? sessionTimeout.preservedOfflineWriteCount
        : 0;
    return Scaffold(
      backgroundColor: AppTheme.primaryBlue,
      body: SafeArea(
        child: Column(
          children: [
            // Header
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
              child: Column(
                children: [
                  Container(
                    width: 80,
                    height: 80,
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: const Icon(
                      Icons.local_hospital,
                      size: 48,
                      color: AppTheme.primaryBlue,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    s.loginAppTitle,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 28,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 0.5,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    s.loginPortalSubtitle,
                    style: TextStyle(
                      color: Colors.white.withValues(alpha: 0.8),
                      fontSize: 15,
                    ),
                  ),
                ],
              ),
            ),

            // Card
            Expanded(
              child: Container(
                width: double.infinity,
                decoration: BoxDecoration(
                  color: AppTheme.backgroundGrey,
                  borderRadius: const BorderRadius.vertical(
                    top: Radius.circular(28),
                  ),
                ),
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(24),
                  child: Form(
                    key: _formKey,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const SizedBox(height: 8),
                        Text(
                          s.loginScreenTitle,
                          style: Theme.of(context).textTheme.headlineSmall
                              ?.copyWith(
                                fontWeight: FontWeight.bold,
                                color: AppTheme.textPrimary,
                              ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          s.loginScreenSubtitle,
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                        if (preservedQueueCount > 0) ...[
                          const SizedBox(height: 16),
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: AppTheme.warningAmber.withValues(
                                alpha: 0.12,
                              ),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(
                                color: AppTheme.warningAmber.withValues(
                                  alpha: 0.45,
                                ),
                              ),
                            ),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Icon(
                                  Icons.sync_problem_outlined,
                                  color: AppTheme.warningOnSurface,
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Text(
                                    s.sessionTimeoutPreservedQueue(
                                      preservedQueueCount,
                                    ),
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodyMedium
                                        ?.copyWith(
                                          color: AppTheme.textPrimary,
                                          fontWeight: FontWeight.w600,
                                        ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                        const SizedBox(height: 24),

                        // Employee ID — `EMP-` is a non-editable prefix; the
                        // submit handler reassembles the full ID before send.
                        TextFormField(
                          controller: _empIdController,
                          decoration: InputDecoration(
                            labelText: s.loginEmployeeIdLabel,
                            hintText: s.loginEmployeeIdHint,
                            prefixText: _empIdPrefix,
                            prefixIcon: const ExcludeSemantics(
                              child: Icon(Icons.badge_outlined),
                            ),
                          ),
                          keyboardType: TextInputType.number,
                          inputFormatters: [
                            FilteringTextInputFormatter.digitsOnly,
                            LengthLimitingTextInputFormatter(6),
                          ],
                          validator: (value) {
                            final n = (value ?? '').trim();
                            if (n.isEmpty) return s.loginEmployeeIdRequired;
                            if (!RegExp(r'^\d{1,6}$').hasMatch(n)) {
                              return s.loginEmployeeIdNumbersOnly;
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 16),

                        // Mode toggle
                        Row(
                          children: [
                            _ModeChip(
                              label: s.loginModePassword,
                              selected: _mode == _LoginMode.password,
                              onTap: () =>
                                  setState(() => _mode = _LoginMode.password),
                            ),
                            const SizedBox(width: 8),
                            _ModeChip(
                              label: s.loginModePin,
                              selected: _mode == _LoginMode.pin,
                              onTap: () =>
                                  setState(() => _mode = _LoginMode.pin),
                            ),
                            if (_deviceRegistered) ...[
                              const SizedBox(width: 8),
                              _ModeChip(
                                label: s.loginModeQuick,
                                selected: _mode == _LoginMode.quickLogin,
                                onTap: () => setState(
                                  () => _mode = _LoginMode.quickLogin,
                                ),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 16),

                        // Password / PIN / Quick login field
                        if (_mode == _LoginMode.quickLogin)
                          TextFormField(
                            controller: _pinController,
                            obscureText: true,
                            keyboardType: TextInputType.number,
                            maxLength: 6,
                            decoration: InputDecoration(
                              labelText: s.loginQuickPinLabel,
                              hintText: s.loginQuickPinHint,
                              prefixIcon: const ExcludeSemantics(
                                child: Icon(Icons.speed),
                              ),
                            ),
                            validator: (v) {
                              if (v == null || v.isEmpty) {
                                return s.loginPinRequired;
                              }
                              if (v.length < 4) return s.loginPinMinDigits;
                              return null;
                            },
                          )
                        else if (_mode == _LoginMode.password)
                          TextFormField(
                            controller: _passwordController,
                            obscureText: _obscurePassword,
                            decoration: InputDecoration(
                              labelText: s.loginPasswordLabel,
                              prefixIcon: const ExcludeSemantics(
                                child: Icon(Icons.lock_outlined),
                              ),
                              suffixIcon: IconButton(
                                icon: Icon(
                                  _obscurePassword
                                      ? Icons.visibility_outlined
                                      : Icons.visibility_off_outlined,
                                ),
                                onPressed: () => setState(
                                  () => _obscurePassword = !_obscurePassword,
                                ),
                              ),
                            ),
                            validator: LoginService.validatePassword,
                          )
                        else
                          TextFormField(
                            controller: _pinController,
                            obscureText: true,
                            keyboardType: TextInputType.number,
                            maxLength: 6,
                            decoration: InputDecoration(
                              labelText: s.loginPinFieldLabel,
                              hintText: s.loginPinHint,
                              prefixIcon: const ExcludeSemantics(
                                child: Icon(Icons.pin_outlined),
                              ),
                            ),
                            validator: (v) {
                              if (v == null || v.isEmpty) {
                                return s.loginPinRequired;
                              }
                              if (v.length < 4) return s.loginPinMinDigits;
                              return null;
                            },
                          ),

                        // Remember me
                        Row(
                          children: [
                            SizedBox(
                              height: 24,
                              width: 24,
                              child: Checkbox(
                                value: _rememberMe,
                                activeColor: AppTheme.primaryBlue,
                                onChanged: (v) =>
                                    setState(() => _rememberMe = v ?? true),
                              ),
                            ),
                            const SizedBox(width: 8),
                            GestureDetector(
                              onTap: () =>
                                  setState(() => _rememberMe = !_rememberMe),
                              child: Text(
                                s.loginRememberEmployeeId,
                                style: TextStyle(
                                  color: AppTheme.textSecondary,
                                  fontSize: 13,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),

                        if (_error != null) ...[
                          const SizedBox(height: 12),
                          _isLockedOut
                              ? Container(
                                  padding: const EdgeInsets.all(14),
                                  decoration: BoxDecoration(
                                    color: AppTheme.warningAmber.withValues(
                                      alpha: 0.12,
                                    ),
                                    borderRadius: BorderRadius.circular(10),
                                    border: Border.all(
                                      color: AppTheme.warningAmber.withValues(
                                        alpha: 0.5,
                                      ),
                                      width: 1.5,
                                    ),
                                  ),
                                  child: Row(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      const Icon(
                                        Icons.lock_clock,
                                        color: AppTheme.warningAmber,
                                        size: 22,
                                      ),
                                      const SizedBox(width: 10),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              s.loginLockedTitle,
                                              style: const TextStyle(
                                                color: AppTheme.warningAmber,
                                                fontSize: 14,
                                                fontWeight: FontWeight.w700,
                                              ),
                                            ),
                                            const SizedBox(height: 4),
                                            Text(
                                              _error!,
                                              style: const TextStyle(
                                                color: AppTheme.warningAmber,
                                                fontSize: 12.5,
                                              ),
                                            ),
                                            const SizedBox(height: 6),
                                            Text(
                                              s.loginLockedHint,
                                              style: const TextStyle(
                                                color: AppTheme.warningAmber,
                                                fontSize: 11.5,
                                                fontStyle: FontStyle.italic,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                    ],
                                  ),
                                )
                              : Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: AppTheme.errorRed.withValues(
                                      alpha: 0.08,
                                    ),
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(
                                      color: AppTheme.errorRed.withValues(
                                        alpha: 0.3,
                                      ),
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      const Icon(
                                        Icons.error_outline,
                                        color: AppTheme.errorRed,
                                        size: 18,
                                      ),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: Text(
                                          _error!,
                                          style: const TextStyle(
                                            color: AppTheme.errorRed,
                                            fontSize: 13,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                        ],

                        const SizedBox(height: 24),

                        ElevatedButton(
                          onPressed: _loading ? null : _submit,
                          child: _loading
                              ? const SizedBox(
                                  height: 22,
                                  width: 22,
                                  child: CircularProgressIndicator(
                                    color: Colors.white,
                                    strokeWidth: 2.5,
                                  ),
                                )
                              : Text(
                                  _mode == _LoginMode.password
                                      ? s.loginSignInWithPassword
                                      : _mode == _LoginMode.quickLogin
                                      ? s.loginQuickSignIn
                                      : s.loginSignInWithPin,
                                ),
                        ),

                        const SizedBox(height: 32),

                        // Footer
                        Center(
                          child: Text(
                            s.loginFooter,
                            style: TextStyle(
                              color: AppTheme.textSecondary,
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ModeChip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _ModeChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
        decoration: BoxDecoration(
          color: selected ? AppTheme.primaryBlue : Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(
            color: selected ? AppTheme.primaryBlue : AppTheme.divider,
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: selected ? Colors.white : AppTheme.textSecondary,
            fontWeight: FontWeight.w600,
            fontSize: 13,
          ),
        ),
      ),
    );
  }
}
