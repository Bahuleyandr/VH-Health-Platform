import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/language_provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';

class LanguageMenuButton extends StatelessWidget {
  const LanguageMenuButton({super.key});

  @override
  Widget build(BuildContext context) {
    final languageProvider = context.watch<LanguageProvider>();
    final colors = Theme.of(context).colorScheme;
    final iconScale = context.watch<ThemeProvider>().iconScale;
    final buttonSize = 40.0 * iconScale;
    final iconSize = 20.0 * iconScale;
    final currentLanguage = languageProvider.locale.languageCode;

    return Tooltip(
      message: 'Change Language',
      child: SizedBox.square(
        dimension: buttonSize,
        child: PopupMenuButton<String>(
          tooltip: 'Change Language',
          padding: EdgeInsets.zero,
          offset: Offset(0, buttonSize),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          onSelected: (languageCode) {
            context.read<LanguageProvider>().setLocale(languageCode);
          },
          child: Container(
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: colors.surfaceContainerHighest.withValues(alpha: 0.55),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(Icons.language, size: iconSize, color: colors.primary),
          ),
          itemBuilder: (_) => languageProvider.languageNames.entries
              .map(
                (entry) => PopupMenuItem<String>(
                  value: entry.key,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SizedBox(
                        width: 18,
                        child: entry.key == currentLanguage
                            ? Icon(Icons.check, size: 16, color: colors.primary)
                            : null,
                      ),
                      const SizedBox(width: 8),
                      Text(entry.value),
                    ],
                  ),
                ),
              )
              .toList(),
        ),
      ),
    );
  }
}
