import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import '../theme/app_theme.dart';
import '../models/alert_model.dart';
import '../services/alert_service.dart';
import '../services/user_data_service.dart';
import '../services/location_service.dart';
import '../services/localization_service.dart';
import '../services/audio_playback_service.dart';
import '../services/emergency_ping_service.dart';
import 'auth_screen.dart';

class WomenForWomenScreen extends StatefulWidget {
  const WomenForWomenScreen({super.key});

  @override
  State<WomenForWomenScreen> createState() => _WomenForWomenScreenState();
}

class _WomenForWomenScreenState extends State<WomenForWomenScreen> {
  final AlertService _alertService = AlertService();
  final UserDataService _userDataService = UserDataService();
  final LocationService _locationService = LocationService();
  final LocalizationService _loc = LocalizationService();

  // Selected Category: 'All' or 'Contacts'
  String _selectedCategory = 'All';

  // Live device position for Haversine distance calculations
  Position? _currentDevicePosition;

  @override
  void initState() {
    super.initState();
    _currentDevicePosition = _locationService.currentPosition;
    _locationService.positionNotifier.addListener(_onPositionChanged);
    _fetchLiveLocation();
    EmergencyPingService.targetHighlightAlertId.addListener(_onHighlightChanged);
  }

  void _onPositionChanged() {
    if (mounted) {
      final pos = _locationService.positionNotifier.value;
      if (pos != null && pos != _currentDevicePosition) {
        setState(() {
          _currentDevicePosition = pos;
        });
      }
    }
  }

  void _onHighlightChanged() {
    if (mounted && EmergencyPingService.targetHighlightAlertId.value != null) {
      setState(() {
        _selectedCategory = 'All'; // Automatically switch to All so the highlighted card is visible
      });
    }
  }

  @override
  void dispose() {
    _locationService.positionNotifier.removeListener(_onPositionChanged);
    EmergencyPingService.targetHighlightAlertId.removeListener(_onHighlightChanged);
    super.dispose();
  }

  void _showLoginRequiredDialog(String message) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: Row(
          children: [
            const Icon(Icons.lock_person_rounded, color: AppTheme.primaryPink),
            const SizedBox(width: 8),
            Text(_loc.isAmharic ? "መግባት ያስፈልጋል" : "Login Required"),
          ],
        ),
        content: Text(
          message,
          style: const TextStyle(fontSize: 14),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(_loc.isAmharic ? "ዝጋ" : "Close"),
          ),
          ElevatedButton.icon(
            onPressed: () {
              Navigator.pop(ctx);
              Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const AuthScreen()),
              );
            },
            icon: const Icon(Icons.login_rounded, size: 16, color: Colors.white),
            label: Text(_loc.isAmharic ? "ግባ / ተመዝገብ" : "Login / Sign Up", style: const TextStyle(color: Colors.white)),
            style: ElevatedButton.styleFrom(backgroundColor: AppTheme.primaryPink),
          ),
        ],
      ),
    );
  }

  Future<void> _fetchLiveLocation() async {
    Position? pos = await _locationService.getCurrentLocation();
    if (mounted && pos != null) {
      setState(() {
        _currentDevicePosition = pos;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDarkMode = Theme.of(context).brightness == Brightness.dark;
    final userProfile = _userDataService.currentProfile;
    final currentUserId = userProfile.uid;
    final currentUserEmail = userProfile.email.trim().toLowerCase();
    final currentUserPhoneClean = userProfile.phoneNumber.trim().replaceAll(' ', '').replaceAll('-', '');

    // Emergency contact identifiers to match
    final contactEmails = userProfile.emergencyContacts
        .map((c) => c.email.trim().toLowerCase())
        .where((e) => e.isNotEmpty)
        .toSet();
    final contactNames = userProfile.emergencyContacts
        .map((c) => c.name.trim().toLowerCase())
        .where((n) => n.isNotEmpty)
        .toSet();
    final contactPhones = userProfile.emergencyContacts
        .map((c) => c.phone.trim().replaceAll(' ', '').replaceAll('-', ''))
        .where((p) => p.isNotEmpty)
        .toSet();
    final contactUids = userProfile.emergencyContacts
        .map((c) => c.id.trim())
        .where((id) => id.isNotEmpty)
        .toSet();

    double userLat = _currentDevicePosition?.latitude ?? _locationService.currentPosition?.latitude ?? 9.0125;
    double userLng = _currentDevicePosition?.longitude ?? _locationService.currentPosition?.longitude ?? 38.7636;
    bool hasAccurateGps = _currentDevicePosition != null || _locationService.currentPosition != null;

    return ValueListenableBuilder<String>(
      valueListenable: _loc.currentLocale,
      builder: (context, currentLang, child) {
        return Scaffold(
          appBar: AppBar(
            backgroundColor: Theme.of(context).scaffoldBackgroundColor,
            elevation: 0,
            title: Row(
              children: [
                const Icon(Icons.notifications_active_rounded, color: AppTheme.primaryPink),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _loc.tr('w4w_title'),
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            actions: [
              IconButton(
                icon: const Icon(Icons.my_location, color: AppTheme.primaryPink),
                tooltip: "Refresh GPS Location",
                onPressed: _fetchLiveLocation,
              ),
            ],
          ),
          body: Column(
            children: [
              // 2 Category Selector Tabs Bar (All & Emergency Contacts)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                color: isDarkMode ? AppTheme.darkCard : Colors.white,
                child: Row(
                  children: [
                    Expanded(
                      child: _buildCategoryTab(
                        "All",
                        _loc.tr('cat_all'),
                        Icons.all_inclusive_rounded,
                        isDarkMode,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: _buildCategoryTab(
                        "Contacts",
                        _loc.tr('cat_contacts'),
                        Icons.contact_phone_rounded,
                        isDarkMode,
                      ),
                    ),
                  ],
                ),
              ),

              const Divider(height: 1),

              // Real-Time Alert Stream List from Firestore
              Expanded(
                child: StreamBuilder<List<EmergencyAlert>>(
                  stream: _alertService.alertsStream,
                  builder: (context, snapshot) {
                    if (snapshot.connectionState == ConnectionState.waiting && !snapshot.hasData && !snapshot.hasError) {
                      return const Center(child: CircularProgressIndicator(color: AppTheme.primaryPink));
                    }

                    if (snapshot.hasError) {
                      debugPrint("[WomenForWomenScreen] Alert stream note: ${snapshot.error}");
                    }

                    final allAlerts = snapshot.data ?? [];

                    // Filter Alerts: 500m geodesic radius for community, universal for Emergency Contacts & Own Alert
                    List<EmergencyAlert> filteredAlerts = allAlerts.where((alert) {
                      // Only show active alerts
                      if (alert.status != 'active') return false;

                      bool isMe = alert.userId.isNotEmpty && alert.userId == currentUserId;

                      // Match if alert is from/to an emergency contact
                      bool isContactAlert = false;

                      // Check if alerter is in viewer's emergency contacts
                      if (contactEmails.contains(alert.alerterEmail.toLowerCase()) || contactEmails.contains(alert.userId.toLowerCase())) isContactAlert = true;
                      if (contactNames.contains(alert.userName.trim().toLowerCase())) isContactAlert = true;
                      if (contactUids.contains(alert.userId)) isContactAlert = true;
                      if (alert.alerterPhone.isNotEmpty) {
                        final cleanAlerterPhone = alert.alerterPhone.replaceAll(' ', '').replaceAll('-', '');
                        if (contactPhones.contains(cleanAlerterPhone)) isContactAlert = true;
                      }

                      // Check if viewer is in alerter's emergency contacts
                      if (currentUserEmail.isNotEmpty &&
                          alert.emergencyContactEmails.any((e) => e.toLowerCase() == currentUserEmail)) {
                        isContactAlert = true;
                      }
                      if (currentUserPhoneClean.isNotEmpty &&
                          alert.emergencyContactPhones.any((p) => p == currentUserPhoneClean || currentUserPhoneClean.endsWith(p) || p.endsWith(currentUserPhoneClean))) {
                        isContactAlert = true;
                      }
                      if (currentUserId.isNotEmpty && alert.emergencyContactUids.contains(currentUserId)) {
                        isContactAlert = true;
                      }
                      if (userProfile.fullName.isNotEmpty &&
                          alert.emergencyContactNames.any((n) => n.toLowerCase() == userProfile.fullName.trim().toLowerCase())) {
                        isContactAlert = true;
                      }

                      // Geodesic 500m distance calculation (Vincenty / WGS84 formula matching Google Maps)
                      double distanceMeters = Geolocator.distanceBetween(
                        userLat,
                        userLng,
                        alert.latitude,
                        alert.longitude,
                      );
                      bool isWithin500m = hasAccurateGps ? (distanceMeters <= 500.0) : true;

                      if (_selectedCategory == 'All') {
                        // User sees their own alert, emergency contact alerts, OR community alerts in 500m radius
                        return isMe || isContactAlert || isWithin500m;
                      } else if (_selectedCategory == 'Contacts') {
                        // Emergency Category: exclusively current user and designated emergency contacts
                        return isMe || isContactAlert;
                      }

                      return isMe || isContactAlert || isWithin500m;
                    }).toList();

                    // Sort: Put current user's alert ON TOP, followed by target notification alert
                    final targetHighlightId = EmergencyPingService.targetHighlightAlertId.value;
                    filteredAlerts.sort((a, b) {
                      if (a.userId == currentUserId) return -1;
                      if (b.userId == currentUserId) return 1;
                      if (targetHighlightId != null) {
                        if (a.id == targetHighlightId || a.userId == targetHighlightId) return -1;
                        if (b.id == targetHighlightId || b.userId == targetHighlightId) return 1;
                      }
                      return b.timestamp.compareTo(a.timestamp);
                    });

                    if (filteredAlerts.isEmpty) {
                      return Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(
                                Icons.shield_outlined,
                                size: 60,
                                color: AppTheme.primaryPink.withValues(alpha: 0.4),
                              ),
                              const SizedBox(height: 14),
                              Text(
                                _selectedCategory == 'Contacts'
                                    ? _loc.tr('w4w_no_contact_alerts')
                                    : _loc.tr('w4w_no_alerts'),
                                style: TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.bold,
                                  color: isDarkMode ? AppTheme.darkTextMain : AppTheme.lightTextMain,
                                ),
                                textAlign: TextAlign.center,
                              ),
                              const SizedBox(height: 8),
                              Text(
                                _selectedCategory == 'Contacts'
                                    ? (_loc.isAmharic
                                        ? "የአደጋ ጊዜ እውቂያዎችዎ በአሁኑ ወቅት ደህና ናቸው።"
                                        : "None of your designated emergency contacts are currently in danger.")
                                    : (_loc.isAmharic
                                        ? "የቀጥታ የማህበረሰብ የአደጋ መስመሮች በመከታተል ላይ ናቸው።"
                                        : "Monitoring real-time community emergency channels."),
                                style: TextStyle(fontSize: 12, color: isDarkMode ? Colors.white60 : Colors.black54),
                                textAlign: TextAlign.center,
                              ),
                            ],
                          ),
                        ),
                      );
                    }

                    return ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: filteredAlerts.length,
                      itemBuilder: (context, index) {
                        final alert = filteredAlerts[index];
                        return _buildAlertCard(context, alert, currentUserId, userLat, userLng, isDarkMode);
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  // Category Tab Helper Widget
  Widget _buildCategoryTab(String categoryKey, String displayLabel, IconData icon, bool isDarkMode) {
    bool isSelected = _selectedCategory == categoryKey;

    return GestureDetector(
      onTap: () => setState(() => _selectedCategory = categoryKey),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
        decoration: BoxDecoration(
          color: isSelected ? AppTheme.primaryPink : Colors.transparent,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: isSelected ? AppTheme.primaryPink : (isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder),
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              icon,
              size: 16,
              color: isSelected ? Colors.white : (isDarkMode ? Colors.white70 : Colors.black54),
            ),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                displayLabel,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                  color: isSelected ? Colors.white : (isDarkMode ? Colors.white70 : Colors.black54),
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  // Real Calculated Alert Card Component
  Widget _buildAlertCard(
    BuildContext context,
    EmergencyAlert alert,
    String currentUserId,
    double userLat,
    double userLng,
    bool isDarkMode,
  ) {
    bool isMyAlert = (alert.userId == currentUserId);
    bool isAcceptedByMe = alert.responders.contains(currentUserId);
    String distanceStr = alert.distanceLabel(userLat, userLng);

    final targetHighlightId = EmergencyPingService.targetHighlightAlertId.value;
    bool isHighlightedTarget = (targetHighlightId != null &&
        (alert.id == targetHighlightId || alert.userId == targetHighlightId));

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: isDarkMode ? AppTheme.darkCard : Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: isHighlightedTarget
              ? AppTheme.emergencyRed
              : (isMyAlert
                  ? AppTheme.primaryPink
                  : (alert.isUrgent
                      ? AppTheme.emergencyRed
                      : (alert.status == 'safe' ? Colors.green : (isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder)))),
          width: isHighlightedTarget ? 3.0 : ((isMyAlert || alert.isUrgent) ? 2.0 : 1.0),
        ),
        boxShadow: [
          BoxShadow(
            color: (isHighlightedTarget
                    ? AppTheme.emergencyRed
                    : (alert.isUrgent ? AppTheme.emergencyRed : AppTheme.primaryPink))
                .withValues(alpha: isHighlightedTarget ? 0.35 : 0.1),
            blurRadius: isHighlightedTarget ? 20 : 14,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // If this card is the target from a tapped push notification, display the Glowing Highlight Banner
          if (isHighlightedTarget) ...[
            Container(
              margin: const EdgeInsets.only(bottom: 12),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: AppTheme.emergencyRed.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppTheme.emergencyRed, width: 1.5),
              ),
              child: Row(
                children: [
                  const Icon(Icons.crisis_alert_rounded, color: AppTheme.emergencyRed, size: 20),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      "🚨 TARGET NOTIFICATION ALERT: ${alert.userName.toUpperCase()}",
                      style: const TextStyle(
                        color: AppTheme.emergencyRed,
                        fontWeight: FontWeight.bold,
                        fontSize: 12,
                      ),
                    ),
                  ),
                  GestureDetector(
                    onTap: () {
                      setState(() {
                        EmergencyPingService.targetHighlightAlertId.value = null;
                      });
                    },
                    child: const Icon(Icons.close_rounded, size: 18, color: Colors.white70),
                  ),
                ],
              ),
            ),
          ],
          // Header Row: User Avatar, Name/YOU Tag, Distance & Status Badge
          Row(
            children: [
              CircleAvatar(
                backgroundColor: isMyAlert
                    ? AppTheme.primaryPink
                    : (alert.isUrgent ? AppTheme.emergencyRed.withValues(alpha: 0.2) : AppTheme.primaryPink.withValues(alpha: 0.2)),
                child: Text(
                  isMyAlert ? _loc.tr('w4w_tag_you') : alert.userAvatar,
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: isMyAlert ? 10 : 14,
                    color: isMyAlert ? Colors.white : (alert.isUrgent ? AppTheme.emergencyRed : AppTheme.primaryPink),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            isMyAlert ? (_loc.isAmharic ? 'የእርስዎ ጥሪ' : 'Your Alert') : alert.userName,
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
                              color: isDarkMode ? AppTheme.darkTextMain : AppTheme.lightTextMain,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (isMyAlert) ...[
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: AppTheme.primaryPink,
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              _loc.tr('w4w_tag_you'),
                              style: const TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Colors.white),
                            ),
                          ),
                        ],
                        if (alert.isUrgent) ...[
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: AppTheme.emergencyRed.withValues(alpha: 0.2),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              _loc.tr('w4w_tag_urgent'),
                              style: const TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: AppTheme.emergencyRed),
                            ),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      "${(alert.locationName.toLowerCase().contains('gps') || alert.locationName.toLowerCase().contains('live')) ? 'Live GPS' : alert.locationName} • $distanceStr",
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: AppTheme.primaryPink,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              // Status Badge
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: alert.status == 'safe' ? Colors.green.withValues(alpha: 0.15) : AppTheme.primaryPink.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  alert.status == 'safe'
                      ? _loc.tr('w4w_tag_safe')
                      : (_loc.isAmharic ? "${alert.responders.length} እየረዱ ነው" : "${alert.responders.length} Responding"),
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                    color: alert.status == 'safe' ? Colors.green : AppTheme.primaryPink,
                  ),
                ),
              ),
            ],
          ),

          // Optional User Message Note (Displayed ONLY if provided)
          if (alert.message.trim().isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: isDarkMode ? Colors.white.withValues(alpha: 0.05) : Colors.grey.shade100,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                "\"${alert.message.trim()}\"",
                style: TextStyle(
                  fontSize: 13,
                  fontStyle: FontStyle.italic,
                  color: isDarkMode ? Colors.white.withValues(alpha: 0.9) : Colors.black87,
                ),
              ),
            ),
          ],

          // Buttons Row: Listen Voice Notes & View Location (Hidden for Safe category cards)
          if (alert.status != 'safe') ...[
            const SizedBox(height: 14),
            Row(
              children: [
                // 1. Listen Voice Notes Button (Interactive Audio Player)
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: alert.voiceNotes.isEmpty
                        ? null
                        : () {
                            if (!_userDataService.isLoggedIn) {
                              _showLoginRequiredDialog(_loc.isAmharic
                                  ? "የአደጋ ጊዜ ድምፅ መልእክቶችን ለማዳመጥ በመጀመሪያ መግባት አለብዎት!"
                                  : "You must log in to listen to emergency voice notes!");
                              return;
                            }
                            _showVoiceNotesModal(context, alert);
                          },
                    icon: Icon(
                      Icons.audiotrack_rounded,
                      size: 16,
                      color: alert.voiceNotes.isEmpty ? Colors.grey : AppTheme.primaryPink,
                    ),
                    label: Text(
                      alert.voiceNotes.isEmpty
                          ? _loc.tr('w4w_no_voice')
                          : "${_loc.tr('w4w_listen_voice')} (${alert.voiceNotes.length})",
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        color: alert.voiceNotes.isEmpty ? Colors.grey : AppTheme.primaryPink,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 8),
                      side: BorderSide(
                        color: alert.voiceNotes.isEmpty ? Colors.grey.shade400 : AppTheme.primaryPink,
                      ),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
                ),

                const SizedBox(width: 10),

                // 2. View Location Button (Opens Actual Google Maps!)
                OutlinedButton.icon(
                  onPressed: () {
                    if (!_userDataService.isLoggedIn) {
                      _showLoginRequiredDialog(_loc.isAmharic
                          ? "የቀጥታ ካርታ ቦታውን ለማየት በመጀመሪያ መግባት አለብዎት!"
                          : "You must log in to view live GPS alert location!");
                      return;
                    }
                    _locationService.openGoogleMaps(alert.latitude, alert.longitude);
                  },
                  icon: const Icon(Icons.map_rounded, size: 16, color: AppTheme.primaryPink),
                  label: Text(
                    _loc.tr('w4w_view_location'),
                    style: const TextStyle(fontSize: 11, color: AppTheme.primaryPink, fontWeight: FontWeight.bold),
                  ),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
                    side: const BorderSide(color: AppTheme.primaryPink),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ],
            ),
          ],

          const SizedBox(height: 12),

          // 3. "I am going" / "You are going" + Cancel Button
          if (alert.status == 'active' && !isMyAlert)
            SizedBox(
              width: double.infinity,
              child: isAcceptedByMe
                  ? Row(
                      children: [
                        // "You are going" indicator
                        Expanded(
                          child: ElevatedButton.icon(
                            onPressed: null,
                            icon: const Icon(Icons.check_circle, color: Colors.white, size: 18),
                            label: Text(
                              _loc.isAmharic ? "እየሄዱ ነው ✓" : "You are going ✓",
                              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Colors.white),
                            ),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Colors.green,
                              disabledBackgroundColor: Colors.green,
                              disabledForegroundColor: Colors.white,
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        // Cancel response button
                        ElevatedButton(
                          onPressed: () {
                            showDialog(
                              context: context,
                              builder: (ctx) => AlertDialog(
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
                                title: Row(
                                  children: [
                                    const Icon(Icons.heart_broken_rounded, color: Colors.redAccent, size: 24),
                                    const SizedBox(width: 8),
                                    Expanded(
                                      child: Text(
                                        _loc.isAmharic ? "እርግጠኛ ነዎት?" : "Are you sure?",
                                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                                      ),
                                    ),
                                  ],
                                ),
                                content: Text(
                                  _loc.isAmharic
                                      ? "😢 ${alert.userName} አሁን አደጋ ላይ ነው/ች!\n\nእርስዎ ብቻ ተስፋ ሰጪ ሊሆኑ ይችላሉ። እርዳታ በጣም ያስፈልጋታል/ታል!\n\nእባክዎ ይህንን ሰው ብቻውን/ብቻዋን አይተዉ..."
                                      : "😢 ${alert.userName} is in DANGER right now!\n\nYou could be their only hope. They desperately need help!\n\nPlease don't leave this person alone...",
                                  style: const TextStyle(fontSize: 14, height: 1.5),
                                ),
                                actions: [
                                  ElevatedButton.icon(
                                    onPressed: () => Navigator.pop(ctx),
                                    icon: const Icon(Icons.volunteer_activism_rounded, size: 16, color: Colors.white),
                                    label: Text(
                                      _loc.isAmharic ? "እረዳለሁ! 💪" : "I'll still go! 💪",
                                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
                                    ),
                                    style: ElevatedButton.styleFrom(backgroundColor: Colors.green),
                                  ),
                                  TextButton(
                                    onPressed: () async {
                                      Navigator.pop(ctx);
                                      await _alertService.unacceptAlert(alert.id, currentUserId);
                                      if (context.mounted) {
                                        ScaffoldMessenger.of(context).showSnackBar(
                                          SnackBar(
                                            content: Text(
                                              _loc.isAmharic
                                                  ? "ምላሽዎ ተሰርዟል። ${alert.userName} አሁንም እርዳታ ይፈልጋል/ትፈልጋለች..."
                                                  : "Your response has been withdrawn. ${alert.userName} still needs help...",
                                            ),
                                            backgroundColor: Colors.orange.shade700,
                                          ),
                                        );
                                      }
                                    },
                                    child: Text(
                                      _loc.isAmharic ? "ልተው" : "Cancel my help",
                                      style: const TextStyle(color: Colors.redAccent, fontWeight: FontWeight.bold),
                                    ),
                                  ),
                                ],
                              ),
                            );
                          },
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.redAccent,
                            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                          ),
                          child: Text(
                            _loc.isAmharic ? "ሰርዝ" : "Cancel",
                            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Colors.white),
                          ),
                        ),
                      ],
                    )
                  : ElevatedButton.icon(
                      onPressed: () async {
                        if (!_userDataService.isLoggedIn) {
                          _showLoginRequiredDialog(_loc.isAmharic
                              ? "ለአደጋ ጥሪዎች ምላሽ ለመስጠት እና ለማገዝ በመጀመሪያ መግባት አለብዎት!"
                              : "You must log in to respond to an emergency alert!");
                          return;
                        }
                        await _alertService.acceptAlert(alert.id, currentUserId);
                        _userDataService.recordAlertResponded();
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(
                                _loc.isAmharic
                                    ? "🏃‍♀️ ${alert.userName}ን ለማገዝ እየሄዱ ነው!"
                                    : "🏃‍♀️ You are going to help ${alert.userName}!",
                              ),
                              backgroundColor: Colors.green,
                            ),
                          );
                        }
                      },
                      icon: const Icon(Icons.volunteer_activism_rounded, color: Colors.white, size: 18),
                      label: Text(
                        _loc.isAmharic ? "🏃‍♀️ እሄዳለሁ" : "🏃‍♀️ I am going",
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Colors.white),
                      ),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppTheme.primaryPink,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      ),
                    ),
            ),
        ],
      ),
    );
  }

  // Interactive Voice Notes Popup Modal
  void _showVoiceNotesModal(BuildContext context, EmergencyAlert alert) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => VoiceNotesPlayerSheet(alert: alert),
    );
  }
}

// Dedicated Interactive Audio Player Sheet for Voice Notes
class VoiceNotesPlayerSheet extends StatefulWidget {
  final EmergencyAlert alert;
  const VoiceNotesPlayerSheet({super.key, required this.alert});

  @override
  State<VoiceNotesPlayerSheet> createState() => _VoiceNotesPlayerSheetState();
}

class _VoiceNotesPlayerSheetState extends State<VoiceNotesPlayerSheet> {
  int? _playingIndex;
  double _playbackProgress = 0.0;
  Timer? _progressTimer;
  StreamSubscription? _playerCompleteSubscription;
  final AudioPlaybackService _audioService = AudioPlaybackService();
  final LocalizationService _loc = LocalizationService();

  @override
  void initState() {
    super.initState();
    _playerCompleteSubscription = _audioService.onPlayerComplete.listen((_) {
      if (mounted) {
        _progressTimer?.cancel();
        setState(() {
          _playingIndex = null;
          _playbackProgress = 0.0;
        });
      }
    });
  }

  @override
  void dispose() {
    _playerCompleteSubscription?.cancel();
    _progressTimer?.cancel();
    _audioService.stop();
    super.dispose();
  }

  Future<void> _togglePlay(int index) async {
    if (_playingIndex == index) {
      // Stop / Pause current playing
      _progressTimer?.cancel();
      await _audioService.stop();
      if (mounted) {
        setState(() {
          _playingIndex = null;
          _playbackProgress = 0.0;
        });
      }
    } else {
      // Start playing selected voice note
      _progressTimer?.cancel();
      await _audioService.stop();

      final vn = widget.alert.voiceNotes[index];
      int durationSec = 3;
      if (vn.duration.contains(':')) {
        durationSec = int.tryParse(vn.duration.split(':').last) ?? 3;
      }
      if (durationSec < 1) durationSec = 3;

      setState(() {
        _playingIndex = index;
        _playbackProgress = 0.0;
      });

      // Play voice note audibly through speakers
      await _audioService.playVoiceNote(
        voiceId: vn.id,
        audioUrl: vn.audioUrl,
        durationSeconds: durationSec,
      );

      // Track smooth progress bar synchronization
      int totalMs = durationSec * 1000;
      int elapsedMs = 0;
      const int intervalMs = 100;
      _progressTimer = Timer.periodic(const Duration(milliseconds: intervalMs), (timer) {
        if (!mounted) {
          timer.cancel();
          return;
        }
        elapsedMs += intervalMs;
        setState(() {
          _playbackProgress = (elapsedMs / totalMs).clamp(0.0, 1.0);
          if (elapsedMs >= totalMs) {
            _playingIndex = null;
            _playbackProgress = 0.0;
            timer.cancel();
          }
        });
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDarkMode = Theme.of(context).brightness == Brightness.dark;

    return ValueListenableBuilder<String>(
      valueListenable: _loc.currentLocale,
      builder: (context, currentLang, child) {
        return Container(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: AppTheme.primaryPink.withValues(alpha: 0.15),
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.mic, color: AppTheme.primaryPink, size: 22),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _loc.isAmharic
                              ? "የ '${widget.alert.userName}' የድምፅ መልእክቶች"
                              : "Voice Notes of '${widget.alert.userName}'",
                          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          _loc.isAmharic
                              ? "${widget.alert.voiceNotes.length} የአደጋ ጊዜ የድምፅ ቅጂዎች"
                              : "${widget.alert.voiceNotes.length} emergency voice recording(s)",
                          style: const TextStyle(fontSize: 12, color: Colors.grey),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              ...List.generate(widget.alert.voiceNotes.length, (index) {
                final vn = widget.alert.voiceNotes[index];
                bool isPlaying = (_playingIndex == index);

                return Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: isPlaying ? AppTheme.primaryPink.withValues(alpha: 0.15) : (isDarkMode ? AppTheme.darkCard : Colors.grey.shade100),
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(
                      color: isPlaying ? AppTheme.primaryPink : (isDarkMode ? AppTheme.darkCardBorder : Colors.grey.shade300),
                      width: isPlaying ? 1.5 : 1.0,
                    ),
                  ),
                  child: Column(
                    children: [
                      Row(
                        children: [
                          GestureDetector(
                            onTap: () => _togglePlay(index),
                            child: CircleAvatar(
                              radius: 22,
                              backgroundColor: AppTheme.primaryPink,
                              child: Icon(
                                isPlaying ? Icons.stop_rounded : Icons.play_arrow_rounded,
                                color: Colors.white,
                                size: 26,
                              ),
                            ),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  _loc.isAmharic ? "የድምፅ መልእክት ${index + 1}" : "Voice Note ${index + 1}",
                                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  isPlaying
                                      ? (_loc.isAmharic ? "የአደጋ ድምፅ እየተጫወተ ነው..." : "Playing emergency audio...")
                                      : "${_loc.isAmharic ? 'የቆይታ ጊዜ' : 'Duration'}: ${vn.duration}",
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: isPlaying ? AppTheme.primaryPink : Colors.grey,
                                    fontWeight: isPlaying ? FontWeight.bold : FontWeight.normal,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          Icon(
                            isPlaying ? Icons.volume_up_rounded : Icons.volume_down_rounded,
                            color: isPlaying ? AppTheme.primaryPink : Colors.grey,
                            size: 24,
                          ),
                        ],
                      ),
                      if (isPlaying) ...[
                        const SizedBox(height: 10),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: LinearProgressIndicator(
                            value: _playbackProgress,
                            backgroundColor: AppTheme.primaryPink.withValues(alpha: 0.2),
                            valueColor: const AlwaysStoppedAnimation<Color>(AppTheme.primaryPink),
                            minHeight: 6,
                          ),
                        ),
                      ],
                    ],
                  ),
                );
              }),
            ],
          ),
        );
      },
    );
  }
}
