import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:table_calendar/table_calendar.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class CalendarScreen extends StatefulWidget {
  const CalendarScreen({super.key});

  @override
  State<CalendarScreen> createState() => _CalendarScreenState();
}

class _CalendarScreenState extends State<CalendarScreen> {
  DateTime focusedDay = DateTime.now();
  DateTime? selectedDay;

  final Map<DateTime, List<Map<String, dynamic>>> allEvents = {};

  bool permissionsGranted = false;
  bool _isLoadingEvents = false;
  late final String _uid;

  @override
  void initState() {
    super.initState();
    _uid = context.read<UserProvider>().phone;
    _checkPermissionsAndLoad();
  }

  // ────────────────── permissions ──────────────────
  Future<void> _checkPermissionsAndLoad() async {
    final granted = await PermissionsService.requestCalendarPermission(context);

    if (!mounted) return;

    if (granted) {
      setState(() {
        permissionsGranted = true;
        _isLoadingEvents = true;
      });
      await _loadBackendEvents(_uid);
      if (mounted) {
        setState(() => _isLoadingEvents = false);
      }
    } else {
      final theme = Theme.of(context);
      final loc = AppLocalizations.of(context)!;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(loc.calendarPermissionDenied),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  Future<void> _loadBackendEvents(String uid) async {
    final loc = AppLocalizations.of(context)!;
    try {
      final responses = await Future.wait([
        ApiClient.get('/appointments/uid/$uid'),
        ApiClient.get('/investigations/uid/$uid'),
        ApiClient.get('/pharmacy-orders/orders/uid/$uid'),
      ]);

      if (!mounted) return;

      final Map<DateTime, List<Map<String, dynamic>>> newEvents = {};

      _parseAndAddEvents(
        newEvents,
        responses[0].isSuccess
            ? (responses[0].data is List ? responses[0].data : null)
            : null,
        'appointment',
        (item) => item['department'] ?? loc.eventTypesAppointment,
        (item) => item['date'] ?? item['created_at'],
      );
      _parseAndAddEvents(
        newEvents,
        responses[1].isSuccess
            ? (responses[1].data is List ? responses[1].data : null)
            : null,
        'investigation',
        (item) => item['test_name'] ?? loc.eventTypesInvestigation,
        (item) => item['created_at'],
      );
      _parseAndAddEvents(
        newEvents,
        responses[2].isSuccess
            ? (responses[2].data is List ? responses[2].data : null)
            : null,
        'pharmacy',
        (_) => loc.eventTypesPharmacyOrder,
        (item) => item['created_at'],
      );

      if (!mounted) return;
      setState(() {
        allEvents.clear();
        allEvents.addAll(newEvents);
      });
    } catch (e) {
      debugPrint('Error loading calendar data: $e');
      if (!mounted) return;
      final theme = Theme.of(context);
      final loc = AppLocalizations.of(context)!;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(loc.calendarLoadFailed),
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  void _parseAndAddEvents(
    Map<DateTime, List<Map<String, dynamic>>> eventMap,
    List<dynamic>? dataList,
    String type,
    String Function(dynamic) getTitle,
    String? Function(dynamic) getDateString,
  ) {
    if (dataList == null) return;
    for (final item in dataList) {
      final dateStr = getDateString(item);
      if (dateStr == null) continue;
      try {
        final eventDay = DateTime.parse(dateStr).toLocal().normalize();
        eventMap.putIfAbsent(eventDay, () => []).add({
          'type': type,
          'title': getTitle(item),
        });
      } catch (e) {
        debugPrint('Error parsing $type date: $dateStr, error: $e');
      }
    }
  }

  List<Map<String, dynamic>> _getEventsForDay(DateTime day) {
    return allEvents[day.normalize()] ?? [];
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final loc = AppLocalizations.of(context)!;

    if (!permissionsGranted || _isLoadingEvents) {
      return Scaffold(
        appBar: AppBar(title: Text(loc.calendarFullAccess)),
        body: Center(
          child: _isLoadingEvents
              ? CircularProgressIndicator(
                  valueColor: AlwaysStoppedAnimation(colorScheme.primary),
                )
              : Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.event_busy,
                      size: 60,
                      color: colorScheme.onSurface.withAlpha(153),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      loc.calendarEnablePermissions,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 16),
                    ElevatedButton.icon(
                      icon: const Icon(Icons.settings),
                      label: Text(loc.openSettings),
                      onPressed: openAppSettings,
                    ),
                  ],
                ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(loc.calendarFullAccess),
        actions: [
          IconButton(
            icon: Icon(
              Icons.refresh,
              color:
                  theme.appBarTheme.actionsIconTheme?.color ??
                  colorScheme.onPrimary,
            ),
            tooltip: loc.refreshCalendar,
            onPressed: () {
              if (permissionsGranted && !_isLoadingEvents) {
                setState(() => _isLoadingEvents = true);
                _loadBackendEvents(_uid).whenComplete(() {
                  if (mounted) setState(() => _isLoadingEvents = false);
                });
              }
            },
          ),
        ],
      ),
      body: Stack(
        children: [
          Positioned.fill(
            child: Image.asset(
              'assets/images/logo.png',
              fit: BoxFit.contain,
              color: colorScheme.primary.withAlpha(51),
              colorBlendMode: BlendMode.srcATop,
            ),
          ),
          Column(
            children: [
              TableCalendar(
                locale: Localizations.localeOf(context).toString(),
                firstDay: DateTime.utc(2020, 1, 1),
                lastDay: DateTime.utc(2030, 12, 31),
                focusedDay: focusedDay,
                selectedDayPredicate: (day) => isSameDay(day, selectedDay),
                onDaySelected: (selected, focused) => setState(() {
                  selectedDay = selected;
                  focusedDay = focused;
                }),
                headerStyle: HeaderStyle(
                  formatButtonVisible: false,
                  titleCentered: true,
                  titleTextStyle:
                      theme.textTheme.titleLarge ??
                      const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                      ),
                  leftChevronIcon: Icon(
                    Icons.chevron_left,
                    color: colorScheme.primary,
                  ),
                  rightChevronIcon: Icon(
                    Icons.chevron_right,
                    color: colorScheme.primary,
                  ),
                ),
                calendarStyle: CalendarStyle(
                  outsideDaysVisible: false,
                  todayDecoration: BoxDecoration(
                    color: colorScheme.primary.withAlpha(77),
                    shape: BoxShape.circle,
                  ),
                  selectedDecoration: BoxDecoration(
                    color: colorScheme.primary,
                    shape: BoxShape.circle,
                  ),
                ),
                eventLoader: _getEventsForDay,
              ),
              Expanded(child: _buildEventList(theme, colorScheme, loc)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildEventList(
    ThemeData theme,
    ColorScheme colorScheme,
    AppLocalizations loc,
  ) {
    final eventsToShow = _getEventsForDay(selectedDay ?? focusedDay);
    if (eventsToShow.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.event_note_outlined,
              size: 48,
              color: colorScheme.onSurfaceVariant.withAlpha(179),
            ),
            const SizedBox(height: 8),
            Text(
              selectedDay == null ? loc.selectDayPrompt : loc.noEventsForDay,
              style: theme.textTheme.bodyMedium,
              textAlign: TextAlign.center,
            ),
          ],
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      children: eventsToShow.map((event) {
        final String title = event['title']?.toString() ?? loc.unknownEvent;
        final String type = event['type']?.toString() ?? 'unknown';
        return Card(
          child: ListTile(
            leading: Icon(
              _iconForType(type),
              color: _iconColorForType(type, colorScheme),
            ),
            title: Text(title),
            subtitle: Text(locEventType(loc, type)),
          ),
        );
      }).toList(),
    );
  }

  IconData _iconForType(String type) {
    switch (type.toLowerCase()) {
      case 'appointment':
        return Icons.calendar_today_outlined;
      case 'pharmacy':
        return Icons.medication_outlined;
      case 'investigation':
        return Icons.science_outlined;
      default:
        return Icons.info_outline;
    }
  }

  Color _iconColorForType(String type, ColorScheme colorScheme) {
    switch (type.toLowerCase()) {
      case 'appointment':
        return colorScheme.primary;
      case 'pharmacy':
        return Colors.orangeAccent;
      case 'investigation':
        return Colors.green;
      default:
        return colorScheme.onSurfaceVariant;
    }
  }

  String locEventType(AppLocalizations loc, String type) {
    switch (type.toLowerCase()) {
      case 'appointment':
        return loc.eventTypesAppointment;
      case 'pharmacy':
        return loc.eventTypesPharmacyOrder;
      case 'investigation':
        return loc.eventTypesInvestigation;
      default:
        return loc.unknownEvent;
    }
  }
}

extension NormalizeDate on DateTime {
  DateTime normalize() => DateTime(year, month, day);
}
