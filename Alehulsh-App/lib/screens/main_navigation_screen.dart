import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/app_theme.dart';
import '../services/location_service.dart';
import '../services/localization_service.dart';
import '../services/emergency_ping_service.dart';
import 'emergency_screen.dart';
import 'home_screen.dart';
import 'women_for_women_screen.dart';
import 'profile_screen.dart';

class MainNavigationScreen extends StatefulWidget {
  const MainNavigationScreen({super.key});

  @override
  State<MainNavigationScreen> createState() => _MainNavigationScreenState();
}

class _MainNavigationScreenState extends State<MainNavigationScreen> with WidgetsBindingObserver {
  // Requirement: When the App is opened, open the Emergency page first as mandatory (Index 0)
  int _currentIndex = 0;

  static const MethodChannel _platformChannel =
      MethodChannel('com.example.alehulsh_app/hardware_sos');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      // Prompt location immediately upon entering the app
      LocationService().checkAndRequestLocation(context: context);
      // Check accessibility service is enabled; prompt if not
      await _checkAccessibilityService();
    });

    // Listen for notification taps to automatically navigate to the Alerts screen
    EmergencyPingService.targetNavigationTab.addListener(_onTargetTabChanged);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Re-check when user returns from Settings
    if (state == AppLifecycleState.resumed) {
      _checkAccessibilityService(silent: true);
    }
  }

  Future<void> _checkAccessibilityService({bool silent = false}) async {
    try {
      final isEnabled = await _platformChannel.invokeMethod<bool>('isAccessibilityEnabled') ?? false;
      if (!isEnabled && mounted) {
        _showAccessibilityPrompt();
      }
    } catch (_) {}
  }

  void _showAccessibilityPrompt() {
    if (!mounted) return;
    final loc = LocalizationService();
    final isDarkMode = Theme.of(context).brightness == Brightness.dark;
    final bgColor = isDarkMode ? const Color(0xFF1E1026) : Colors.white;
    final textMain = isDarkMode ? AppTheme.darkTextMain : AppTheme.lightTextMain;
    final textSub = isDarkMode ? const Color(0xFFD8B4FE) : AppTheme.lightTextMuted;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => Dialog(
        backgroundColor: bgColor,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Icon
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: AppTheme.emergencyRed.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.power_settings_new_rounded,
                  color: AppTheme.emergencyRed,
                  size: 38,
                ),
              ),
              const SizedBox(height: 18),
              Text(
                loc.isAmharic ? "የ SOS ፈቃድ ያስፈልጋል" : "Enable SOS Power Button",
                style: TextStyle(
                  color: textMain,
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              Text(
                loc.isAmharic
                    ? "የ 5x ፓወር ቁልፍ SOS ለማስሠራት፣ የ Alehulsh Accessibility Service ማስቻል ያስፈልጋል። ያስቻሉ እና ወደ ኋላ ይምለሱ።"
                    : "To use the 5x Power Button Emergency SOS, you must enable the Alehulsh Accessibility Service.\n\nTap 'Enable Now', find Alehulsh in the list, and turn it ON. Then come back.",
                style: TextStyle(
                  color: textSub,
                  fontSize: 13,
                  height: 1.5,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              // Enable Now button
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: () async {
                    Navigator.pop(ctx);
                    try {
                      await _platformChannel.invokeMethod('openAccessibilitySettings');
                    } catch (_) {}
                  },
                  icon: const Icon(Icons.settings_accessibility_rounded, size: 20, color: Colors.white),
                  label: Text(
                    loc.isAmharic ? "አሁን አስቻሉ" : "Enable Now",
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                    ),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.emergencyRed,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  ),
                ),
              ),
              const SizedBox(height: 10),
              // Skip button
              SizedBox(
                width: double.infinity,
                child: TextButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: Text(
                    loc.isAmharic ? "ለጊዜው ዝለሉ" : "Skip for Now",
                    style: TextStyle(
                      color: textSub,
                      fontSize: 13,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _onTargetTabChanged() {
    final targetTab = EmergencyPingService.targetNavigationTab.value;
    if (mounted && _currentIndex != targetTab) {
      setState(() {
        _currentIndex = targetTab.clamp(0, 2);
      });
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    EmergencyPingService.targetNavigationTab.removeListener(_onTargetTabChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final loc = LocalizationService();
    final isDarkMode = Theme.of(context).brightness == Brightness.dark;

    // Order: 0: Emergency, 1: Alerts (Women for Women), 2: Home
    // Profile is exclusively accessible through Home Page profile icon
    final List<Widget> screens = [
      const EmergencyScreen(),
      const WomenForWomenScreen(),
      HomeScreen(
        onGoToEmergency: () => setState(() => _currentIndex = 0),
        onGoToWomenNetwork: () => setState(() => _currentIndex = 1),
        onGoToProfile: () {
          Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => const ProfileScreen()),
          );
        },
      ),
    ];

    return ValueListenableBuilder<String>(
      valueListenable: loc.currentLocale,
      builder: (context, currentLang, child) {
        return Scaffold(
          body: IndexedStack(
            index: _currentIndex,
            children: screens,
          ),
          bottomNavigationBar: Container(
            decoration: BoxDecoration(
              border: Border(
                top: BorderSide(
                  color: isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder,
                  width: 1,
                ),
              ),
            ),
            child: BottomNavigationBar(
              currentIndex: _currentIndex,
              backgroundColor: isDarkMode ? const Color(0xFF1A1021) : Colors.white,
              selectedItemColor: AppTheme.primaryPink,
              unselectedItemColor: isDarkMode ? const Color(0xFF715978) : const Color(0xFFB48FA3),
              selectedLabelStyle: const TextStyle(fontWeight: FontWeight.bold, fontSize: 11),
              unselectedLabelStyle: const TextStyle(fontSize: 11),
              type: BottomNavigationBarType.fixed,
              onTap: (index) {
                setState(() {
                  _currentIndex = index;
                });
              },
              items: [
                BottomNavigationBarItem(
                  icon: const Icon(Icons.warning_amber_rounded),
                  label: loc.tr('nav_emergency'),
                ),
                BottomNavigationBarItem(
                  icon: const Icon(Icons.notifications_active_rounded),
                  label: loc.tr('nav_network'),
                ),
                BottomNavigationBarItem(
                  icon: const Icon(Icons.home_rounded),
                  label: loc.tr('nav_home'),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
