// Investigations screen — a thin three-tab coordinator. "My Bookings",
// "Upload" and "Results" each live as their own widget under
// features/investigations/widgets/; the screen owns the TabController and
// bridges Upload → Results (refresh the results list after an upload).
import 'package:flutter/material.dart';

import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/contact_banner.dart';
import 'package:vhhealth/features/investigations/widgets/investigation_bookings_tab.dart';
import 'package:vhhealth/features/investigations/widgets/investigation_upload_tab.dart';
import 'package:vhhealth/features/investigations/widgets/investigation_results_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class InvestigationsScreen extends StatefulWidget {
  const InvestigationsScreen({super.key});

  @override
  State<InvestigationsScreen> createState() => _InvestigationsScreenState();
}

class _InvestigationsScreenState extends State<InvestigationsScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  final _resultsKey = GlobalKey<InvestigationResultsTabState>();

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final cs = Theme.of(context).colorScheme;
    final color = FeatureScreenScaffold.featureColors['investigations']!;

    return FeatureScreenScaffold(
      title: l10n.investigationsTitle,
      icon: Icons.science_outlined,
      color: color,
      heroTag: 'investigations',
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            labelColor: cs.primary,
            unselectedLabelColor: cs.onSurfaceVariant,
            indicatorColor: cs.primary,
            tabs: [
              const Tab(
                icon: Icon(Icons.science_outlined, size: 18),
                text: 'My Bookings',
              ),
              Tab(
                icon: const Icon(Icons.upload_file_outlined, size: 18),
                text: l10n.investigationsTabUpload,
              ),
              Tab(
                icon: const Icon(Icons.list_alt_outlined, size: 18),
                text: l10n.investigationsTabResults,
              ),
            ],
          ),
          ContactBanner.homeSampleCollection(l10n),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                const InvestigationBookingsTab(),
                InvestigationUploadTab(
                  onUploaded: () {
                    _tabController.animateTo(2);
                    _resultsKey.currentState?.refresh();
                  },
                ),
                InvestigationResultsTab(key: _resultsKey),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
