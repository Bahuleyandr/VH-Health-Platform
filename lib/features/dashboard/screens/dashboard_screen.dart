import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';

import 'package:vhhealth/core/widgets/language_dropdown.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/core/widgets/circular_feature_dial.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/logout_button.dart';
import 'package:vhhealth/core/theme/theme_colors.dart';

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

class _DashboardScreenState extends State<DashboardScreen> {
  final _secureStorage = const FlutterSecureStorage();
  String? lastAppointment;
  String? nextAppointment;
  String? cachedName;
  Color _focusColor = Colors.blue;
  
  // Features list - initialized once
  late final List<FeatureIconData> _features;

  @override
  void initState() {
    super.initState();
    
    // Initialize features immediately
    _features = _initializeFeatures();
    
    // Set initial appointments
    lastAppointment = widget.lastAppointment;
    nextAppointment = widget.nextAppointment;
    cachedName = widget.name;
    
    // Defer data loading to avoid blocking UI
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _loadCachedData();
      _maybeFetchFromBackend();
    });
  }

  List<FeatureIconData> _initializeFeatures() {
    return [
      FeatureIconData(
        icon: LucideIcons.stethoscope,
        label: 'Your Health',
        color: const Color(0xFFA8E6CF),
        onTap: (ctx) => _openFeature(ctx, '/your-health'),
      ),
      FeatureIconData(
        icon: LucideIcons.calendarCheck,
        label: 'Appointments',
        color: const Color(0xFFB3E5FC),
        onTap: (ctx) => _openFeature(ctx, '/appointments'),
      ),
      FeatureIconData(
        icon: LucideIcons.pill,
        label: 'Pharmacy',
        color: const Color(0xFFD1C4E9),
        onTap: (ctx) => _openFeature(ctx, '/pharmacy'),
      ),
      FeatureIconData(
        icon: LucideIcons.flaskConical,
        label: 'Investigations',
        color: const Color(0xFF80DEEA),
        onTap: (ctx) => _openFeature(ctx, '/investigations'),
      ),
      FeatureIconData(
        icon: LucideIcons.helpCircle,
        label: 'Ask a Doubt',
        color: const Color(0xFFFFE082),
        onTap: (ctx) => _openFeature(ctx, '/ask-a-doubt'),
      ),
      FeatureIconData(
        icon: LucideIcons.brainCircuit,
        label: 'Trivia',
        color: const Color(0xFF9FA8DA),
        onTap: (ctx) => _openFeature(ctx, '/trivia'),
      ),
      FeatureIconData(
        icon: LucideIcons.building2,
        label: 'Departments',
        color: const Color(0xFFC5E1A5),
        onTap: (ctx) => _openFeature(ctx, '/departments'),
      ),
      FeatureIconData(
        icon: LucideIcons.info,
        label: 'About Us',
        color: const Color(0xFFFFCCBC),
        onTap: (ctx) => _openFeature(ctx, '/about-us'),
      ),
    ];
  }

  Future<void> _loadCachedData() async {
    try {
      final results = await Future.wait([
        _secureStorage.read(key: 'lastAppointment'),
        _secureStorage.read(key: 'nextAppointment'),
        _secureStorage.read(key: 'userName'),
      ]);
      
      if (mounted) {
        setState(() {
          lastAppointment = results[0] ?? widget.lastAppointment;
          nextAppointment = results[1] ?? widget.nextAppointment;
          cachedName = results[2] ?? widget.name;
        });
      }
    } catch (_) {
      // Silent fail
    }
  }

  Future<void> _maybeFetchFromBackend() async {
    try {
      final fetched = await _secureStorage.read(key: 'fetched_dashboard');
      if (!mounted || fetched == 'true') return;
      
      // Delay network call to avoid blocking initial render
      await Future.delayed(const Duration(seconds: 1));
      if (mounted) {
        _fetchAndStoreDashboard();
      }
    } catch (_) {
      // Silent fail
    }
  }

  Future<void> _fetchAndStoreDashboard() async {
    try {
      final uri = Uri.parse('https://your-api.com/dashboard?phone=${widget.phone}');
      final res = await http.get(uri).timeout(const Duration(seconds: 10));
      if (!mounted) return;

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final name = data['name'] ?? widget.name;
        final last = data['lastAppointment'];
        final next = data['nextAppointment'];

        // Batch write operations
        await Future.wait([
          _secureStorage.write(key: 'userName', value: name),
          _secureStorage.write(key: 'lastAppointment', value: last),
          _secureStorage.write(key: 'nextAppointment', value: next),
          _secureStorage.write(key: 'fetched_dashboard', value: 'true'),
        ]);

        if (mounted) {
          setState(() {
            cachedName = name;
            lastAppointment = last;
            nextAppointment = next;
          });
        }
      }
    } catch (_) {
      // Silent fail
    }
  }

  void _openFeature(BuildContext context, String routeName) {
    final args = <String, dynamic>{
      'phone': widget.phone,
      'name': cachedName ?? widget.name,
      'color': _focusColor,
    };

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
      SnackBar(content: Text(l10n.authSosTriggered ?? 'SOS Triggered')),
    );
    await SOSService.triggerSOS();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final nameToShow = cachedName ?? widget.name;
    final screenHeight = MediaQuery.of(context).size.height;
    final isGuest = nameToShow == 'Guest';

    return Scaffold(
      appBar: AppBar(
        title: Text('Hello, ${nameToShow == 'Guest' ? nameToShow : '$nameToShow!'}'),
        actions: [
          IconButton(
            icon: const Icon(Icons.brightness_6), 
            onPressed: _toggleTheme,
          ),
          IconButton(
            icon: const Icon(Icons.accessibility), 
            onPressed: _toggleAccessibility,
          ),
          const _LanguageMenuButton(),
          const LogoutButton(style: LogoutButtonStyle.iconOnly),
        ],
      ),
      body: LogoBackground(
        child: SafeArea(
          child: Column(
            children: [
              // Upper section with dial (75% of available space)
              Expanded(
                flex: 3,
                child: Padding(
                  padding: const EdgeInsets.all(24), // Increased padding for safety
                  child: CircularFeatureDial(
                    features: _features,
                    size: MediaQuery.of(context).size.width * 0.75, // Conservative size
                    onFocusColorChanged: (color) {
                      setState(() => _focusColor = color);
                    },
                  ),
                ),
              ),
              
              // Lower section with appointment widget (25% of available space)
              if (!isGuest)
                Container(
                  constraints: BoxConstraints(
                    minHeight: 120,
                    maxHeight: screenHeight * 0.25,
                  ),
                  child: _AppointmentCard(
                    lastAppointment: lastAppointment,
                    nextAppointment: nextAppointment,
                    onViewHistory: () => _openFeature(context, '/appointments'),
                    onScheduleNew: () => _openFeature(context, '/appointments'),
                  ),
                ),
            ],
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        heroTag: 'sos',
        tooltip: l10n.authSosTooltip ?? 'Emergency SOS',
        backgroundColor: Colors.red,
        onPressed: _triggerSOS,
        child: const Icon(Icons.favorite),
      ),
    );
  }
}

// Language Menu Button Widget
class _LanguageMenuButton extends StatelessWidget {
  const _LanguageMenuButton();

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<int>(
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
    );
  }
}

// Enhanced Appointment Card Widget
class _AppointmentCard extends StatelessWidget {
  final String? lastAppointment;
  final String? nextAppointment;
  final VoidCallback? onViewHistory;
  final VoidCallback? onScheduleNew;

  const _AppointmentCard({
    this.lastAppointment,
    this.nextAppointment,
    this.onViewHistory,
    this.onScheduleNew,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return Container(
      margin: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: theme.colorScheme.primary.withValues(alpha: 0.1),
            blurRadius: 20,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Header
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: theme.colorScheme.primary.withValues(alpha: 0.1),
              borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Row(
              children: [
                Icon(
                  LucideIcons.calendar,
                  color: theme.colorScheme.primary,
                  size: 20,
                ),
                const SizedBox(width: 8),
                Text(
                  'Appointments',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: theme.colorScheme.primary,
                  ),
                ),
              ],
            ),
          ),
          
          // Appointments Content
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                // Last Appointment
                Expanded(
                  child: _buildAppointmentInfo(
                    context,
                    icon: LucideIcons.checkCircle,
                    iconColor: ThemeColors.getSuccessColor(context), // ✅ Fixed
                    label: 'Last Visit',
                    date: lastAppointment,
                    isPast: true,
                  ),
                ),
                
                // Divider
                Container(
                  height: 50,
                  width: 1,
                  color: theme.colorScheme.outline.withValues(alpha: 0.2),
                  margin: const EdgeInsets.symmetric(horizontal: 16),
                ),
                
                // Next Appointment
                Expanded(
                  child: _buildAppointmentInfo(
                    context,
                    icon: LucideIcons.clock,
                    iconColor: ThemeColors.getInfoColor(context), // ✅ Fixed
                    label: 'Next Visit',
                    date: nextAppointment,
                    isPast: false,
                  ),
                ),
              ],
            ),
          ),
          
          // Action buttons
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            decoration: BoxDecoration(
              border: Border(
                top: BorderSide(
                  color: theme.colorScheme.outline.withValues(alpha: 0.2),
                ),
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: TextButton.icon(
                    onPressed: onViewHistory,
                    icon: const Icon(LucideIcons.history, size: 16),
                    label: const Text('History'),
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: onScheduleNew,
                    icon: const Icon(LucideIcons.plus, size: 16),
                    label: const Text('Schedule'),
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAppointmentInfo(
    BuildContext context, {
    required IconData icon,
    required Color iconColor,
    required String label,
    required String? date,
    required bool isPast,
  }) {
    final theme = Theme.of(context);
    final hasDate = date != null && date.isNotEmpty && date != 'Not Available';
    
    return Column(
      children: [
        Icon(
          icon,
          color: iconColor,
          size: 28,
        ),
        const SizedBox(height: 8),
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          hasDate ? _formatDate(date) : 'Not Scheduled',
          style: theme.textTheme.bodyMedium?.copyWith(
            fontWeight: FontWeight.bold,
            color: hasDate 
              ? theme.colorScheme.onSurface 
              : theme.colorScheme.onSurface.withValues(alpha: 0.5),
          ),
          textAlign: TextAlign.center,
        ),
        if (hasDate && !isPast) ...[
          const SizedBox(height: 2),
          Text(
            _getDaysUntil(date),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.primary,
              fontSize: 11,
            ),
          ),
        ],
      ],
    );
  }

  String _formatDate(String date) {
    try {
      // Try parsing different date formats
      DateTime? parsedDate;
      
      // Try dd/MM/yyyy format first
      try {
        parsedDate = DateFormat('dd/MM/yyyy').parse(date);
      } catch (_) {
        // Try yyyy-MM-dd format
        try {
          parsedDate = DateFormat('yyyy-MM-dd').parse(date);
        } catch (_) {
          // Try other formats
          parsedDate = DateTime.tryParse(date);
        }
      }
      
      if (parsedDate != null) {
        return DateFormat('dd/MM/yyyy').format(parsedDate);
      }
    } catch (_) {
      // Return original if parsing fails
    }
    return date;
  }

  String _getDaysUntil(String date) {
    try {
      DateTime? parsedDate;
      
      try {
        parsedDate = DateFormat('dd/MM/yyyy').parse(date);
      } catch (_) {
        try {
          parsedDate = DateFormat('yyyy-MM-dd').parse(date);
        } catch (_) {
          parsedDate = DateTime.tryParse(date);
        }
      }
      
      if (parsedDate != null) {
        final now = DateTime.now();
        final today = DateTime(now.year, now.month, now.day);
        final appointmentDate = DateTime(parsedDate.year, parsedDate.month, parsedDate.day);
        final difference = appointmentDate.difference(today).inDays;
        
        if (difference == 0) return 'Today';
        if (difference == 1) return 'Tomorrow';
        if (difference > 0) return 'In $difference days';
        return '';
      }
    } catch (_) {
      // Silent fail
    }
    return '';
  }
}