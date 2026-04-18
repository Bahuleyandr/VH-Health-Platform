import 'package:flutter/material.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/features/auth/widgets/login_form.dart';
import 'package:vhhealth/core/widgets/language_dropdown.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: LogoBackground(
        child: SafeArea(
          child: Stack(
            children: [
              const LoginForm(),
              // ── Top-right language selector ──
              Positioned(
                top: 8,
                right: 8,
                child: Material(
                  color: Colors.transparent,
                  child: PopupMenuButton<int>(
                    icon: const Icon(Icons.language, color: Colors.black87),
                    tooltip: 'Change Language',
                    offset: const Offset(0, 40),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                    itemBuilder: (_) => [
                      const PopupMenuItem<int>(
                        value: 0,
                        enabled: false,
                        child: SizedBox(
                          width: 160,
                          child: LanguageDropdown(),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
