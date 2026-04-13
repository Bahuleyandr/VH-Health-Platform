import 'package:flutter/material.dart';
import 'package:vhhealth/core/widgets/language_dropdown.dart';

class LanguageMenuButton extends StatelessWidget {
  const LanguageMenuButton({super.key});

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<int>(
      tooltip: 'Change Language',
      offset: const Offset(0, 40),
      icon: const Icon(Icons.language),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      itemBuilder: (_) => [
        const PopupMenuItem<int>(
          value: 0,
          enabled: false,
          padding: EdgeInsets.zero,
          child: SizedBox(width: 150, child: LanguageDropdown()),
        ),
      ],
    );
  }
}
