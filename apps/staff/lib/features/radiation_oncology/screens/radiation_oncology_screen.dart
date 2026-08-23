import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../services/radiation_oncology_api_service.dart';

typedef RadiationReferralLoader =
    Future<List<RadiationReferralSummary>> Function();

/// NL-13 P4 — nuclear-medicine & radiotherapy coordination surface.
/// Read-only referral board: statuses, modality/intent, and counts of external
/// plan references and nuclear-medicine orders. The product coordinates external
/// planning/delivery systems; it never computes plans or drives delivery.
class RadiationOncologyScreen extends StatefulWidget {
  const RadiationOncologyScreen({super.key, this.loadReferrals});

  final RadiationReferralLoader? loadReferrals;

  @override
  State<RadiationOncologyScreen> createState() =>
      _RadiationOncologyScreenState();
}

class _RadiationOncologyScreenState extends State<RadiationOncologyScreen> {
  bool _loading = true;
  String? _error;
  List<RadiationReferralSummary> _referrals = const [];

  @override
  void initState() {
    super.initState();
    _loadReferrals();
  }

  Future<void> _loadReferrals({bool showLoading = true}) async {
    if (mounted && showLoading) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final loader =
          widget.loadReferrals ?? RadiationOncologyApiService.fetchReferrals;
      final referrals = await loader();
      if (!mounted) return;
      setState(() {
        _referrals = referrals;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _refresh() => _loadReferrals(showLoading: false);

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('s4.lib.radiation_oncology.title')),
        actions: [
          IconButton(
            tooltip: s.actionRefresh,
            icon: const Icon(Icons.refresh),
            onPressed: _refresh,
          ),
          const LogoutAction(),
        ],
      ),
      body: ConstrainedContent(child: _buildBody(s)),
    );
  }

  Widget _buildBody(AppStrings s) {
    if (_error != null) {
      return ErrorState(message: _error!, onRetry: () => _loadReferrals());
    }
    if (_loading) return const SkeletonList();
    if (_referrals.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(
            height: MediaQuery.sizeOf(context).height * 0.6,
            child: EmptyState(
              icon: Icons.radar_outlined,
              title: s.lookup('s4.lib.radiation_oncology.no_referrals'),
              body: s.lookup('s4.lib.radiation_oncology.subtitle'),
            ),
          ),
        ],
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _referrals.length,
        itemBuilder: (context, index) =>
            _ReferralCard(referral: _referrals[index]),
      ),
    );
  }
}

class _ReferralCard extends StatelessWidget {
  const _ReferralCard({required this.referral});

  final RadiationReferralSummary referral;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final created = referral.createdAt == null
        ? '-'
        : DateFormat('dd MMM yyyy').format(referral.createdAt!);
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    _patientLabel(s, referral),
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                _Chip(
                  label: _titleize(referral.status),
                  color: _statusColor(referral.status),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                _InfoPill(
                  icon: Icons.medical_services_outlined,
                  label: _titleize(referral.modality),
                ),
                _InfoPill(
                  icon: Icons.flag_outlined,
                  label: _titleize(referral.intent),
                ),
                _InfoPill(icon: Icons.event_outlined, label: created),
              ],
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                _Chip(
                  label: s.format('s4.lib.radiation_oncology.plan_refs_count', {
                    'count': referral.planRefCount,
                  }),
                  color: AppTheme.primaryBlue,
                ),
                _Chip(
                  label: s.format(
                    's4.lib.radiation_oncology.nuclear_orders_count',
                    {'count': referral.nuclearOrderCount},
                  ),
                  color: AppTheme.primaryBlue,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _InfoPill extends StatelessWidget {
  const _InfoPill({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: AppTheme.textSecondary),
        const SizedBox(width: 5),
        Text(label, style: TextStyle(color: AppTheme.textSecondary)),
      ],
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

Color _statusColor(String status) {
  return switch (status.toLowerCase()) {
    'completed' => AppTheme.successGreen,
    'in_treatment' || 'planned' || 'accepted' => AppTheme.primaryBlue,
    'submitted' || 'draft' => AppTheme.warningAmber,
    'cancelled' || 'declined' => AppTheme.errorRed,
    _ => Colors.grey,
  };
}

String _patientLabel(AppStrings s, RadiationReferralSummary referral) {
  if (referral.patientName.isNotEmpty) return referral.patientName;
  if (referral.patientUid.isEmpty) {
    return s.lookup('s4.lib.radiation_oncology.unknown_patient');
  }
  final uid = referral.patientUid;
  return uid.length > 8 ? '${uid.substring(0, 8)}...' : uid;
}

String _titleize(String value) {
  final text = value.replaceAll('_', ' ').trim();
  if (text.isEmpty) return '-';
  return text
      .split(' ')
      .map((part) {
        if (part.isEmpty) return part;
        return '${part[0].toUpperCase()}${part.substring(1)}';
      })
      .join(' ');
}
