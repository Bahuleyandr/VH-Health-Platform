import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../../../core/config/campus_config.dart';
import '../../../core/services/ambulance_tracking_api_service.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

typedef ActiveTrackingLoader = Future<Map<String, dynamic>> Function();
typedef PositionPoster = Future<Map<String, dynamic>> Function({
  required int ambulanceRequestId,
  required double latitude,
  required double longitude,
  double? speedKmh,
  double? headingDeg,
  double? accuracyM,
});
typedef DevicePositionProvider = Future<Position> Function();

/// Live view of actively-transporting ambulance requests (ED side) plus the
/// crew-side "share my location" toggle. The backend feature is config-gated
/// per tenant; when disabled this screen renders an explicit banner.
///
/// v1 deliberately polls (15s list refresh) instead of holding a socket —
/// the backend also broadcasts `staff:ambulance-tracking` for boards that
/// already keep a WebSocket open. No map widget: text/ETA/distance UI only.
class AmbulanceTrackingScreen extends StatefulWidget {
  const AmbulanceTrackingScreen({
    super.key,
    this.loadActive,
    this.postPosition,
    this.getDevicePosition,
    this.pollInterval = const Duration(seconds: 15),
    this.shareInterval = const Duration(seconds: 20),
  });

  final ActiveTrackingLoader? loadActive;
  final PositionPoster? postPosition;
  final DevicePositionProvider? getDevicePosition;
  final Duration pollInterval;
  final Duration shareInterval;

  @override
  State<AmbulanceTrackingScreen> createState() =>
      _AmbulanceTrackingScreenState();
}

class _AmbulanceTrackingScreenState extends State<AmbulanceTrackingScreen> {
  bool _loading = true;
  bool _enabled = true;
  String? _error;
  List<Map<String, dynamic>> _requests = const [];
  Timer? _pollTimer;

  // Crew-side location sharing: at most one request shared at a time.
  int? _sharingRequestId;
  Timer? _shareTimer;
  String? _shareError;

  @override
  void initState() {
    super.initState();
    _refresh();
    _pollTimer = Timer.periodic(widget.pollInterval, (_) => _refresh());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _shareTimer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final loader =
          widget.loadActive ?? AmbulanceTrackingApiService.listActive;
      final data = await loader();
      if (!mounted) return;
      final rows = (data['requests'] is List)
          ? (data['requests'] as List)
                .whereType<Map>()
                .map((row) => Map<String, dynamic>.from(row))
                .toList()
          : <Map<String, dynamic>>[];
      setState(() {
        _loading = false;
        _enabled = data['enabled'] == true;
        _requests = rows;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _toggleShare(int requestId, bool share) async {
    _shareTimer?.cancel();
    _shareTimer = null;
    if (!share) {
      setState(() {
        _sharingRequestId = null;
        _shareError = null;
      });
      return;
    }
    setState(() {
      _sharingRequestId = requestId;
      _shareError = null;
    });
    await _postCurrentPosition(requestId);
    _shareTimer = Timer.periodic(
      widget.shareInterval,
      (_) => _postCurrentPosition(requestId),
    );
  }

  Future<void> _postCurrentPosition(int requestId) async {
    try {
      final getPosition =
          widget.getDevicePosition ??
          () => Geolocator.getCurrentPosition(
            locationSettings: const LocationSettings(
              accuracy: LocationAccuracy.high,
              timeLimit: Duration(seconds: 15),
            ),
          );
      final position = await getPosition();
      final poster =
          widget.postPosition ??
          ({
            required int ambulanceRequestId,
            required double latitude,
            required double longitude,
            double? speedKmh,
            double? headingDeg,
            double? accuracyM,
          }) => AmbulanceTrackingApiService.postPosition(
            ambulanceRequestId: ambulanceRequestId,
            latitude: latitude,
            longitude: longitude,
            speedKmh: speedKmh,
            headingDeg: headingDeg,
            accuracyM: accuracyM,
          );
      await poster(
        ambulanceRequestId: requestId,
        latitude: position.latitude,
        longitude: position.longitude,
        // Geolocator reports speed in m/s; the API takes km/h.
        speedKmh: position.speed >= 0 ? position.speed * 3.6 : null,
        headingDeg: position.heading >= 0 && position.heading < 360
            ? position.heading
            : null,
        accuracyM: position.accuracy >= 0 ? position.accuracy : null,
      );
      if (!mounted) return;
      if (_shareError != null) setState(() => _shareError = null);
    } catch (e) {
      if (!mounted) return;
      final disabled =
          e is AmbulanceTrackingException &&
          (e.featureDisabled || e.statusCode == 403);
      setState(() {
        _shareError = e.toString();
        if (disabled) {
          _shareTimer?.cancel();
          _shareTimer = null;
          _sharingRequestId = null;
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('s4.lib.ambulance_tracking.title')),
        actions: [
          IconButton(
            tooltip: s.actionRefresh,
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _refresh,
              child: ListView(
                key: const ValueKey('ambulance-tracking-scroll'),
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                children: [
                  if (!_enabled)
                    _Banner(
                      key: const ValueKey('ambulance-tracking-disabled'),
                      icon: Icons.gps_off,
                      color: Colors.orange,
                      text: s.lookup('s4.lib.ambulance_tracking.disabled'),
                    ),
                  if (_error != null)
                    _Banner(
                      icon: Icons.error_outline,
                      color: Colors.red,
                      text: _error!,
                    ),
                  if (_shareError != null)
                    _Banner(
                      key: const ValueKey('ambulance-tracking-share-error'),
                      icon: Icons.location_disabled,
                      color: Colors.red,
                      text: _shareError!,
                    ),
                  if (_enabled && _requests.isEmpty && _error == null)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 48),
                      child: Center(
                        child: Text(
                          s.lookup('s4.lib.ambulance_tracking.no_active'),
                          style: Theme.of(context).textTheme.bodyLarge,
                        ),
                      ),
                    ),
                  for (final request in _requests)
                    _AmbulanceCard(
                      request: request,
                      sharing:
                          _sharingRequestId ==
                          _asInt(request['ambulance_request_id']),
                      onShareChanged: (share) {
                        final id = _asInt(request['ambulance_request_id']);
                        if (id != null) _toggleShare(id, share);
                      },
                    ),
                ],
              ),
            ),
    );
  }
}

int? _asInt(Object? value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

double? _asDouble(Object? value) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '');
}

class _AmbulanceCard extends StatelessWidget {
  const _AmbulanceCard({
    required this.request,
    required this.sharing,
    required this.onShareChanged,
  });

  final Map<String, dynamic> request;
  final bool sharing;
  final ValueChanged<bool> onShareChanged;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    final lat = _asDouble(request['latitude']);
    final lng = _asDouble(request['longitude']);
    final speed = _asDouble(request['speed_kmh']);
    final recordedAt = DateTime.tryParse(
      request['position_recorded_at']?.toString() ?? '',
    );
    final etaAt = DateTime.tryParse(request['eta_latest_at']?.toString() ?? '');
    final hasFix = lat != null && lng != null;
    final distanceMeters = hasFix
        ? Geolocator.distanceBetween(
            CampusConfig.latitude,
            CampusConfig.longitude,
            lat,
            lng,
          )
        : null;

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.local_shipping,
                  size: 20,
                  color: theme.colorScheme.primary,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '${request['request_number'] ?? ''}'
                    '${request['ambulance_unit_id'] != null ? ' · ${request['ambulance_unit_id']}' : ''}',
                    style: theme.textTheme.titleSmall,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                Chip(
                  label: Text(
                    '${request['status'] ?? ''}'.replaceAll('_', ' '),
                    style: theme.textTheme.labelSmall,
                  ),
                  visualDensity: VisualDensity.compact,
                ),
              ],
            ),
            if (request['destination'] != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  '${request['destination']}',
                  style: theme.textTheme.bodySmall,
                ),
              ),
            const SizedBox(height: 8),
            if (!hasFix)
              Text(
                s.lookup('s4.lib.ambulance_tracking.no_fix'),
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              )
            else ...[
              Text(
                '${lat.toStringAsFixed(5)}, ${lng.toStringAsFixed(5)}'
                '${speed != null ? ' · ${speed.toStringAsFixed(0)} km/h' : ''}',
                key: const ValueKey('ambulance-card-position'),
                style: theme.textTheme.bodyMedium,
              ),
              const SizedBox(height: 2),
              Text(
                [
                  if (distanceMeters != null)
                    s.format('s4.lib.ambulance_tracking.distance', {
                      'km': (distanceMeters / 1000).toStringAsFixed(1),
                    }),
                  if (recordedAt != null)
                    s.format('s4.lib.ambulance_tracking.updated', {
                      'age': _formatAge(recordedAt),
                    }),
                ].join(' · '),
                style: theme.textTheme.bodySmall,
              ),
            ],
            if (etaAt != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  s.format('s4.lib.ambulance_tracking.eta', {
                    'time': TimeOfDay.fromDateTime(etaAt.toLocal())
                        .format(context),
                  }),
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            const Divider(height: 16),
            SwitchListTile(
              key: ValueKey(
                'ambulance-share-${request['ambulance_request_id']}',
              ),
              contentPadding: EdgeInsets.zero,
              dense: true,
              title: Text(
                s.lookup('s4.lib.ambulance_tracking.share'),
                style: theme.textTheme.bodyMedium,
              ),
              subtitle: Text(
                s.lookup('s4.lib.ambulance_tracking.share_hint'),
                style: theme.textTheme.bodySmall,
              ),
              value: sharing,
              onChanged: onShareChanged,
            ),
          ],
        ),
      ),
    );
  }

  static String _formatAge(DateTime instant) {
    final age = DateTime.now().difference(instant);
    if (age.inSeconds < 60) return '${age.inSeconds}s';
    if (age.inMinutes < 60) return '${age.inMinutes}m';
    return '${age.inHours}h ${age.inMinutes % 60}m';
  }
}

class _Banner extends StatelessWidget {
  const _Banner({
    super.key,
    required this.icon,
    required this.color,
    required this.text,
  });

  final IconData icon;
  final Color color;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 8),
          Expanded(child: Text(text)),
        ],
      ),
    );
  }
}
