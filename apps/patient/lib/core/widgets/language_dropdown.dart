import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class LanguageDropdown extends StatelessWidget {
  final Color? iconColor;
  final EdgeInsetsGeometry? padding;

  const LanguageDropdown({
    super.key,
    this.iconColor,
    this.padding,
  });

  @override
  Widget build(BuildContext context) {
    final langProvider = context.watch<LanguageProvider>();
    final loc = AppLocalizations.of(context)!;
    final theme = Theme.of(context);

    return Padding(
      padding: padding ?? const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: langProvider.locale.languageCode,
          isExpanded: true,
          icon: Icon(Icons.language_outlined, color: iconColor ?? theme.colorScheme.primary),
          items: langProvider.languageNames.entries
              .map((e) => DropdownMenuItem<String>(
                    value: e.key,
                    child: Text(e.value),
                  ))
              .toList(),
          onChanged: (String? newCode) {
            if (newCode != null) {
              langProvider.setLocale(newCode);
            }
          },
          style: theme.textTheme.titleMedium,
          dropdownColor: theme.cardColor,
          hint: Text(loc.settingsLanguage),
        ),
      ),
    );
  }
}
