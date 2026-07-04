import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/pharmacy/widgets/order_form_tab.dart';
import 'package:vhhealth/features/pharmacy/widgets/order_list_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class PharmacyScreen extends StatefulWidget {
  const PharmacyScreen({super.key});

  @override
  State<PharmacyScreen> createState() => _PharmacyScreenState();
}

class _PharmacyScreenState extends State<PharmacyScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  late final String _phone;
  final _orderListKey = GlobalKey<OrderListTabState>();

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

  void _onOrderPlaced() {
    _tabController.animateTo(1);
    _orderListKey.currentState?.refresh();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l.pharmacy,
      icon: Icons.local_pharmacy,
      color: colors.secondary,
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            labelColor: colors.secondary,
            unselectedLabelColor: colors.onSurfaceVariant,
            indicatorColor: colors.secondary,
            tabs: [
              Tab(
                icon: const Icon(Icons.add_shopping_cart),
                text: l.pharmacyOrderTab,
              ),
              Tab(
                icon: const Icon(Icons.receipt_long),
                text: l.pharmacyMyOrdersTab,
              ),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                OrderFormTab(phone: _phone, onOrderPlaced: _onOrderPlaced),
                OrderListTab(key: _orderListKey),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
