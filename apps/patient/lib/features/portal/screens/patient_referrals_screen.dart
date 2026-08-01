import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/features/portal/models/patient_referral.dart';
import 'package:vhhealth/features/portal/services/patient_referrals_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class PatientReferralsScreen extends StatefulWidget {
  const PatientReferralsScreen({
    super.key,
    this.repository = const ApiPatientReferralsRepository(),
  });

  final PatientReferralsRepository repository;

  @override
  State<PatientReferralsScreen> createState() => _PatientReferralsScreenState();
}

class _PatientReferralsScreenState extends State<PatientReferralsScreen> {
  bool _loading = true;
  String? _error;
  String? _staleLabel;
  DateTime? _cachedAt;
  List<PatientReferral> _referrals = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _fetch();
    });
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.repository.listReferrals();
      if (!mounted) return;
      setState(() {
        _referrals = page.referrals;
        _staleLabel = page.staleLabel;
        _cachedAt = page.cachedAt;
        _loading = false;
      });
      page.onFresh
          ?.then((fresh) async {
            final cached = await ApiCacheManager.load('/portal/referrals');
            if (!mounted) return;
            setState(() {
              _referrals = fresh;
              _staleLabel = null;
              _cachedAt = cached?.cachedAt;
            });
          })
          .catchError((Object _) {});
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = AppLocalizations.of(context)!.referralsLoadFailed;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l10n.referralsTitle,
      icon: Icons.medical_information_outlined,
      color: colors.primary,
      child: Column(
        children: [
          OfflineBanner(staleLabel: _staleLabel, cachedAt: _cachedAt),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _fetch,
              child: DataStateBuilder<PatientReferral>(
                isLoading: _loading,
                error: _error,
                data: _referrals,
                onRetry: _fetch,
                emptyIcon: Icons.medical_information_outlined,
                emptyTitle: l10n.referralsEmptyTitle,
                emptySubtitle: l10n.referralsEmptySubtitle,
                builder: (context, referrals) => ListView.separated(
                  padding: const EdgeInsets.all(16),
                  physics: const AlwaysScrollableScrollPhysics(),
                  itemCount: referrals.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (_, index) => _ReferralCard(
                    referral: referrals[index],
                    onTap: () => _showDetails(context, referrals[index]),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ReferralCard extends StatelessWidget {
  const _ReferralCard({required this.referral, required this.onTap});

  final PatientReferral referral;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return Card(
      child: ListTile(
        leading: Icon(
          Icons.medical_services_outlined,
          color: theme.colorScheme.primary,
        ),
        title: Text(
          referral.department.isEmpty
              ? l10n.referralsSpecialist
              : referral.department,
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            referral.summary,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}

void _showDetails(BuildContext context, PatientReferral referral) {
  final l10n = AppLocalizations.of(context)!;
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              referral.department.isEmpty
                  ? l10n.referralsSpecialist
                  : referral.department,
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            if (referral.signedAt != null) ...[
              const SizedBox(height: 4),
              Text(
                DateFormat.yMMMd().add_jm().format(
                  referral.signedAt!.toLocal(),
                ),
              ),
            ],
            const SizedBox(height: 20),
            _Section(title: l10n.referralsSummary, body: referral.summary),
            _Section(
              title: l10n.referralsNextSteps,
              body: referral.instructions,
            ),
            if (referral.followUpPlan != null)
              _Section(
                title: l10n.referralsFollowUp,
                body: referral.followUpPlan!,
              ),
            if (referral.appointmentId != null)
              _Section(
                title: l10n.referralsAppointment,
                body: l10n.referralsAppointmentLinked,
              ),
          ],
        ),
      ),
    ),
  );
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.body});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 6),
          Text(body, style: Theme.of(context).textTheme.bodyLarge),
        ],
      ),
    );
  }
}
