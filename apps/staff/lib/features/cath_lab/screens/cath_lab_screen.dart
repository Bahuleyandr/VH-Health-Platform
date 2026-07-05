import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class CathLabScreen extends StatefulWidget {
  const CathLabScreen({super.key});

  @override
  State<CathLabScreen> createState() => _CathLabScreenState();
}

class _CathLabScreenState extends State<CathLabScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  DateTime _selectedDate = DateTime.now();

  String get _dateLabel => DateFormat('dd MMM yyyy').format(_selectedDate);

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _selectedDate,
      firstDate: DateTime.now().subtract(const Duration(days: 90)),
      lastDate: DateTime.now().add(const Duration(days: 180)),
    );
    if (picked != null && picked != _selectedDate) {
      setState(() => _selectedDate = picked);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: const AppText('s4.lib.cath_lab.cath_lab'),
        actions: [
          IconButton(
            tooltip: AppStrings.of(context).lookup('theatre.pick_date'),
            icon: const Icon(Icons.calendar_today),
            onPressed: _pickDate,
          ),
          const LogoutAction(),
        ],
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          tabs: [
            Tab(text: AppStrings.of(context).lookup('theatre.tab.schedule')),
            Tab(
              text: AppStrings.of(context).lookup('s4.lib.cath_lab.readiness'),
            ),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _CathLabEmptyState(
            icon: Icons.event_busy,
            title: 'No Cath Lab cases',
            detail: _dateLabel,
          ),
          _CathLabReadiness(dateLabel: _dateLabel),
        ],
      ),
    );
  }
}

class _CathLabReadiness extends StatelessWidget {
  const _CathLabReadiness({required this.dateLabel});

  final String dateLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          dateLabel,
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 12),
        const _ReadinessRow(
          icon: Icons.meeting_room_outlined,
          label: 'Cath Lab room',
          value: 'Not configured',
          color: AppTheme.primaryBlue,
        ),
        const _ReadinessRow(
          icon: Icons.medical_services_outlined,
          label: 'Cath team',
          value: 'Not assigned',
          color: AppTheme.warningAmber,
        ),
        const _ReadinessRow(
          icon: Icons.monitor_heart_outlined,
          label: 'Equipment',
          value: 'Pending checklist',
          color: AppTheme.warningAmber,
        ),
      ],
    );
  }
}

class _ReadinessRow extends StatelessWidget {
  const _ReadinessRow({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: color.withValues(alpha: 0.15),
          foregroundColor: color,
          child: Icon(icon),
        ),
        title: Text(label, style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(value),
        trailing: Icon(
          Icons.chevron_right,
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _CathLabEmptyState extends StatelessWidget {
  const _CathLabEmptyState({
    required this.icon,
    required this.title,
    required this.detail,
  });

  final IconData icon;
  final String title;
  final String detail;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      children: [
        const SizedBox(height: 120),
        Center(
          child: Column(
            children: [
              Icon(icon, size: 64, color: theme.colorScheme.outline),
              const SizedBox(height: 12),
              Text(
                title,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              Text(detail, style: theme.textTheme.bodyMedium),
            ],
          ),
        ),
      ],
    );
  }
}
