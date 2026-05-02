import 'package:flutter/material.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';
import 'incident_report_screen.dart';
import 'grievance_screen.dart';
import 'my_reports_screen.dart';

class ReportsHubScreen extends StatelessWidget {
  const ReportsHubScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: const Color(0xFFE0F5F6),
      appBar: AppBar(
        title: Text(s.reportsHubTitle),
        actions: const [LogoutAction()],
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
        elevation: 0,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.amber.shade50,
                border: Border.all(color: Colors.amber.shade300),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.shield_outlined,
                    color: Colors.amber.shade700,
                    size: 20,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      s.reportsHubConfidentialityNote,
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            Text(
              s.reportsHubPrompt,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),

            _HubCard(
              icon: Icons.warning_amber_rounded,
              color: Colors.orange,
              title: s.reportsHubIncidentTitle,
              subtitle: s.reportsHubIncidentSubtitle,
              urgencyNote: s.reportsHubIncidentNote,
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const IncidentReportScreen()),
              ),
            ),
            const SizedBox(height: 12),

            _HubCard(
              icon: Icons.support_agent_outlined,
              color: Colors.purple,
              title: s.reportsHubGrievanceTitle,
              subtitle: s.reportsHubGrievanceSubtitle,
              urgencyNote: s.reportsHubGrievanceNote,
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const GrievanceScreen()),
              ),
            ),
            const SizedBox(height: 20),

            OutlinedButton.icon(
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const MyReportsScreen()),
              ),
              icon: const Icon(Icons.history),
              label: Text(s.reportsHubMyReports),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(double.infinity, 48),
                foregroundColor: const Color(0xFF007A64),
                side: const BorderSide(color: Color(0xFF007A64)),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
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
  final String urgencyNote;
  final VoidCallback onTap;

  const _HubCard({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.urgencyNote,
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
                width: 48,
                height: 48,
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
                    const SizedBox(height: 4),
                    Text(
                      urgencyNote,
                      style: TextStyle(
                        fontSize: 11,
                        color: color,
                        fontWeight: FontWeight.w500,
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
