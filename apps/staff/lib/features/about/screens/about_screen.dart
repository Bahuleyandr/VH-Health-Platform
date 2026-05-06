import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class AboutScreen extends StatelessWidget {
  const AboutScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.aboutTitle),
        actions: const [LogoutAction()],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const SizedBox(height: 16),
          // App icon & name
          Center(
            child: Column(
              children: [
                Container(
                  width: 80,
                  height: 80,
                  decoration: BoxDecoration(
                    color: AppTheme.primaryBlue,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Icon(
                    Icons.local_hospital,
                    size: 48,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  s.aboutAppName,
                  style: const TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  s.aboutVersion,
                  style: TextStyle(fontSize: 14, color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // Description
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.aboutHeader,
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    s.aboutDescription,
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      height: 1.5,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),

          // Features
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.aboutFeaturesHeader,
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 12),
                  _FeatureItem(
                    icon: Icons.fingerprint,
                    title: s.aboutFeatureAttendanceTitle,
                    description: s.aboutFeatureAttendanceDescription,
                  ),
                  _FeatureItem(
                    icon: Icons.event_available,
                    title: s.aboutFeatureLeaveTitle,
                    description: s.aboutFeatureLeaveDescription,
                  ),
                  _FeatureItem(
                    icon: Icons.calendar_today,
                    title: s.aboutFeatureAppointmentsTitle,
                    description: s.aboutFeatureAppointmentsDescription,
                  ),
                  _FeatureItem(
                    icon: Icons.science_outlined,
                    title: s.aboutFeatureInvestigationsTitle,
                    description: s.aboutFeatureInvestigationsDescription,
                  ),
                  _FeatureItem(
                    icon: Icons.medication_outlined,
                    title: s.aboutFeaturePharmacyTitle,
                    description: s.aboutFeaturePharmacyDescription,
                  ),
                  _FeatureItem(
                    icon: Icons.people_outlined,
                    title: s.aboutFeatureStaffDirectoryTitle,
                    description: s.aboutFeatureStaffDirectoryDescription,
                  ),
                  _FeatureItem(
                    icon: Icons.medical_services_outlined,
                    title: s.aboutFeatureClinicalModulesTitle,
                    description: s.aboutFeatureClinicalModulesDescription,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),

          // Contact
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.aboutSupportHeader,
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 8),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(
                      Icons.email_outlined,
                      color: AppTheme.primaryBlue,
                    ),
                    title: Text(s.aboutSupportEmailLabel),
                    subtitle: const Text('support@vhhealth.in'),
                  ),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(
                      Icons.language,
                      color: AppTheme.primaryBlue,
                    ),
                    title: Text(s.aboutWebsiteLabel),
                    subtitle: const Text('www.vhhealth.in'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 24),

          Center(
            child: Text(
              s.aboutCopyright,
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
            ),
          ),
          const SizedBox(height: 16),
        ],
      ),
    );
  }
}

class _FeatureItem extends StatelessWidget {
  final IconData icon;
  final String title;
  final String description;

  const _FeatureItem({
    required this.icon,
    required this.title,
    required this.description,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        children: [
          Icon(icon, color: AppTheme.primaryBlue, size: 22),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontWeight: FontWeight.w500,
                    fontSize: 14,
                  ),
                ),
                Text(
                  description,
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
