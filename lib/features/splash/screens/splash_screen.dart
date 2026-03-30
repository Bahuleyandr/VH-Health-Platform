import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/navigation/app_router.dart';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import 'package:firebase_auth/firebase_auth.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _pulse;

  final _localAuth = LocalAuthentication();
  final _secureStorage = const FlutterSecureStorage();

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat(reverse: true);

    _pulse = Tween<double>(begin: 0.9, end: 1.1).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _handleSplashTap() async {
    try {
      final firebaseUser = FirebaseAuth.instance.currentUser;
      final jwt = await _secureStorage.read(key: 'jwt');
      final phone = await _secureStorage.read(key: 'user_phone');
      final biometricEnabled = await _secureStorage.read(key: 'biometric_enabled');

      // ── 1. Firebase + JWT available → check profile, then dashboard ──
      if (firebaseUser != null && jwt != null && mounted) {
        final name = await _secureStorage.read(key: 'user_name');
        final isNewUser = await _secureStorage.read(key: 'isNewUser');
        AppRouter.setUserData(phone ?? '', name ?? 'User');

        // Profile completion gate: new users or users without a name
        if (isNewUser == 'true' || (name == null && phone != null && phone.isNotEmpty)) {
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
              options: const AuthenticationOptions(biometricOnly: true),
            );

            if (didAuth && mounted) {
              final name = await _secureStorage.read(key: 'user_name');
              final isNewUser = await _secureStorage.read(key: 'isNewUser');
              AppRouter.setUserData(phone, name ?? 'User');

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
                Colors.black.withOpacity(0.4),
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
                const SizedBox(height: 10),
                const Text(
                  'Tap anywhere to continue',
                  style: TextStyle(color: Colors.white70, fontSize: 14),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
