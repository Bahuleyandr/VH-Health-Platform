// Vitals screen — thin tab coordinator. The two tabs (log form + history)
// live as their own widgets under features/vitals/widgets/.
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/vitals/widgets/vitals_form_tab.dart';
import 'package:vhhealth/features/vitals/widgets/vitals_history_tab.dart';

class VitalsScreen extends StatefulWidget {
  const VitalsScreen({super.key});

  @override
  State<VitalsScreen> createState() => _VitalsScreenState();
}

class _VitalsScreenState extends State<VitalsScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  late final String _phone;

  @override
  void initState() {
    super.initState();
    _phone = context.read<UserProvider>().phone;
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l.vitalsTitle,
      icon: Icons.monitor_heart,
      color: colors.error,
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            labelColor: colors.error,
            unselectedLabelColor: colors.onSurfaceVariant,
            indicatorColor: colors.error,
            tabs: [
              Tab(icon: const Icon(Icons.edit_note), text: l.vitalsLogTab),
              Tab(icon: const Icon(Icons.history), text: l.vitalsHistoryTab),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                VitalsFormTab(onSubmitted: () => _tabController.animateTo(1)),
                VitalsHistoryTab(phone: _phone),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
