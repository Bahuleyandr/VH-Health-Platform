import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../config/api_config.dart';
import '../config/role_config.dart';

/// Shell scaffold that provides persistent bottom navigation.
/// Used as the ShellRoute builder in app_router.dart.
class MainScaffold extends StatefulWidget {
  final Widget child;
  const MainScaffold({super.key, required this.child});

  @override
  State<MainScaffold> createState() => _MainScaffoldState();
}

class _MainScaffoldState extends State<MainScaffold> {
  StaffRole _role = StaffRole.general;

  @override
  void initState() {
    super.initState();
    _loadRole();
  }

  Future<void> _loadRole() async {
    final roleStr = await ApiConfig.getRole();
    if (!mounted) return;
    setState(() => _role = StaffRole.fromString(roleStr));
  }

  int _currentIndex(List<BottomNavItem> navItems) {
    final location = GoRouterState.of(context).matchedLocation;
    for (int i = 0; i < navItems.length; i++) {
      if (navItems[i].route == location) return i;
    }
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final navItems = RoleFeatures.getBottomNavForRole(_role);

    return Scaffold(
      body: widget.child,
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _currentIndex(navItems),
        type: BottomNavigationBarType.fixed,
        onTap: (i) {
          if (i < navItems.length) context.go(navItems[i].route);
        },
        items: navItems.map((n) => n.item).toList(),
      ),
    );
  }
}
