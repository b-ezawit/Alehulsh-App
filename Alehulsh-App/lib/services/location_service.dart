import '../api/api_runtime.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';
import '../auth/identity_runtime.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import '../utils/geohash_util.dart';
import 'account_scope.dart';

class LocationService {
  static final LocationService _instance = LocationService._internal();
  factory LocationService() => _instance;
  LocationService._internal();

  final AccountScope _scope = AccountScope();
  String? _owner;
  bool _enabled = false;
  Future<void> _topicWork = Future.value();

  bool _valid(AccountTicket ticket) => _enabled && _scope.owns(ticket) && IdentityRuntime.current?.uid == ticket.owner;

  /// Applies to collection and future alerts, never cancellation of an incident.
  Future<void> configure({required String? owner, required bool enabled}) async {
    if (_owner == owner && _enabled == enabled) return;
    _owner = owner;
    _enabled = enabled && owner != null;
    _scope.bind(null);
    _scope.bind(_enabled ? owner : null);
    _streamActive = false;
    final old = _positionStreamSub;
    _positionStreamSub = null;
    _currentPosition = null;
    _lastSyncedPosition = null;
    _lastFirestoreSyncTime = null;
    positionNotifier.value = null;
    _setTopic(null, null);
    await old?.cancel();
    final ticket = owner == null ? null : _scope.capture(owner);
    if (ticket != null && _valid(ticket)) await _initFastLocation(ticket);
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

  Future<void> _initFastLocation(AccountTicket ticket) async {
    if (!_valid(ticket)) return;
    try {
      // 1. Immediately grab cached last known position in microseconds
      Position? lastKnown = await Geolocator.getLastKnownPosition();
      if (lastKnown != null && _valid(ticket)) {
        _currentPosition = lastKnown;
        positionNotifier.value = lastKnown;
        _updateFCMGeohashSubscription(lastKnown.latitude, lastKnown.longitude, ticket);
        debugPrint('[LocationService] Cached location available');
      }
    } catch (_) {}

    // 2. Start continuous live GPS stream for real-time accuracy
    _startPositionStream(ticket);
  }

  void _startPositionStream(AccountTicket ticket) async {
    if (!_valid(ticket)) return;
    if (_streamActive) return; // Prevent duplicate stream subscriptions
    try {
      bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      LocationPermission permission = await Geolocator.checkPermission();
      if (_valid(ticket) && serviceEnabled && (permission == LocationPermission.always || permission == LocationPermission.whileInUse)) {
        _positionStreamSub?.cancel();
        _streamActive = true;
        _positionStreamSub = Geolocator.getPositionStream(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.high,
            distanceFilter: 50, // Only update on significant movement (50m) to conserve Firestore writes & battery
          ),
        ).listen((Position position) {
          if (!_valid(ticket)) return;
          _currentPosition = position;
          positionNotifier.value = position;
          _updateFCMGeohashSubscription(position.latitude, position.longitude, ticket);
          _syncLocationToFirestoreDebounced(position, ticket);
        }, onError: (e) {
          if (!_valid(ticket)) return;
          _streamActive = false;
          _currentPosition = null;
          positionNotifier.value = null;
          debugPrint('[LocationService] Location stream unavailable');
        }, cancelOnError: false);
      }
    } catch (_) {
      if (_valid(ticket)) _streamActive = false;
    }
  }

  /// Automatically subscribe device to local 500m / 2km Geohash FCM broadcast topic
  void _updateFCMGeohashSubscription(double lat, double lng, AccountTicket ticket) {
    if(ApiRuntime.enabled)return;
    if (_valid(ticket)) _setTopic('sos_radar_${GeohashUtil.getFCMTopicGeohash(lat, lng)}', ticket);
  }

  void _setTopic(String? topic, AccountTicket? ticket) {
    _topicWork = _topicWork.catchError((_) {}).then((_) async {
      if (topic != null && (ticket == null || !_valid(ticket))) return;
      if (_currentFCMGeohashTopic == topic) return;
      final previous = _currentFCMGeohashTopic;
      _currentFCMGeohashTopic = null;
      if (previous != null) await FirebaseMessaging.instance.unsubscribeFromTopic(previous).timeout(const Duration(seconds: 5));
      if (topic != null && ticket != null && _valid(ticket)) {
        await FirebaseMessaging.instance.subscribeToTopic(topic).timeout(const Duration(seconds: 5));
        if (_valid(ticket)) {
          _currentFCMGeohashTopic = topic;
        } else {
          await FirebaseMessaging.instance.unsubscribeFromTopic(topic).timeout(const Duration(seconds: 5));
        }
      }
    }).catchError((_) { debugPrint('[LocationService] Subscription cleanup pending'); });
  }

  /// Debounced sync to user's profile to prevent high write costs during viral movement
  void _syncLocationToFirestoreDebounced(Position position, AccountTicket ticket) async {
    if(ApiRuntime.enabled || !_valid(ticket)) return;
    final now = DateTime.now();
    final uid = ticket.owner;

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
        debugPrint('[LocationService] Location update confirmed');
      } catch (e) {
        debugPrint('[LocationService] Location update unavailable');
      }
    }
  }

  /// Alias for getting current location
  Future<Position?> getCurrentLocation({BuildContext? context}) => checkAndRequestLocation(context: context);

  /// Check location service status and prompt user if turned off
  Future<Position?> checkAndRequestLocation({BuildContext? context}) async {
    final owner = _owner;
    final ticket = owner == null ? null : _scope.capture(owner);
    if (ticket == null || !_valid(ticket)) return null;
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      if (context != null && context.mounted) {
        _showEnableLocationDialog(context);
      }
      debugPrint("[LocationService] Location service is disabled on device.");
      return _valid(ticket) ? _currentPosition : null;
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        await configure(owner: owner, enabled: false);
        return null;
      }
    }

    if (permission == LocationPermission.deniedForever) {
      debugPrint("[LocationService] Location permission permanently denied.");
      if (context != null && context.mounted) {
        _showPermissionDeniedForeverDialog(context);
      }
      await configure(owner: owner, enabled: false);
      return null;
    }

    try {
      Position position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 6),
        ),
      );
      if (!_valid(ticket)) return null;
      _currentPosition = position;
      positionNotifier.value = position;
      if (!_streamActive) _startPositionStream(ticket);
      debugPrint('[LocationService] Location fix obtained');
      return position;
    } catch (e) {
      debugPrint('[LocationService] Fresh location unavailable');
      return _valid(ticket) ? _currentPosition : null;
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
