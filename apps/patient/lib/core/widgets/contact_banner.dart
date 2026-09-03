import 'package:flutter/material.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/generated/app_localizations.dart';

/// Reusable contact banner with phone numbers and tap-to-call
class ContactBanner extends StatelessWidget {
  final String title;
  final IconData icon;
  final Color color;
  final List<ContactNumber> numbers;

  const ContactBanner({
    super.key,
    required this.title,
    required this.icon,
    required this.color,
    required this.numbers,
  });

  /// Appointment booking banner
  factory ContactBanner.appointments(AppLocalizations l10n) => ContactBanner(
    title: l10n.contactBookByPhone,
    icon: Icons.calendar_month,
    color: const Color(0xFF007A64),
    numbers: const [
      ContactNumber(label: '044-4511 4511', phone: '+914445114511'),
      ContactNumber(label: '4511 1111', phone: '+914445111111'),
    ],
  );

  /// Home sample collection banner
  factory ContactBanner.homeSampleCollection(AppLocalizations l10n) =>
      ContactBanner(
        title: l10n.aboutFreeHomeSampleCollectionTitle,
        icon: Icons.home_outlined,
        color: Colors.blue,
        numbers: const [
          ContactNumber(label: '93845 43289', phone: '+919384543289'),
          ContactNumber(label: '95002 10210', phone: '+919500210210'),
        ],
      );

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.2)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: color,
                  ),
                ),
                const SizedBox(height: 4),
                Wrap(
                  spacing: 12,
                  children: numbers
                      .map(
                        (n) => GestureDetector(
                          onTap: () => SafeUrlLauncher.launchPhone(n.phone),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.phone, size: 13, color: color),
                              const SizedBox(width: 3),
                              Text(
                                n.label,
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: color,
                                  decoration: TextDecoration.underline,
                                  decorationColor: color.withValues(alpha: 0.4),
                                ),
                              ),
                            ],
                          ),
                        ),
                      )
                      .toList(),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class ContactNumber {
  final String label;
  final String phone;
  const ContactNumber({required this.label, required this.phone});
}
