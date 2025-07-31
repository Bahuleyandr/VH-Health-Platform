// Updated dashboard_screen.dart - Compliant with your routes.dart
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:http/http.dart' as http;

import 'package:vhhealth/core/widgets/language_dropdown.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/core/widgets/circular_feature_dial.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/logout_button.dart';

class DashboardScreen extends StatefulWidget {
  final String name;
  final String phone;
  final String? lastAppointment;
  final String? nextAppointment;

  const DashboardScreen({
    super.key,
    required this.name,
    required this.phone,
    this.lastAppointment,
    this.nextAppointment,
  });

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen>
    with SingleTickerProviderStateMixin {
  final _secureStorage = const FlutterSecureStorage();
  String? lastAppointment;
  String? nextAppointment;
  String? cachedName;

  late final AnimationController _controller;
  Color _focusColor = Colors.transparent;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..forward();

    _loadCachedData();
    _maybeFetchFromBackend();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _loadCachedData() async {
    final last = await _secureStorage.read(key: 'lastAppointment');
    final next = await _secureStorage.read(key: 'nextAppointment');
    final name = await _secureStorage.read(key: 'userName');
    if (mounted) {
      setState(() {
        lastAppointment = last ?? widget.lastAppointment;
        nextAppointment = next ?? widget.nextAppointment;
        cachedName = name ?? widget.name;
      });
    }
  }

  Future<void> _maybeFetchFromBackend() async {
    final fetched = await _secureStorage.read(key: 'fetched_dashboard');
    if (!mounted || fetched == 'true') return;
    await _fetchAndStoreDashboard();
  }

  Future<void> _fetchAndStoreDashboard() async {
    try {
      final uri = Uri.parse('https://your-api.com/dashboard?phone=${widget.phone}');
      final res = await http.get(uri);
      if (!mounted) return;

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final name = data['name'] ?? widget.name;
        final last = data['lastAppointment'];
        final next = data['nextAppointment'];

        await _secureStorage.write(key: 'userName', value: name);
        await _secureStorage.write(key: 'lastAppointment', value: last);
        await _secureStorage.write(key: 'nextAppointment', value: next);
        await _secureStorage.write(key: 'fetched_dashboard', value: 'true');

        if (mounted) {
          setState(() {
            cachedName = name;
            lastAppointment = last;
            nextAppointment = next;
          });
        }
      }
    } on SocketException {
      // silent
    } catch (_) {
      // silent
    }
  }

  Future<void> _onRefresh() async {
    await _fetchAndStoreDashboard();
  }

  void _openFeature(BuildContext context, String routeName) {
    // Prepare arguments for the route
    final args = <String, dynamic>{  // Changed to dynamic to support Color
      'phone': widget.phone,
      'name': cachedName ?? widget.name,
      'color': _focusColor,  // Pass Color object directly
    };

    // Navigate outside of tab context using rootNavigator
    Navigator.of(context, rootNavigator: true).pushNamed(
      routeName, 
      arguments: args,
    );
  }

  void _toggleTheme() =>
      Provider.of<ThemeProvider>(context, listen: false).toggleTheme();
  void _toggleAccessibility() =>
      Provider.of<ThemeProvider>(context, listen: false).toggleFontSize();

  Future<void> _triggerSOS() async {
    final l10n = AppLocalizations.of(context)!;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(l10n.authSosTriggered)),
    );
    await SOSService.triggerSOS();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final bgColor = theme.scaffoldBackgroundColor;
    final nameToShow = cachedName ?? widget.name;

    final features = [
      FeatureIconData(
        icon: LucideIcons.stethoscope,
        label: l10n.yourHealth,
        color: const Color(0xFFA8E6CF),
        onTap: (ctx) => _openFeature(ctx, '/your-health'),
      ),
      FeatureIconData(
        icon: LucideIcons.calendarCheck,
        label: l10n.appointments,
        color: const Color(0xFFB3E5FC),
        onTap: (ctx) => _openFeature(ctx, '/appointments'),
      ),
      FeatureIconData(
        icon: LucideIcons.pill,
        label: l10n.pharmacy,
        color: const Color(0xFFD1C4E9),
        onTap: (ctx) => _openFeature(ctx, '/pharmacy'),
      ),
      FeatureIconData(
        icon: LucideIcons.flaskConical,
        label: l10n.investigations,
        color: const Color(0xFF80DEEA),
        onTap: (ctx) => _openFeature(ctx, '/investigations'),
      ),
      FeatureIconData(
        icon: LucideIcons.helpCircle,
        label: l10n.askDoubt,
        color: const Color(0xFFFFE082),
        onTap: (ctx) => _openFeature(ctx, '/ask-a-doubt'),
      ),
      FeatureIconData(
        icon: LucideIcons.brainCircuit,
        label: l10n.triviaLabel,
        color: const Color(0xFF9FA8DA),
        onTap: (ctx) => _openFeature(ctx, '/trivia'),
      ),
      FeatureIconData(
        icon: LucideIcons.building2,
        label: l10n.departments,
        color: const Color(0xFFC5E1A5),
        onTap: (ctx) => _openFeature(ctx, '/departments'),
      ),
      FeatureIconData(
        icon: LucideIcons.info,
        label: l10n.aboutUsLabel,
        color: const Color(0xFFFFCCBC),
        onTap: (ctx) => _openFeature(ctx, '/about-us'),
      ),
    ];

    return Scaffold(
      appBar: AppBar(
        title: Text('${l10n.hello}, ${nameToShow == 'Guest' ? nameToShow : '$nameToShow!'}'),
        actions: [
          IconButton(icon: const Icon(Icons.brightness_6), onPressed: _toggleTheme),
          IconButton(icon: const Icon(Icons.accessibility), onPressed: _toggleAccessibility),
          PopupMenuButton<int>(
            tooltip: 'Change Language',
            offset: const Offset(0, 40),
            icon: const Icon(Icons.language),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            itemBuilder: (_) => [
              const PopupMenuItem<int>(
                value: 0,
                enabled: false,
                padding: EdgeInsets.zero,
                child: SizedBox(width: 150, child: LanguageDropdown()),
              ),
            ],
          ),
          LogoutButton(style: LogoutButtonStyle.iconOnly),
        ],
      ),
      body: AnimatedContainer(
        duration: const Duration(milliseconds: 500),
        decoration: BoxDecoration(
          gradient: RadialGradient(
            center: Alignment.center,
            radius: 1.0,
            colors: [bgColor, _focusColor.withAlpha(102)],
          ),
        ),
        child: LogoBackground(
          child: SafeArea(
            child: RefreshIndicator(
              onRefresh: _onRefresh,
              child: ListView(
                shrinkWrap: true,
                physics: const AlwaysScrollableScrollPhysics(), 
                padding: const EdgeInsets.all(16),
                children: [
                  if (nameToShow != 'Guest') ...[
                    Container(
                      margin: const EdgeInsets.only(top: 4, bottom: 20),
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                      decoration: BoxDecoration(
                        color: cs.surfaceContainerHighest.withAlpha(77),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(l10n.lastAppointment, style: theme.textTheme.labelSmall?.copyWith(fontWeight: FontWeight.bold)),
                          const SizedBox(height: 4),
                          Text(lastAppointment ?? l10n.notAvailable, style: theme.textTheme.bodySmall),
                          const SizedBox(height: 12),
                          Text(l10n.upcomingAppointment, style: theme.textTheme.labelSmall?.copyWith(fontWeight: FontWeight.bold)),
                          const SizedBox(height: 4),
                          Text(nextAppointment ?? l10n.notAvailable, style: theme.textTheme.bodySmall),
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: 12),
                  CircularFeatureDial(
                    features: features,
                    onFocusColorChanged: (color) => setState(() => _focusColor = color),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        heroTag: 'sos',
        tooltip: l10n.authSosTooltip,
        backgroundColor: Colors.red,
        onPressed: _triggerSOS,
        child: const Icon(Icons.favorite),
      ),
    );
  }
}