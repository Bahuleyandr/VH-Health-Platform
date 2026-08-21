import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:vhhealth_staff/features/emergency/screens/ambulance_tracking_screen.dart';

void main() {
  testWidgets(
    'renders the explicit disabled banner when the tenant gate is off',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: AmbulanceTrackingScreen(
            loadActive: () async => const {
              'enabled': false,
              'requests': [],
              'count': 0,
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('ambulance-tracking-disabled')),
        findsOneWidget,
      );
      expect(
        find.textContaining('Live GPS tracking is not enabled'),
        findsOneWidget,
      );
    },
  );

  testWidgets('shows an active unit with position, distance and ETA', (
    tester,
  ) async {
    final eta = DateTime.now().add(const Duration(minutes: 9));
    await tester.pumpWidget(
      MaterialApp(
        home: AmbulanceTrackingScreen(
          loadActive: () async => {
            'enabled': true,
            'count': 1,
            'requests': [
              {
                'ambulance_request_id': 42,
                'request_number': 'AMB-2026-0042',
                'status': 'en_route',
                'ambulance_unit_id': 'KA-01-AB-1234',
                'destination': 'VH Health Main ED',
                'latitude': 13.01,
                'longitude': 80.23,
                'speed_kmh': 54.0,
                'position_recorded_at': DateTime.now()
                    .subtract(const Duration(seconds: 20))
                    .toIso8601String(),
                'eta_latest_at': eta.toIso8601String(),
              },
            ],
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('AMB-2026-0042'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('ambulance-card-position')),
      findsOneWidget,
    );
    expect(find.textContaining('54 km/h'), findsOneWidget);
    expect(find.textContaining('km from hospital'), findsOneWidget);
    expect(find.textContaining('updated'), findsOneWidget);
    expect(find.textContaining('ETA'), findsOneWidget);
  });

  testWidgets('crew share toggle posts the device position in km/h', (
    tester,
  ) async {
    int? postedRequestId;
    double? postedLat;
    double? postedLng;
    double? postedSpeedKmh;
    await tester.pumpWidget(
      MaterialApp(
        home: AmbulanceTrackingScreen(
          loadActive: () async => {
            'enabled': true,
            'count': 1,
            'requests': [
              {
                'ambulance_request_id': 7,
                'request_number': 'AMB-2026-0007',
                'status': 'en_route',
              },
            ],
          },
          getDevicePosition: () async => Position(
            latitude: 12.9716,
            longitude: 77.5946,
            timestamp: DateTime.now(),
            accuracy: 5,
            altitude: 0,
            altitudeAccuracy: 0,
            heading: 90,
            headingAccuracy: 0,
            speed: 10, // m/s -> 36 km/h
            speedAccuracy: 0,
          ),
          postPosition:
              ({
                required int ambulanceRequestId,
                required double latitude,
                required double longitude,
                double? speedKmh,
                double? headingDeg,
                double? accuracyM,
              }) async {
                postedRequestId = ambulanceRequestId;
                postedLat = latitude;
                postedLng = longitude;
                postedSpeedKmh = speedKmh;
                return const {'is_latest': true, 'position': {}};
              },
        ),
      ),
    );
    await tester.pumpAndSettle();

    final toggle = find.byKey(const ValueKey('ambulance-share-7'));
    await tester.ensureVisible(toggle);
    await tester.tap(toggle);
    await tester.pumpAndSettle();

    expect(postedRequestId, 7);
    expect(postedLat, closeTo(12.9716, 0.0001));
    expect(postedLng, closeTo(77.5946, 0.0001));
    expect(postedSpeedKmh, closeTo(36.0, 0.01));

    // Turn sharing back off so no periodic timer outlives the test.
    await tester.tap(toggle);
    await tester.pumpAndSettle();
  });
}
