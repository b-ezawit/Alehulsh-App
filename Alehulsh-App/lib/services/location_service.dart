import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import '../utils/geohash_util.dart';

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
  String? _currentFCMGeohashTopic;
  DateTime? _lastFirestoreSyncTime;
  Position? _lastSyncedPosition;

  Future<void> _initFastLocation() async {
    try {
      // 1. Immediately grab cached last known position in microseconds
      Position? lastKnown = await Geolocator.getLastKnownPosition();
      if (lastKnown != null) {
        _currentPosition = lastKnown;
        positionNotifier.value = lastKnown;
        _updateFCMGeohashSubscription(lastKnown.latitude, lastKnown.longitude);
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
          _updateFCMGeohashSubscription(position.latitude, position.longitude);
          _syncLocationToFirestoreDebounced(position);
        }, onError: (e) {
          _streamActive = false;
          debugPrint("[LocationService] Position stream error: $e");
        }, cancelOnError: false);
      }
    } catch (_) {
      _streamActive = false;
    }
  }

  /// Automatically subscribe device to local 500m / 2km Geohash FCM broadcast topic
  void _updateFCMGeohashSubscription(double lat, double lng) async {
    try {
      final geohash5 = GeohashUtil.getFCMTopicGeohash(lat, lng);
      final newTopic = "sos_radar_$geohash5";
      if (newTopic != _currentFCMGeohashTopic) {
        if (_currentFCMGeohashTopic != null) {
          await FirebaseMessaging.instance.unsubscribeFromTopic(_currentFCMGeohashTopic!);
        }
        await FirebaseMessaging.instance.subscribeToTopic(newTopic);
        _currentFCMGeohashTopic = newTopic;
        debugPrint("[LocationService] Subscribed to localized 500m SOS topic: $newTopic");
      }
    } catch (e) {
      debugPrint("[LocationService] FCM topic subscription note: $e");
    }
  }

  /// Debounced sync to user's profile to prevent high write costs during viral movement
  void _syncLocationToFirestoreDebounced(Position position) async {
    final now = DateTime.now();
    final uid = FirebaseAuth.instance.currentUser?.uid;
    if (uid == null || uid.isEmpty) return;

    // Check distance moved since last sync
    double distanceMoved = 999.0;
    if (_lastSyncedPosition != null) {
      distanceMoved = Geolocator.distanceBetween(
        _lastSyncedPosition!.latitude,
        _lastSyncedPosition!.longitude,
        position.latitude,
        position.longitude,
      );
    }

    final bool timeElapsed = _lastFirestoreSyncTime == null ||
        now.difference(_lastFirestoreSyncTime!).inMinutes >= 10;
    final bool significantMove = distanceMoved >= 200.0; // 200m

    if (timeElapsed || significantMove) {
      _lastFirestoreSyncTime = now;
      _lastSyncedPosition = position;

      try {
        final geohash = GeohashUtil.encode(position.latitude, position.longitude);
        await FirebaseFirestore.instance.collection('users').doc(uid).set({
          'geo': {
            'geohash': geohash,
            'geopoint': GeoPoint(position.latitude, position.longitude),
          },
          'lastKnownLat': position.latitude,
          'lastKnownLng': position.longitude,
          'lastActive': FieldValue.serverTimestamp(),
        }, SetOptions(merge: true));
        debugPrint("[LocationService] Synced user geohash to Firestore: $geohash");
      } catch (e) {
        debugPrint("[LocationService] Note syncing user location: $e");
      }
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
