// lib/features/onboarding/permission_gate.dart
import 'package:go_router/go_router.dart';

import 'package:flutter/material.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/features/auth/screens/login_screen.dart';

class PermissionGate extends StatefulWidget {
  const PermissionGate({super.key});
  
  @override
  State<PermissionGate> createState() => _PermissionGateState();
}

class _PermissionGateState extends State<PermissionGate> {
  @override
  void initState() {
    super.initState();
    // Minimal delay before proceeding
    WidgetsBinding.instance.addPostFrameCallback((_) => _handleStartup());
  }

  Future<void> _handleStartup() async {
    // Only request notification permission at startup
    // Don't block the user even if they deny
    await PermissionsService.requestStartupPermissions(context);
    
    if (!mounted) return;
    
    // Always proceed to login regardless of permission status
    context.go('/login');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // Your app logo
            Image.asset(
              'assets/images/logo.png',
              height: 120,
            ),
            const SizedBox(height: 24),
            const CircularProgressIndicator(),
            const SizedBox(height: 16),
            Text(
              'Setting up...',
              style: Theme.of(context).textTheme.bodyLarge,
            ),
          ],
        ),
      ),
    );
  }
}