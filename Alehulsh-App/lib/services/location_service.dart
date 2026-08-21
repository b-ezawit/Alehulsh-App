import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';

class LocationService {
  static final LocationService _instance = LocationService._internal();
  factory LocationService() => _instance;
  LocationService._internal() {
    _initFastLocation();
  }

  Position? _currentPosition;
  Position? get currentPosition => _currentPosition;

  /// Reactive notifier that broadcasts device GPS location to all screens
  final ValueNotifier<Position?> positionNotifier = ValueNotifier<Position?>(null);

  StreamSubscription<Position>? _positionStreamSub;
  bool _streamActive = false;

  Future<void> _initFastLocation() async {
    try {
      // 1. Immediately grab cached last known position in microseconds
      Position? lastKnown = await Geolocator.getLastKnownPosition();
      if (lastKnown != null) {
        _currentPosition = lastKnown;
        positionNotifier.value = lastKnown;
        debugPrint("[LocationService] Fast cached GPS available: ${lastKnown.latitude}, ${lastKnown.longitude}");
      }
    } catch (_) {}

    // 2. Start continuous live GPS stream for real-time accuracy
    _startPositionStream();
  }

  void _startPositionStream() async {
    if (_streamActive) return; // Prevent duplicate stream subscriptions
    try {
      bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      LocationPermission permission = await Geolocator.checkPermission();
      if (serviceEnabled && (permission == LocationPermission.always || permission == LocationPermission.whileInUse)) {
        _positionStreamSub?.cancel();
        _streamActive = true;
        _positionStreamSub = Geolocator.getPositionStream(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.high,
            distanceFilter: 50, // Only update on significant movement (50m) to conserve Firestore writes & battery
          ),
        ).listen((Position position) {
          _currentPosition = position;
          positionNotifier.value = position;
        }, onError: (e) {
          _streamActive = false;
          debugPrint("[LocationService] Position stream error: $e");
        }, cancelOnError: false);
      }
    } catch (_) {
      _streamActive = false;
    }
  }

  /// Alias for getting current location
  Future<Position?> getCurrentLocation({BuildContext? context}) => checkAndRequestLocation(context: context);

  /// Check location service status and prompt user if turned off
  Future<Position?> checkAndRequestLocation({BuildContext? context}) async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      if (context != null && context.mounted) {
        _showEnableLocationDialog(context);
      }
      debugPrint("[LocationService] Location service is disabled on device.");
      return _currentPosition;
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        debugPrint("[LocationService] Location permission denied by user.");
        return _currentPosition;
      }
    }

    if (permission == LocationPermission.deniedForever) {
      debugPrint("[LocationService] Location permission permanently denied.");
      if (context != null && context.mounted) {
        _showPermissionDeniedForeverDialog(context);
      }
      return _currentPosition;
    }

    try {
      Position position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 6),
        ),
      );
      _currentPosition = position;
      positionNotifier.value = position;
      if (!_streamActive) _startPositionStream();
      debugPrint("[LocationService] Live GPS obtained: ${position.latitude}, ${position.longitude}");
      return position;
    } catch (e) {
      debugPrint("[LocationService] Error fetching live location: $e");
      return _currentPosition;
    }
  }

  void _showEnableLocationDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.location_off_rounded, color: Colors.orange),
            SizedBox(width: 8),
            Text("Turn on Location", style: TextStyle(fontSize: 16)),
          ],
        ),
        content: const Text(
          "Alehulsh requires your live GPS location to calculate 500m emergency radar and transmit your exact coordinates on Google Maps during an SOS.",
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("Later")),
          ElevatedButton(
            onPressed: () async {
              Navigator.pop(ctx);
              await Geolocator.openLocationSettings();
            },
            child: const Text("Open Location Settings"),
          ),
        ],
      ),
    );
  }

  void _showPermissionDeniedForeverDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("Location Permission Required"),
        content: const Text(
          "Location permission is permanently denied. Please enable it in app settings to allow live Google Map tracking.",
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("Cancel")),
          ElevatedButton(
            onPressed: () async {
              Navigator.pop(ctx);
              await Geolocator.openAppSettings();
            },
            child: const Text("App Settings"),
          ),
        ],
      ),
    );
  }

  /// Launch Google Maps with exact GPS coordinates
  Future<void> openGoogleMaps(double latitude, double longitude) async {
    final String googleMapsUrl = "https://www.google.com/maps/search/?api=1&query=$latitude,$longitude";
    final Uri uri = Uri.parse(googleMapsUrl);
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      } else {
        await launchUrl(uri, mode: LaunchMode.platformDefault);
      }
    } catch (e) {
      debugPrint("[LocationService] Could not launch Google Maps: $e");
    }
  }
}
