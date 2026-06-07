// settings_screen.dart

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/features/settings/widgets/settings_sections.dart';
import 'package:vhhealth/features/settings/controllers/settings_controller.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final SettingsController controller;
  bool _initialized = false;

  @override
  void initState() {
    super.initState();
    // Context is passed to controller.initialize() later (see didChangeDependencies).
    final user = context.read<UserProvider>();
    controller = SettingsController(
      user.phone,
      user.name,
      refresh,
      hospitalNumber: user.hospitalNumber,
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_initialized) {
      // ✅ Fixed: Pass context to initialize when it's ready
      controller.initialize(context);
      controller.loadAll(); // handles biometric, permissions etc.
      _initialized = true;
    }
  }

  void refresh() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    // ✅ Guard against uninitialized controller
    if (!_initialized) {
      return Scaffold(
        appBar: AppBar(
          leading: BackButton(onPressed: () => context.go('/home')),
        ),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(controller.loc.settingsTitle),
        elevation: 0,
        leading: BackButton(onPressed: () => context.go('/home')),
      ),
      body: LogoBackground(
        child: SafeArea(
          child: ListView(
            shrinkWrap: true,
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(8, 16, 8, 16),
            children: buildSettingsSections(controller),
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: controller.triggerSOS,
        tooltip: controller.loc.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.favorite),
      ),
    );
  }
}
