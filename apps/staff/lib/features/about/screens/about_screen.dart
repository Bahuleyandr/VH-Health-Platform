import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';

class AboutScreen extends StatelessWidget {
  const AboutScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('About')),
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
                const Text(
                  'VHHealth Staff',
                  style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 4),
                const Text(
                  'Version 1.0.0',
                  style: TextStyle(fontSize: 14, color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // Description
          const Card(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'About',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                  ),
                  SizedBox(height: 8),
                  Text(
                    'A hospital staff management app by VH Health. '
                    'Manage attendance, leave, appointments, and more — '
                    'all from your mobile device.',
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
          const Card(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Features',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                  ),
                  SizedBox(height: 12),
                  _FeatureItem(
                    icon: Icons.fingerprint,
                    title: 'Attendance',
                    description: 'Clock in/out with location tracking',
                  ),
                  _FeatureItem(
                    icon: Icons.event_available,
                    title: 'Leave Management',
                    description: 'Apply for leave and track balances',
                  ),
                  _FeatureItem(
                    icon: Icons.calendar_today,
                    title: 'Appointments',
                    description: 'View and manage patient appointments',
                  ),
                  _FeatureItem(
                    icon: Icons.science_outlined,
                    title: 'Investigations',
                    description: 'Lab tests and diagnostic reports',
                  ),
                  _FeatureItem(
                    icon: Icons.medication_outlined,
                    title: 'Pharmacy',
                    description: 'Prescription and dispensing workflow',
                  ),
                  _FeatureItem(
                    icon: Icons.people_outlined,
                    title: 'Staff Directory',
                    description: 'Find and contact colleagues',
                  ),
                  _FeatureItem(
                    icon: Icons.medical_services_outlined,
                    title: 'Clinical Modules',
                    description: 'Vitals, nursing notes, prescriptions',
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),

          // Contact
          const Card(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Support',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                  ),
                  SizedBox(height: 8),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      Icons.email_outlined,
                      color: AppTheme.primaryBlue,
                    ),
                    title: Text('Email'),
                    subtitle: Text('support@vhhealth.in'),
                  ),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(Icons.language, color: AppTheme.primaryBlue),
                    title: Text('Website'),
                    subtitle: Text('www.vhhealth.in'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 24),

          const Center(
            child: Text(
              '© 2026 VH Health. All rights reserved.',
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
                  style: const TextStyle(
                    color: AppTheme.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
