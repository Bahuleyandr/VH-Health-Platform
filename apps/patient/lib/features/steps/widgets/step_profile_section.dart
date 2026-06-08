// Step Challenge profile section — shows the saved profile card, or the
// display-name + colour setup form for new users. Presentational; the
// screen owns the profile state and handles edit/colour/save callbacks.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:vhhealth/features/steps/models/step_models.dart';
import 'package:vhhealth/features/steps/step_formatters.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class StepProfileSection extends StatelessWidget {
  final StepProfile? profile;
  final bool loadingProfile;
  final bool savingProfile;
  final bool editingProfile;
  final TextEditingController nameController;
  final TextEditingController goalController;
  final String editColor;
  final List<String> colorOptions;
  final VoidCallback onEditPressed;
  final VoidCallback onCancelEdit;
  final ValueChanged<String> onColorSelected;
  final VoidCallback onSave;

  const StepProfileSection({
    super.key,
    required this.profile,
    required this.loadingProfile,
    required this.savingProfile,
    required this.editingProfile,
    required this.nameController,
    required this.goalController,
    required this.editColor,
    required this.colorOptions,
    required this.onEditPressed,
    required this.onCancelEdit,
    required this.onColorSelected,
    required this.onSave,
  });

  @override
  Widget build(BuildContext context) {
    if (loadingProfile) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(8),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    final needsSetup =
        profile == null ||
        profile!.displayName.isEmpty ||
        profile!.displayName.startsWith('User');
    final showForm = needsSetup || editingProfile;

    if (!showForm) {
      return Card(
        child: ListTile(
          leading: CircleAvatar(
            backgroundColor: stepHexColor(profile!.displayColor),
            child: Text(
              profile!.displayName.isNotEmpty
                  ? profile!.displayName[0].toUpperCase()
                  : '?',
              style: const TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          title: Text(
            profile!.displayName,
            style: const TextStyle(fontWeight: FontWeight.bold),
          ),
          subtitle: Text('Daily target: ${_formatGoal(profile!.dailyGoal)}'),
          trailing: TextButton(
            onPressed: onEditPressed,
            child: const Text('Edit'),
          ),
        ),
      );
    }

    // Setup form
    final l = AppLocalizations.of(context)!;
    final targetPresets = [6000, 8000, 10000, 12000];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              needsSetup ? l.stepsSetupProfileTitle : 'Edit step target',
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: nameController,
              decoration: const InputDecoration(
                labelText: 'Display name',
                hintText: 'How others see you on the leaderboard',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: goalController,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(
                labelText: 'Daily step target',
                hintText: 'Example: 7500',
                helperText: 'Choose a realistic goal between 1,000 and 100,000',
                prefixIcon: Icon(Icons.flag_outlined),
                suffixText: 'steps',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: targetPresets.map((steps) {
                return ActionChip(
                  label: Text(_formatGoal(steps)),
                  onPressed: savingProfile
                      ? null
                      : () {
                          goalController.text = steps.toString();
                        },
                );
              }).toList(),
            ),
            const SizedBox(height: 16),
            Text(
              l.stepsPickColor,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: colorOptions.map((hex) {
                final selected = editColor == hex;
                return GestureDetector(
                  onTap: () => onColorSelected(hex),
                  child: Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: stepHexColor(hex),
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: selected ? Colors.black : Colors.transparent,
                        width: 2,
                      ),
                    ),
                    child: selected
                        ? const Icon(Icons.check, color: Colors.white, size: 18)
                        : null,
                  ),
                );
              }).toList(),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                if (!needsSetup) ...[
                  Expanded(
                    child: OutlinedButton(
                      onPressed: savingProfile ? null : onCancelEdit,
                      child: const Text('Cancel'),
                    ),
                  ),
                  const SizedBox(width: 12),
                ],
                Expanded(
                  flex: 2,
                  child: ElevatedButton(
                    onPressed: savingProfile ? null : onSave,
                    child: savingProfile
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Text(l.stepsSaveProfile),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  static String _formatGoal(int steps) {
    if (steps >= 1000 && steps % 1000 == 0) {
      return '${steps ~/ 1000}k steps';
    }
    if (steps >= 1000) {
      return '${(steps / 1000).toStringAsFixed(1)}k steps';
    }
    return '$steps steps';
  }
}
