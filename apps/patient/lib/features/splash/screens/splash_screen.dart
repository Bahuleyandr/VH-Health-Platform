import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;

import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth_core/config/api_config.dart';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/device_integrity_service.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with TickerProviderStateMixin {
  late final AnimationController _pulseController;
  late final Animation<double> _pulse;

  late final AnimationController _entryController;
  late final Animation<double> _bodyFade;
  late final Animation<double> _hintFade;

  final _localAuth = LocalAuthentication();
  final _secureStorage = const FlutterSecureStorage();

  Timer? _autoAdvanceTimer;
  bool _navigating = false;

  @override
  void initState() {
    super.initState();

    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat(reverse: true);
    _pulse = Tween<double>(begin: 0.9, end: 1.1).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );

    // Entry fade — the logo + title fade in over the first ~500ms, the
    // "tap" hint fades in slightly later (~900ms onwards) so it doesn't
    // appear glued to the logo on first paint.
    _entryController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
    _bodyFade = CurvedAnimation(
      parent: _entryController,
      curve: const Interval(0.0, 0.45, curve: Curves.easeOut),
    );
    _hintFade = CurvedAnimation(
      parent: _entryController,
      curve: const Interval(0.55, 1.0, curve: Curves.easeOut),
    );
    _entryController.forward();

    // Debug-only auto-login: emulator / CI runs can't tap reliably and
    // can't complete a real Firebase OTP. With VH_AUTO_DEV_LOGIN=true at
    // build time, we bypass the tap-to-continue + login flow and route
    // straight to the dashboard with a JWT from /auth/dev/patient-login.
    final autoDev =
        kDebugMode &&
        const bool.fromEnvironment('VH_AUTO_DEV_LOGIN', defaultValue: false);
    if (autoDev) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _autoDevLogin());
      return;
    }

    // Auto-advance after a short dwell so users don't have to tap on every
    // cold start. Tap still works as a skip — the tap handler cancels the
    // timer via the _navigating guard.
    _autoAdvanceTimer = Timer(const Duration(milliseconds: 1800), () {
      if (mounted && !_navigating) _handleSplashTap();
    });
  }

  Future<void> _autoDevLogin() async {
    _navigating = true;
    try {
      // Phone + name overridable at build time so the same APK can
      // exercise either the existing-user flow (default Dev Patient)
      // or the fresh-user → profile-setup flow by pointing at a
      // never-seen phone like +919999999997.
      const devPhone = String.fromEnvironment(
        'VH_DEV_PHONE',
        defaultValue: '+919999999999',
      );
      const devName = String.fromEnvironment(
        'VH_DEV_NAME',
        defaultValue: 'Dev Patient',
      );
      final url = Uri.parse('${ApiConfig.baseUrl}/auth/dev/patient-login');
      final resp = await http
          .post(
            url,
            headers: ApiConfig.jsonHeaders,
            body: jsonEncode({
              'phone': devPhone,
              'name': devName,
              'deviceType': 'mobile',
            }),
          )
          .timeout(const Duration(seconds: 10));
      if (resp.statusCode != 200) {
        developer.log(
          'Auto dev-login HTTP ${resp.statusCode}: ${resp.body}',
          name: 'Splash',
        );
        return;
      }
      final body = jsonDecode(resp.body) as Map<String, dynamic>;
      final data = body['data'] as Map<String, dynamic>?;
      final token = data?['accessToken'] as String?;
      final user = data?['user'] as Map<String, dynamic>?;
      final phone = (user?['phone'] as String?) ?? '+919999999999';
      final name = (user?['name'] as String?) ?? 'Dev Patient';
      final hospitalNumber =
          (user?['hospital_number'] ?? user?['hospitalNumber'] ?? '')
              .toString();
      final userId = (user?['id'] ?? '').toString();
      final userUid = (user?['uid'] ?? '').toString();
      final isNewUser = data?['isNewUser'] == true;
      if (token == null || token.isEmpty) return;

      await _secureStorage.write(key: 'jwt', value: token);
      await _secureStorage.write(key: 'user_phone', value: phone);
      await _secureStorage.write(key: 'user_name', value: name);
      if (userId.isNotEmpty) {
        await _secureStorage.write(key: 'user_id', value: userId);
        await _secureStorage.write(key: 'patient_id', value: userId);
      } else {
        await _secureStorage.delete(key: 'user_id');
        await _secureStorage.delete(key: 'patient_id');
      }
      if (userUid.isNotEmpty) {
        await _secureStorage.write(key: 'firebase_uid', value: userUid);
      } else {
        await _secureStorage.delete(key: 'firebase_uid');
      }
      if (hospitalNumber.isNotEmpty) {
        await _secureStorage.write(
          key: 'hospital_number',
          value: hospitalNumber,
        );
      }
      await _secureStorage.write(key: 'isNewUser', value: isNewUser.toString());

      if (!mounted) return;
      // Populate the Provider tree so the dashboard greeting + dashboard's
      // /dashboard?phone= probe see the right value on first paint.
      try {
        // ignore: use_build_context_synchronously
        context.read<UserProvider>().setUser(
          phone,
          name,
          hospitalNumber: hospitalNumber.isEmpty ? null : hospitalNumber,
        );
      } catch (e) {
        developer.log(
          'Auto dev-login: UserProvider sync failed: $e',
          name: 'Splash',
        );
      }
      if (!mounted) return;
      // /profile-setup needs the phone via state.extra so the form's
      // submit can pass it to /complete-profile. Without this the form
      // submitted with phone='' and the validator rejected (400).
      if (isNewUser) {
        context.go('/profile-setup', extra: phone);
      } else {
        context.go('/home');
      }
    } catch (e, st) {
      developer.log(
        'Auto dev-login failed: $e',
        name: 'Splash',
        stackTrace: st,
      );
    }
  }

  @override
  void dispose() {
    _autoAdvanceTimer?.cancel();
    _pulseController.dispose();
    _entryController.dispose();
    super.dispose();
  }

  Future<void> _showIntegrityBlocker(DeviceIntegrityResult integrity) async {
    if (!mounted) return;
    final l = AppLocalizations.of(context)!;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: Text(l.splashDeviceNotSupported),
        content: Text(
          '${l.splashDeviceNotSupportedBody} '
          '${integrity.reasons.join(', ')}. '
          'Please use a standard, unmodified phone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  Future<void> _handleSplashTap() async {
    if (_navigating) return;
    _navigating = true;
    _autoAdvanceTimer?.cancel();

    // Device integrity gate — run first so a compromised device never
    // reaches any auth code path.
    final integrity = await DeviceIntegrityService.check();
    if (integrity.shouldBlock) {
      await _showIntegrityBlocker(integrity);
      // User is stuck on splash with the blocker dismissed — release the
      // navigation guard so a subsequent tap can re-trigger the check.
      _navigating = false;
      return;
    }

    try {
      final firebaseUser = FirebaseAuth.instance.currentUser;
      final jwt = await _secureStorage.read(key: 'jwt');
      final phone = await _secureStorage.read(key: 'user_phone');
      final biometricEnabled = await _secureStorage.read(
        key: 'biometric_enabled',
      );

      // Populate UserProvider from storage before navigating off the splash,
      // so route-level screens can read identity from the Provider tree
      // instead of being threaded phone/name through their constructors.
      // No-op for fresh installs (keys absent → provider stays Guest).
      if (mounted) {
        await context.read<UserProvider>().loadFromStorage();
      }

      if (phone == 'guest' && mounted) {
        context.go('/home');
        return;
      }

      // ── 1. Firebase + JWT available → check profile, then dashboard ──
      if (firebaseUser != null && jwt != null && mounted) {
        final name = await _secureStorage.read(key: 'user_name');
        final isNewUser = await _secureStorage.read(key: 'isNewUser');

        // Profile completion gate: new users or users without a name
        if (isNewUser == 'true' ||
            (name == null && phone != null && phone.isNotEmpty)) {
          if (!mounted) return;
          context.go('/profile-setup', extra: phone ?? '');
          return;
        }
        if (!mounted) return;
        context.go('/home');
        return;
      }

      // ── 2. Try biometric auth if enabled ──
      if (biometricEnabled == 'true' && phone != null) {
        try {
          final canAuth = await _localAuth.canCheckBiometrics;
          final supported = await _localAuth.isDeviceSupported();

          if (canAuth && supported) {
            final didAuth = await _localAuth.authenticate(
              localizedReason: 'Please authenticate to continue',
              biometricOnly: true,
            );

            if (didAuth && mounted) {
              final name = await _secureStorage.read(key: 'user_name');
              final isNewUser = await _secureStorage.read(key: 'isNewUser');

              if (isNewUser == 'true' || name == null) {
                if (!mounted) return;
                context.go('/profile-setup', extra: phone);
                return;
              }
              if (!mounted) return;
              context.go('/home');
              return;
            }
          }
        } catch (e) {
          // Biometric failed (hardware error, user cancelled, etc.) — fall through to login
          debugPrint('Biometric auth failed: $e');
        }
      }
    } catch (e) {
      // Storage read or Firebase check failed — fall through to login
      debugPrint('Splash startup error: $e');
    }

    // ── 3. Default fallback → Login ──
    if (mounted) {
      context.go('/login');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: _handleSplashTap,
        child: Stack(
          fit: StackFit.expand,
          children: [
            ColorFiltered(
              colorFilter: ColorFilter.mode(
                Colors.black.withValues(alpha: 0.4),
                BlendMode.darken,
              ),
              child: Image.asset(
                'assets/images/hospital_bg.jpg',
                fit: BoxFit.cover,
              ),
            ),
            Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                FadeTransition(
                  opacity: _bodyFade,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ScaleTransition(
                        scale: _pulse,
                        child: Image.asset(
                          'assets/images/logo.png',
                          width: 120,
                          height: 120,
                        ),
                      ),
                      const SizedBox(height: 20),
                      const Text(
                        'VH Health',
                        style: TextStyle(
                          fontSize: 28,
                          fontFamily: 'VHFont',
                          color: Colors.white,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 10),
                FadeTransition(
                  opacity: _hintFade,
                  child: Text(
                    AppLocalizations.of(context)!.splashTapAnywhere,
                    style: const TextStyle(color: Colors.white70, fontSize: 14),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
