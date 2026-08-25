import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:table_calendar/table_calendar.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/permissions_service.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/features/appointments/services/appointment_feed_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

class CalendarScreen extends StatefulWidget {
  const CalendarScreen({
    super.key,
    this.feedRepository = const ApiAppointmentFeedRepository(),
  });

  /// Cache-first source for the appointment leg — the same
  /// `/appointments/patient/:id` entry the dashboard and "My Appointments"
  /// read. See [AppointmentFeedRepository].
  final AppointmentFeedRepository feedRepository;

  @override
  State<CalendarScreen> createState() => _CalendarScreenState();
}

class _CalendarScreenState extends State<CalendarScreen> {
  DateTime focusedDay = DateTime.now();
  DateTime? selectedDay;

  final Map<DateTime, List<Map<String, dynamic>>> allEvents = {};

  bool permissionsGranted = false;
  bool _isLoadingEvents = false;
  String? _loadError;
  // As-of state for the appointment leg, surfaced by the OfflineBanner
  // exactly as the dashboard and "My Appointments" surface it for the
  // same feed.
  String? _staleLabel;
  DateTime? _cachedAt;
  // The last raw rows of each feed, kept so a background appointment
  // refresh can rebuild the merged event map without re-fetching the
  // other two.
  List<dynamic>? _appointmentRows;
  List<dynamic>? _investigationRows;
  List<dynamic>? _pharmacyRows;
  // The DB-minted users.uid (integer id), stored at login. The self feeds
  // key off req.user, but /appointments/patient/:id needs the numeric id;
  // the phone used previously UUID-rejected on every feed.
  String? _patientDbId;

  @override
  void initState() {
    super.initState();
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
      _patientDbId ??= await VHSecureStorage.instance.read(key: 'user_id');
      await _loadBackendEvents();
      if (mounted) {
        setState(() => _isLoadingEvents = false);
      }
    } else {
      final theme = Theme.of(context);
      final loc = AppLocalizations.of(context)!;
      ScaffoldMessenger.of(context).showSnackBar(
        LiveRegionSnackBar.build(
          message: loc.calendarPermissionDenied,
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  Future<void> _loadBackendEvents() async {
    if (!mounted) return;
    final loc = AppLocalizations.of(context)!;
    final dbId = _patientDbId;
    if (dbId == null || dbId.isEmpty) {
      setState(() => _loadError = loc.calendarLoadFailed);
      return;
    }
    // The appointment feed must key off the ACTIVE profile: the active
    // dependent's DB id when a guardian is viewing a dependent (the request
    // also carries X-Acting-As-Uid, so the backend authorizes the guardian
    // link — same pattern as appointments_list_tab), the guardian's stored
    // id otherwise. Using the stored guardian id under acting-as 403'd and
    // silently emptied the calendar (P4, 2026-08-18).
    final activeDep = context.read<DependentsProvider>().activeDependent;
    final effectiveId = activeDep?.id.toString() ?? dbId;
    try {
      // Self feeds: /appointments/patient/:id is keyed by the numeric users.id;
      // investigations + pharmacy derive the patient from the JWT (req.user,
      // which the acting-as hop rewrites to the active dependent).
      // The old /uid/:phone routes UUID-rejected the phone and returned nothing.
      //
      // The appointment leg goes through the CACHING client — the same cache
      // entry the dashboard writes and "My Appointments" reads — so a calendar
      // opened without a connection still shows the appointments already on
      // the device instead of a blank month. Future.wait keeps the three legs
      // parallel AND keeps the existing all-or-nothing error semantics: it
      // attaches a handler to every future, so a rejection is still one caught
      // error rather than an unhandled one.
      final responses = await Future.wait<Object>([
        widget.feedRepository.fetch(effectiveId),
        ApiClient.get('/investigations/bookings/my'),
        ApiClient.get('/pharmacy-orders/orders/my'),
      ]);

      if (!mounted) return;

      final appointmentFeed = responses[0] as CachedApiResponse;
      _appointmentRows = _asList(
        appointmentFeed.response,
        listKey: 'appointments',
      );
      _investigationRows = _asList(responses[1] as ApiResponse);
      _pharmacyRows = _asList(responses[2] as ApiResponse);

      setState(() {
        _loadError = null;
        _staleLabel = appointmentFeed.staleLabel;
        _cachedAt = appointmentFeed.cachedAt;
        _rebuildEvents(loc);
      });

      // Served from a still-fresh cache: apply the live copy when it lands so
      // the month converges without a second round of three fetches.
      final freshFuture = appointmentFeed.onFresh;
      if (freshFuture != null) {
        unawaited(
          freshFuture
              .then((fresh) async {
                if (!fresh.isSuccess) return;
                final refreshedAt = await widget.feedRepository.cachedAt(
                  effectiveId,
                );
                if (!mounted) return;
                setState(() {
                  _appointmentRows = _asList(fresh, listKey: 'appointments');
                  _staleLabel = null;
                  _cachedAt = refreshedAt;
                  _rebuildEvents(loc);
                });
              })
              .catchError((Object e) {
                debugPrint('Calendar appointment refresh failed: $e');
              }),
        );
      }
    } catch (e) {
      debugPrint('Error loading calendar data: $e');
      if (!mounted) return;
      final theme = Theme.of(context);
      setState(() => _loadError = loc.calendarLoadFailed);
      ScaffoldMessenger.of(context).showSnackBar(
        LiveRegionSnackBar.build(
          message: loc.calendarLoadFailed,
          backgroundColor: theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  /// Unwraps an [ApiResponse] into a list. The backend returns either a bare
  /// list in `data`, or a map wrapping it under [listKey] (appointments).
  List<dynamic>? _asList(dynamic response, {String? listKey}) {
    if (response == null || !response.isSuccess) return null;
    final data = response.data;
    if (data is List) return data;
    if (data is Map && listKey != null && data[listKey] is List) {
      return data[listKey] as List;
    }
    return null;
  }

  /// Recompose the merged day-to-events map from the last rows of each feed.
  /// Called inside setState by both the initial load and the background
  /// appointment refresh, so a refreshed appointment leg never drops the
  /// investigation and pharmacy events fetched alongside it.
  void _rebuildEvents(AppLocalizations loc) {
    final Map<DateTime, List<Map<String, dynamic>>> newEvents = {};
    _parseAndAddEvents(
      newEvents,
      _appointmentRows,
      'appointment',
      (item) =>
          item['department_name'] ??
          item['department'] ??
          loc.eventTypesAppointment,
      (item) => item['appointment_date'] ?? item['created_at'],
    );
    _parseAndAddEvents(
      newEvents,
      _investigationRows,
      'investigation',
      (item) =>
          item['custom_test_names'] ??
          item['test_name'] ??
          loc.eventTypesInvestigation,
      (item) => item['preferred_date'] ?? item['created_at'],
    );
    _parseAndAddEvents(
      newEvents,
      _pharmacyRows,
      'pharmacy',
      (_) => loc.eventTypesPharmacyOrder,
      (item) => item['created_at'],
    );
    allEvents
      ..clear()
      ..addAll(newEvents);
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
                _loadBackendEvents().whenComplete(() {
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
              // The appointment leg is served cache-first, so the month
              // must never read as live when it is not: this states the
              // as-of time of the copy on screen, and becomes the
              // "showing cached data" treatment during an outage.
              OfflineBanner(staleLabel: _staleLabel, cachedAt: _cachedAt),
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
    // Surface load failures with a retry instead of a silent empty calendar.
    if (_loadError != null) {
      return DataStateBuilder<Map<String, dynamic>>(
        isLoading: false,
        error: _loadError,
        data: const [],
        builder: (context, data) => const SizedBox.shrink(),
        errorTitle: loc.calendarLoadFailed,
        errorActionLabel: loc.refreshCalendar,
        onRetry: () {
          setState(() => _isLoadingEvents = true);
          _loadBackendEvents().whenComplete(() {
            if (mounted) setState(() => _isLoadingEvents = false);
          });
        },
      );
    }
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
