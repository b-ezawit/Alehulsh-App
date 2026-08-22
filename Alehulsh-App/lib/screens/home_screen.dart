import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../main.dart';
import '../services/localization_service.dart';

class HomeScreen extends StatelessWidget {
  final VoidCallback onGoToEmergency;
  final VoidCallback onGoToWomenNetwork;
  final VoidCallback? onGoToProfile;

  const HomeScreen({
    super.key,
    required this.onGoToEmergency,
    required this.onGoToWomenNetwork,
    this.onGoToProfile,
  });

  @override
  Widget build(BuildContext context) {
    final loc = LocalizationService();

    return ValueListenableBuilder<String>(
      valueListenable: loc.currentLocale,
      builder: (context, currentLang, child) {
        final isDarkMode = Theme.of(context).brightness == Brightness.dark;
        final cardColor = Theme.of(context).cardTheme.color ?? (isDarkMode ? AppTheme.darkCard : AppTheme.lightCard);
        final textMain = isDarkMode ? AppTheme.darkTextMain : AppTheme.lightTextMain;
        final textSub = isDarkMode ? const Color(0xFFD8B4FE) : AppTheme.lightTextMuted;

        return Scaffold(
          appBar: AppBar(
            backgroundColor: Theme.of(context).scaffoldBackgroundColor,
            elevation: 0,
            title: Row(
              children: [
                // Custom App Logo from Women Solidarity Artwork
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    color: AppTheme.primaryPink.withValues(alpha: 0.15),
                    shape: BoxShape.circle,
                    border: Border.all(color: AppTheme.primaryPink.withValues(alpha: 0.4)),
                  ),
                  child: ClipOval(
                    child: Image.asset(
                      'assets/images/app_logo.png',
                      fit: BoxFit.cover,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        loc.tr('app_title'),
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18, color: textMain),
                        overflow: TextOverflow.ellipsis,
                      ),
                      Text(
                        loc.isAmharic ? "እኔ ለአንቺ አለሁልሽ" : "I am here for you",
                        style: TextStyle(color: textSub, fontSize: 11),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            actions: [
              // Language Switcher Toggle (Amharic / English)
              ActionChip(
                backgroundColor: AppTheme.primaryPink.withValues(alpha: 0.15),
                side: BorderSide(color: AppTheme.primaryPink.withValues(alpha: 0.5)),
                label: Text(
                  loc.tr('lang_btn'),
                  style: const TextStyle(
                    color: AppTheme.primaryPink,
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                avatar: const Icon(Icons.language_rounded, size: 16, color: AppTheme.primaryPink),
                onPressed: () {
                  loc.toggleLanguage();
                },
              ),
              const SizedBox(width: 6),
              IconButton(
                tooltip: "Toggle Light/Dark Theme",
                icon: Icon(
                  isDarkMode ? Icons.light_mode_rounded : Icons.dark_mode_rounded,
                  color: AppTheme.primaryPink,
                ),
                onPressed: () {
                  themeModeNotifier.value = isDarkMode ? ThemeMode.light : ThemeMode.dark;
                },
              ),
              if (onGoToProfile != null)
                IconButton(
                  tooltip: "User Profile & Tracking",
                  icon: const Icon(Icons.account_circle_rounded, color: AppTheme.primaryPink, size: 28),
                  onPressed: onGoToProfile,
                ),
              const SizedBox(width: 6),
            ],
          ),
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Pinkish Protection Banner with Brand Logo Artwork
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: isDarkMode
                          ? [AppTheme.darkCard, const Color(0xFF381534)]
                          : [AppTheme.pinkAccentBg, Colors.white],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(color: AppTheme.primaryPink.withValues(alpha: 0.3)),
                    boxShadow: [
                      BoxShadow(
                        color: AppTheme.primaryPink.withValues(alpha: isDarkMode ? 0.2 : 0.1),
                        blurRadius: 20,
                        spreadRadius: 2,
                      ),
                    ],
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                              decoration: BoxDecoration(
                                color: AppTheme.primaryPink.withValues(alpha: 0.15),
                                borderRadius: BorderRadius.circular(20),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(Icons.check_circle_rounded, color: AppTheme.primaryPink, size: 14),
                                  const SizedBox(width: 4),
                                  Text(
                                    loc.isAmharic ? "የቀጥታ ጥበቃ ንቁ ነው" : "ACTIVE SAFETY SHIELD",
                                    style: const TextStyle(color: AppTheme.primaryPink, fontSize: 10, fontWeight: FontWeight.bold),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 10),
                            Text(
                              loc.isAmharic
                                  ? "በሄዱበት ቦታ ሁሉ\nደህንነትዎ የተጠበቀ ነው።"
                                  : "Keeping You Safe,\nWherever You Go.",
                              style: TextStyle(
                                color: textMain,
                                fontSize: 19,
                                fontWeight: FontWeight.bold,
                                height: 1.2,
                              ),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              loc.tr('home_standby'),
                              style: TextStyle(color: textSub, fontSize: 12),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(22),
                        child: Container(
                          width: 125,
                          height: 155,
                          padding: const EdgeInsets.all(3),
                          decoration: BoxDecoration(
                            color: AppTheme.primaryPink.withValues(alpha: 0.14),
                            borderRadius: BorderRadius.circular(22),
                            border: Border.all(
                              color: AppTheme.primaryPink.withValues(alpha: 0.3),
                              width: 1.5,
                            ),
                          ),
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(19),
                            child: Image.asset(
                              'assets/images/women_community.png',
                              fit: BoxFit.cover,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 16),

                // Hardware & Motion SOS Feature Status Card
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: isDarkMode ? const Color(0xFF200F2B) : const Color(0xFFFFF1F2),
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(
                      color: AppTheme.emergencyRed.withValues(alpha: 0.4),
                      width: 1.5,
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: AppTheme.emergencyRed.withValues(alpha: 0.1),
                        blurRadius: 10,
                        spreadRadius: 1,
                      ),
                    ],
                  ),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: AppTheme.emergencyRed.withValues(alpha: 0.15),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.vibration_rounded, color: AppTheme.emergencyRed, size: 26),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              loc.isAmharic ? "የስልክ ድንገተኛ SOS ጥበቃ (Shake 3x)" : "3x Phone Shake SOS Active",
                              style: const TextStyle(
                                fontWeight: FontWeight.bold,
                                fontSize: 14,
                                color: AppTheme.emergencyRed,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              loc.isAmharic
                                  ? "ስልክዎን ለ 3 ሰከንድ 3 ጊዜ በማነቅነቅ (Shake 3x) የቀጥታ GPS የአደጋ ጊዜ ጥሪ ወዲያውኑ ማሰራጨት ይችላሉ"
                                  : "Shake your phone 3 times continuously for 3 seconds to automatically broadcast live GPS emergency SOS",
                              style: TextStyle(
                                fontSize: 12,
                                height: 1.35,
                                color: isDarkMode ? Colors.white70 : Colors.black87,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 20),

                Text(
                  loc.isAmharic ? "ፈጣን እርምጃዎች" : "Quick Actions",
                  style: TextStyle(color: textMain, fontSize: 18, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 14),

                // Emergency SOS Panic Launcher Card
                GestureDetector(
                  onTap: onGoToEmergency,
                  child: Container(
                    padding: const EdgeInsets.all(18),
                    decoration: BoxDecoration(
                      color: cardColor,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: AppTheme.emergencyRed.withValues(alpha: 0.4), width: 1.5),
                      boxShadow: [
                        BoxShadow(
                          color: AppTheme.emergencyRed.withValues(alpha: 0.12),
                          blurRadius: 15,
                          spreadRadius: 2,
                        ),
                      ],
                    ),
                    child: Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                            color: AppTheme.emergencyRed.withValues(alpha: 0.15),
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(Icons.warning_rounded, color: AppTheme.emergencyRed, size: 30),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                loc.tr('home_emergency_btn'),
                                style: TextStyle(color: textMain, fontSize: 16, fontWeight: FontWeight.bold),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                loc.isAmharic
                                    ? "የቀጥታ GPS እና የድምፅ መልእክት ወዲያውኑ ይላኩ"
                                    : "Instantly broadcast GPS & voice context to contacts & community",
                                style: TextStyle(color: textSub, fontSize: 12),
                              ),
                            ],
                          ),
                        ),
                        const Icon(Icons.arrow_forward_ios_rounded, color: AppTheme.emergencyRed, size: 18),
                      ],
                    ),
                  ),
                ),

                const SizedBox(height: 16),

                // Alerts Network Launcher Card
                GestureDetector(
                  onTap: onGoToWomenNetwork,
                  child: Container(
                    padding: const EdgeInsets.all(18),
                    decoration: BoxDecoration(
                      color: cardColor,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: AppTheme.primaryPink.withValues(alpha: 0.4), width: 1.5),
                      boxShadow: [
                        BoxShadow(
                          color: AppTheme.primaryPink.withValues(alpha: 0.12),
                          blurRadius: 15,
                          spreadRadius: 2,
                        ),
                      ],
                    ),
                    child: Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                            color: AppTheme.primaryPink.withValues(alpha: 0.15),
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(Icons.notifications_active_rounded, color: AppTheme.primaryPink, size: 30),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                loc.tr('home_network_btn'),
                                style: TextStyle(color: textMain, fontSize: 16, fontWeight: FontWeight.bold),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                loc.isAmharic
                                    ? "በአቅራቢያ ያሉ የሴቶች አደጋዎችን ይመልከቱ ወይም እርዳታ ይስጡ"
                                    : "View active community alerts nearby or offer immediate support",
                                style: TextStyle(color: textSub, fontSize: 12),
                              ),
                            ],
                          ),
                        ),
                        const Icon(Icons.arrow_forward_ios_rounded, color: AppTheme.primaryPink, size: 18),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
