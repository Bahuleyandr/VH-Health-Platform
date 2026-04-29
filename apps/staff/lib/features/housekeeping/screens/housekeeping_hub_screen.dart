import 'package:flutter/material.dart';
import 'log_cleaning_screen.dart';
import 'raise_request_screen.dart';
import 'my_housekeeping_screen.dart';

class HousekeepingHubScreen extends StatelessWidget {
  const HousekeepingHubScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFE0F5F6),
      appBar: AppBar(
        title: const Text('Housekeeping'),
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
        elevation: 0,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            _HubCard(
              icon: Icons.cleaning_services_outlined,
              color: const Color(0xFF007A64),
              title: 'Log Cleaning',
              subtitle: 'Record completed cleaning with photo evidence',
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const LogCleaningScreen()),
              ),
            ),
            const SizedBox(height: 12),
            _HubCard(
              icon: Icons.report_problem_outlined,
              color: Colors.orange,
              title: 'Raise Request',
              subtitle: 'Report a dirty area or request cleaning',
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const RaiseRequestScreen()),
              ),
            ),
            const SizedBox(height: 12),
            _HubCard(
              icon: Icons.history_outlined,
              color: Colors.blue,
              title: 'My Activity',
              subtitle: 'View your logs, assigned tasks, and requests',
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const MyHousekeepingScreen()),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _HubCard extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  const _HubCard({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 1,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Container(
                width: 50,
                height: 50,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(icon, color: color, size: 26),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.grey.shade600,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right, color: Colors.grey.shade400),
            ],
          ),
        ),
      ),
    );
  }
}
