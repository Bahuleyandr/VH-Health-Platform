// Appointments screen — a thin two-tab coordinator. "Book" and
// "My Appointments" each live as their own StatefulWidget under
// features/appointments/widgets/; the screen just owns the TabController
// and bridges the two tabs (book → switch to + refresh the list).
import 'package:flutter/material.dart';

import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/contact_banner.dart';
import 'package:vhhealth/features/appointments/widgets/appointment_book_tab.dart';
import 'package:vhhealth/features/appointments/widgets/appointments_list_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AppointmentsScreen extends StatefulWidget {
  const AppointmentsScreen({super.key});

  @override
  State<AppointmentsScreen> createState() => _AppointmentsScreenState();
}

class _AppointmentsScreenState extends State<AppointmentsScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  final _listKey = GlobalKey<AppointmentsListTabState>();

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

  Future<void> _triggerSOS() async {
    await SOSService.triggerWithFeedback(context);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return FeatureScreenScaffold(
      title: l10n.requestAppointment,
      icon: Icons.calendar_month_outlined,
      color: FeatureScreenScaffold.featureColors['appointments']!,
      heroTag: 'appointments',
      floatingActionButton: FloatingActionButton(
        onPressed: _triggerSOS,
        tooltip: l10n.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.favorite),
      ),
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            tabs: [
              Tab(
                text: l10n.appointmentsBookTab,
                icon: const Icon(Icons.add_circle_outline),
              ),
              Tab(
                text: l10n.appointmentsMyAppointmentsTab,
                icon: const Icon(Icons.list_alt),
              ),
            ],
          ),
          ContactBanner.appointments(),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                AppointmentBookTab(
                  onBooked: () {
                    _tabController.animateTo(1);
                    _listKey.currentState?.refresh();
                  },
                ),
                AppointmentsListTab(
                  key: _listKey,
                  onBookOne: () => _tabController.animateTo(0),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
