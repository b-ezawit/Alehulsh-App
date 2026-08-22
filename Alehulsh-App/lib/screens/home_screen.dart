import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/app_theme.dart';
import '../main.dart';
import '../services/localization_service.dart';
import '../services/user_data_service.dart';
import 'profile_screen.dart';

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
              // Settings Icon (Contains Profile & Notifications Toggle)
              IconButton(
                tooltip: loc.isAmharic ? "ቅንብሮች እና መገለጫ" : "Settings & Profile",
                icon: const Icon(
                  Icons.settings_rounded,
                  color: AppTheme.primaryPink,
                  size: 26,
                ),
                onPressed: () => _showSettingsSheet(context, loc, isDarkMode),
              ),
              const SizedBox(width: 8),
            ],
          ),
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Clean Full-Width Protection Banner
                Container(
                  padding: const EdgeInsets.all(22),
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
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                            decoration: BoxDecoration(
                              color: AppTheme.primaryPink.withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(20),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Icon(Icons.shield_rounded, color: AppTheme.primaryPink, size: 16),
                                const SizedBox(width: 6),
                                Text(
                                  loc.isAmharic ? "የቀጥታ ጥበቃ ንቁ ነው" : "ACTIVE SAFETY SHIELD",
                                  style: const TextStyle(color: AppTheme.primaryPink, fontSize: 11, fontWeight: FontWeight.bold),
                                ),
                              ],
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                            decoration: BoxDecoration(
                              color: Colors.green.withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(14),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Container(
                                  width: 7,
                                  height: 7,
                                  decoration: const BoxDecoration(
                                    color: Colors.green,
                                    shape: BoxShape.circle,
                                  ),
                                ),
                                const SizedBox(width: 5),
                                Text(
                                  loc.isAmharic ? "GPS መስመር ላይ" : "GPS Online",
                                  style: const TextStyle(color: Colors.green, fontSize: 10, fontWeight: FontWeight.bold),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      Text(
                        loc.isAmharic
                            ? "በሄዱበት ቦታ ሁሉ\nደህንነትዎ የተጠበቀ ነው።"
                            : "Keeping You Safe,\nWherever You Go.",
                        style: TextStyle(
                          color: textMain,
                          fontSize: 22,
                          fontWeight: FontWeight.bold,
                          height: 1.25,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        loc.tr('home_standby'),
                        style: TextStyle(color: textSub, fontSize: 13, height: 1.35),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 16),

                // Hardware SOS Feature Status Card (5x Power Button)
                GestureDetector(
                  onTap: () async {
                    try {
                      final platform = MethodChannel('com.example.alehulsh_app/hardware_sos');
                      final isEnabled = await platform.invokeMethod<bool>('isAccessibilityEnabled') ?? false;
                      if (!isEnabled && context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text(
                              loc.isAmharic
                                  ? "ለ 5x ፓወር ቁልፍ የ Accessibility ፈቃድ ይክፈቱ"
                                  : "Enable Accessibility Service for 5x Power Button SOS",
                            ),
                            action: SnackBarAction(
                              label: loc.isAmharic ? "ክፈት" : "Enable",
                              onPressed: () {
                                platform.invokeMethod('openAccessibilitySettings');
                              },
                            ),
                          ),
                        );
                      }
                    } catch (_) {}
                  },
                  child: Container(
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
                          child: const Icon(Icons.power_settings_new_rounded, color: AppTheme.emergencyRed, size: 26),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                loc.isAmharic ? "የ 5x ፓወር ቁልፍ ድንገተኛ SOS" : "5x Physical Power Button SOS",
                                style: const TextStyle(
                                  fontWeight: FontWeight.bold,
                                  fontSize: 14,
                                  color: AppTheme.emergencyRed,
                                ),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                loc.isAmharic
                                    ? "ስልክዎ ተቆልፎም ቢሆን የፓወር ቁልፉን 5 ጊዜ በፍጥነት በመጫን (5x Power Button) ወይም የ SOS ቁልፍ በመንካት የቀጥታ GPS የአደጋ ጥሪ ወዲያውኑ ይላካል"
                                    : "Press physical power button 5 times quickly (even when screen is closed/locked) or tap the SOS button to instantly broadcast live GPS emergency SOS",
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
                ),

                const SizedBox(height: 20),

                Text(
                  loc.isAmharic ? "ፈጣን እርምጃዎች" : "Quick Actions",
                  style: TextStyle(color: textMain, fontSize: 18, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 14),

                // Emergency Trigger Card
                Card(
                  elevation: 4,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(20),
                    side: BorderSide(
                      color: AppTheme.emergencyRed.withValues(alpha: 0.3),
                      width: 1.5,
                    ),
                  ),
                  color: isDarkMode ? const Color(0xFF28111D) : const Color(0xFFFFF0F2),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(20),
                    onTap: onGoToEmergency,
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: AppTheme.emergencyRed.withValues(alpha: 0.15),
                              shape: BoxShape.circle,
                            ),
                            child: const Icon(Icons.warning_amber_rounded, color: AppTheme.emergencyRed, size: 32),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  loc.tr('home_sos_btn'),
                                  style: const TextStyle(
                                    color: AppTheme.emergencyRed,
                                    fontSize: 18,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  loc.isAmharic
                                      ? "የቀጥታ የጂፒኤስ አደጋ ጥሪ ይላኩ እና የድምጽ ማስታወሻ ይመዝግቡ"
                                      : "Broadcast live GPS emergency alert & record audio note",
                                  style: TextStyle(
                                    color: isDarkMode ? const Color(0xFFFFB3BA) : const Color(0xFFC2185B),
                                    fontSize: 12,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const Icon(Icons.arrow_forward_ios_rounded, color: AppTheme.emergencyRed, size: 18),
                        ],
                      ),
                    ),
                  ),
                ),

                const SizedBox(height: 12),

                // Network & Alerts Card
                Card(
                  elevation: 2,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(20),
                    side: BorderSide(
                      color: isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder,
                      width: 1.5,
                    ),
                  ),
                  color: cardColor,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(20),
                    onTap: onGoToWomenNetwork,
                    child: Padding(
                      padding: const EdgeInsets.all(20),
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
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  void _showSettingsSheet(BuildContext context, LocalizationService loc, bool isDarkMode) {
    final bgColor = isDarkMode ? const Color(0xFF1E1026) : Colors.white;
    final cardBg = isDarkMode ? const Color(0xFF2B1637) : const Color(0xFFFFF0F5);
    final textMain = isDarkMode ? AppTheme.darkTextMain : AppTheme.lightTextMain;
    final textSub = isDarkMode ? const Color(0xFFD8B4FE) : AppTheme.lightTextMuted;
    final profile = UserDataService().currentProfile;

    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (ctx) {
        return Container(
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
            border: Border.all(
              color: isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder,
              width: 1.5,
            ),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
          child: SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Top drag handle
                Center(
                  child: Container(
                    width: 44,
                    height: 5,
                    decoration: BoxDecoration(
                      color: AppTheme.primaryPink.withValues(alpha: 0.3),
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                ),
                const SizedBox(height: 20),

                // Header
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AppTheme.primaryPink.withValues(alpha: 0.15),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(Icons.settings_rounded, color: AppTheme.primaryPink, size: 24),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            loc.isAmharic ? "ቅንብሮች" : "Settings",
                            style: TextStyle(
                              color: textMain,
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          Text(
                            loc.isAmharic ? "የመገለጫ እና የማሳወቂያ ምርጫዎች" : "Profile & notification preferences",
                            style: TextStyle(
                              color: textSub,
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      icon: Icon(Icons.close_rounded, color: textSub),
                      onPressed: () => Navigator.pop(ctx),
                    ),
                  ],
                ),
                const SizedBox(height: 20),

                // 1. User Profile Access Card (Dedicated Profile Entry Point)
                Material(
                  color: cardBg,
                  borderRadius: BorderRadius.circular(20),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(20),
                    onTap: () {
                      Navigator.pop(ctx);
                      Navigator.push(
                        context,
                        MaterialPageRoute(builder: (_) => const ProfileScreen()),
                      );
                    },
                    child: Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(
                          color: AppTheme.primaryPink.withValues(alpha: 0.35),
                          width: 1.5,
                        ),
                      ),
                      child: Row(
                        children: [
                          Container(
                            width: 48,
                            height: 48,
                            decoration: BoxDecoration(
                              color: AppTheme.primaryPink.withValues(alpha: 0.2),
                              shape: BoxShape.circle,
                              border: Border.all(color: AppTheme.primaryPink, width: 1.5),
                            ),
                            child: Center(
                              child: Text(
                                profile.fullName.trim().isNotEmpty
                                    ? profile.fullName.trim().substring(0, 1).toUpperCase()
                                    : 'A',
                                style: const TextStyle(
                                  color: AppTheme.primaryPink,
                                  fontSize: 20,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  profile.fullName.isNotEmpty ? profile.fullName : "Alehulsh User",
                                  style: TextStyle(
                                    color: textMain,
                                    fontSize: 16,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  loc.isAmharic ? "መገለጫዎን ይመልከቱ እና ያርትዑ" : "View & edit profile settings",
                                  style: TextStyle(
                                    color: textSub,
                                    fontSize: 12,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const Icon(Icons.arrow_forward_ios_rounded, color: AppTheme.primaryPink, size: 16),
                        ],
                      ),
                    ),
                  ),
                ),

                const SizedBox(height: 16),

                // 2. Notification Toggle Card
                ValueListenableBuilder<bool>(
                  valueListenable: UserDataService().notificationsEnabledNotifier,
                  builder: (context, notifsEnabled, _) {
                    return Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: cardBg,
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(
                          color: notifsEnabled
                              ? AppTheme.primaryPink.withValues(alpha: 0.4)
                              : Colors.grey.withValues(alpha: 0.2),
                          width: 1.5,
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Container(
                                padding: const EdgeInsets.all(10),
                                decoration: BoxDecoration(
                                  color: notifsEnabled
                                      ? AppTheme.primaryPink.withValues(alpha: 0.2)
                                      : Colors.grey.withValues(alpha: 0.15),
                                  shape: BoxShape.circle,
                                ),
                                child: Icon(
                                  notifsEnabled ? Icons.notifications_active_rounded : Icons.notifications_off_rounded,
                                  color: notifsEnabled ? AppTheme.primaryPink : Colors.grey,
                                  size: 24,
                                ),
                              ),
                              const SizedBox(width: 14),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      loc.isAmharic ? "የአደጋ ጊዜ ማሳወቂያዎች" : "Emergency Notifications",
                                      style: TextStyle(
                                        color: textMain,
                                        fontSize: 15,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      notifsEnabled
                                          ? (loc.isAmharic ? "ማሳወቂያዎች በርተዋል" : "Notifications Enabled")
                                          : (loc.isAmharic ? "ማሳወቂያዎች ጠፍተዋል" : "Notifications Disabled"),
                                      style: TextStyle(
                                        color: notifsEnabled ? AppTheme.primaryPink : Colors.grey,
                                        fontSize: 12,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              Switch(
                                value: notifsEnabled,
                                activeColor: AppTheme.primaryPink,
                                onChanged: (value) async {
                                  await UserDataService().setNotificationsEnabled(value);
                                },
                              ),
                            ],
                          ),
                          const SizedBox(height: 10),
                          Divider(color: AppTheme.primaryPink.withValues(alpha: 0.1)),
                          const SizedBox(height: 6),
                          Text(
                            loc.isAmharic
                                ? "ይህ ምርጫ ሲበራ በአቅራቢያዎ ያሉ ሴቶች እርዳታ ሲጠይቁ ወይም የአደጋ ጥሪ ሲያደርጉ ፈጣን ማሳወቂያ ይደርስዎታል። ይህ ሲጠፋ ምንም አይነት ማሳወቂያ አይደርስዎትም።"
                                : "When enabled, you will receive real-time proximity alerts and emergency distress pings when women nearby need help. When disabled, no notifications will be delivered.",
                            style: TextStyle(
                              color: textSub,
                              fontSize: 12,
                              height: 1.4,
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
                const SizedBox(height: 20),

                // Close / Done Button
                ElevatedButton(
                  onPressed: () => Navigator.pop(ctx),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryPink,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                  child: Text(
                    loc.isAmharic ? "ተከናውኗል" : "Done",
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                  ),
                ),
                const SizedBox(height: 10),
              ],
            ),
          ),
        );
      },
    );
  }
}
