import 'package:flutter/material.dart';

import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/pharmacy/widgets/order_form_tab.dart';
import 'package:vhhealth/features/pharmacy/widgets/order_list_tab.dart';

class PharmacyScreen extends StatefulWidget {
  final String phone;
  const PharmacyScreen({super.key, required this.phone});

  @override
  State<PharmacyScreen> createState() => _PharmacyScreenState();
}

class _PharmacyScreenState extends State<PharmacyScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  final _orderListKey = GlobalKey<OrderListTabState>();

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

  void _onOrderPlaced() {
    _tabController.animateTo(1);
    _orderListKey.currentState?.refresh();
  }

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: 'Pharmacy',
      icon: Icons.local_pharmacy,
      color: const Color(0xFFD1C4E9),
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            labelColor: const Color(0xFF7E57C2),
            unselectedLabelColor: Colors.grey,
            indicatorColor: const Color(0xFF7E57C2),
            tabs: const [
              Tab(icon: Icon(Icons.add_shopping_cart), text: 'Order'),
              Tab(icon: Icon(Icons.receipt_long), text: 'My Orders'),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                OrderFormTab(
                  phone: widget.phone,
                  onOrderPlaced: _onOrderPlaced,
                ),
                OrderListTab(key: _orderListKey),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
