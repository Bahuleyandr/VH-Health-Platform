import 'package:geolocator/geolocator.dart';

class LocationService {
  static const double _campusLat = 11.0168;
  static const double _campusLng = 76.9558;
  static const double _campusRadius = 200.0; // meters

  static Future<Map<String, dynamic>> getLocationData() async {
    final result = <String, dynamic>{};

    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      return {'error': 'Location services are disabled. Please enable GPS.'};
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        return {'error': 'Location permission denied.'};
      }
    }
    if (permission == LocationPermission.deniedForever) {
      return {
        'error': 'Location permission permanently denied. Please enable in settings.'
      };
    }

    try {
      final position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: const Duration(seconds: 15),
      );

      final distance = Geolocator.distanceBetween(
        _campusLat,
        _campusLng,
        position.latitude,
        position.longitude,
      );

      result['latitude'] = position.latitude;
      result['longitude'] = position.longitude;
      result['accuracy'] = position.accuracy;
      result['distanceFromCampus'] = distance.round();
      result['withinCampus'] = distance <= _campusRadius;
    } catch (e) {
      return {'error': 'Failed to get location: ${e.toString()}'};
    }

    return result;
  }

  static String getLocationStatusMessage(Map<String, dynamic> locationData) {
    if (locationData.containsKey('error')) return locationData['error'] as String;
    final distance = locationData['distanceFromCampus'] as int? ?? 0;
    final within = locationData['withinCampus'] as bool? ?? false;
    if (within) return 'Within campus (${distance}m from center)';
    return 'Outside campus (${distance}m away)';
  }
}
