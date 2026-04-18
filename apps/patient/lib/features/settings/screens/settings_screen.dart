// settings_screen.dart

import 'package:flutter/material.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/features/settings/widgets/settings_sections.dart';
import 'package:vhhealth/features/settings/controllers/settings_controller.dart';

class SettingsScreen extends StatefulWidget {
  final String phone;
  final String name;

  const SettingsScreen({
    super.key,
    required this.phone,
    required this.name,
  });

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final SettingsController controller;
  bool _initialized = false;

  @override
  void initState() {
    super.initState();
    // ✅ Fixed: No context passed to constructor
    controller = SettingsController(widget.phone, widget.name, refresh);
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
      return const Scaffold(
        body: Center(
          child: CircularProgressIndicator(),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(controller.loc.settingsTitle),
        elevation: 0,
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