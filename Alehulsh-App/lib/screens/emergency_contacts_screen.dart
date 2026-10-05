import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../models/alert_model.dart';
import '../models/user_profile_model.dart';
import '../services/alert_service.dart';
import '../services/user_data_service.dart';
import '../services/location_service.dart';

class EmergencyContactsScreen extends StatelessWidget {
  const EmergencyContactsScreen({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final isDarkMode = Theme.of(context).brightness == Brightness.dark;
    final UserDataService userDataService = UserDataService();
    final AlertService alertService = AlertService();
    final LocationService locationService = LocationService();

    return ValueListenableBuilder<UserProfile>(
      valueListenable: userDataService.profileNotifier,
      builder: (context, profile, child) {
        final myEmail = profile.email.trim().toLowerCase();

        return Scaffold(
          appBar: AppBar(
            backgroundColor: Theme.of(context).scaffoldBackgroundColor,
            elevation: 0,
            title: const Row(
              children: [
                Icon(Icons.contact_phone_rounded, color: AppTheme.primaryPink),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    "Emergency Contacts Alert Hub",
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              // Header Card
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: isDarkMode
                        ? [AppTheme.darkCard, const Color(0xFF2D1426)]
                        : [AppTheme.pinkAccentBg, Colors.white],
                  ),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: AppTheme.primaryPink.withValues(alpha: 0.3)),
                ),
                child: Column(
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
                          child: const Icon(Icons.notifications_active_rounded, color: AppTheme.primaryPink, size: 22),
                        ),
                        const SizedBox(width: 12),
                        const Expanded(
                          child: Text(
                            "Emergency Contacts Radar",
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      "Real-time alerts sent by family & friends who listed your registered email address ($myEmail) as their emergency contact.",
                      style: TextStyle(
                        fontSize: 12,
                        color: isDarkMode ? const Color(0xFFD8B4FE) : AppTheme.lightTextMuted,
                      ),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 20),

              // Stream of alerts routed to current user as emergency contact
              StreamBuilder<List<EmergencyAlert>>(
                stream: alertService.alertsStream,
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    return const Padding(
                      padding: EdgeInsets.all(32.0),
                      child: Center(child: CircularProgressIndicator(color: AppTheme.primaryPink)),
                    );
                  }

                  final allAlerts = snapshot.data ?? [];

                  // Filter alerts where current user's email is in emergencyContactEmails list
                  final contactAlerts = allAlerts.where((alert) {
                    return alert.emergencyContactEmails.contains(myEmail) && alert.status == 'active';
                  }).toList();

                  if (contactAlerts.isEmpty) {
                    return Container(
                      padding: const EdgeInsets.all(24),
                      decoration: BoxDecoration(
                        color: isDarkMode ? AppTheme.darkCard : Colors.white,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder),
                      ),
                      child: Column(
                        children: [
                          Icon(Icons.shield_outlined, color: AppTheme.primaryPink.withValues(alpha: 0.6), size: 48),
                          const SizedBox(height: 12),
                          const Text(
                            "No Emergency Contact Alerts Active",
                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 6),
                          Text(
                            "When anyone who listed your email ($myEmail) triggers an SOS alert, their card will appear here instantly regardless of distance.",
                            textAlign: TextAlign.center,
                            style: TextStyle(fontSize: 12, color: isDarkMode ? Colors.white60 : Colors.black54),
                          ),
                        ],
                      ),
                    );
                  }

                  return Column(
                    children: contactAlerts.map((alert) {
                      return Container(
                        margin: const EdgeInsets.only(bottom: 16),
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: isDarkMode ? AppTheme.darkCard : Colors.white,
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(color: AppTheme.emergencyRed, width: 1.5),
                          boxShadow: [
                            BoxShadow(
                              color: AppTheme.emergencyRed.withValues(alpha: 0.12),
                              blurRadius: 15,
                              offset: const Offset(0, 4),
                            ),
                          ],
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                CircleAvatar(
                                  backgroundColor: AppTheme.emergencyRed,
                                  child: Text(
                                    alert.userAvatar,
                                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        "EMERGENCY: ${alert.userName}",
                                        style: const TextStyle(
                                          fontSize: 15,
                                          fontWeight: FontWeight.bold,
                                          color: AppTheme.emergencyRed,
                                        ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        alert.locationName,
                                        style: TextStyle(fontSize: 12, color: isDarkMode ? Colors.white70 : Colors.black87),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),

                            if (alert.message.trim().isNotEmpty) ...[
                              const SizedBox(height: 10),
                              Container(
                                width: double.infinity,
                                padding: const EdgeInsets.all(10),
                                decoration: BoxDecoration(
                                  color: isDarkMode ? Colors.white.withValues(alpha: 0.05) : Colors.grey.shade100,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Text(
                                  "\"${alert.message.trim()}\"",
                                  style: TextStyle(
                                    fontStyle: FontStyle.italic,
                                    fontSize: 13,
                                    color: isDarkMode ? Colors.white.withValues(alpha: 0.9) : Colors.black87,
                                  ),
                                ),
                              ),
                            ],

                            const SizedBox(height: 12),

                            // Action: View Location on Google Maps
                            SizedBox(
                              width: double.infinity,
                              child: ElevatedButton.icon(
                                // Disabled when the alert carries no location.
                                // Opening a map at a placeholder coordinate
                                // would send her to the wrong address while
                                // looking authoritative.
                                onPressed: alert.hasLocation
                                    ? () => locationService.openGoogleMaps(alert.latitude!, alert.longitude!)
                                    : null,
                                icon: Icon(
                                  alert.hasLocation ? Icons.navigation_rounded : Icons.location_off_rounded,
                                  color: Colors.white,
                                  size: 18,
                                ),
                                label: Text(
                                  alert.hasLocation
                                      ? "View Location on Google Maps"
                                      : "Location unavailable - call her",
                                  style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
                                ),
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: AppTheme.emergencyRed,
                                  padding: const EdgeInsets.symmetric(vertical: 10),
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                ),
                              ),
                            ),
                          ],
                        ),
                      );
                    }).toList(),
                  );
                },
              ),
            ],
          ),
        );
      },
    );
  }
}
