import 'package:flutter/material.dart';
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

class _MainNavigationScreenState extends State<MainNavigationScreen> {
  // Requirement: When the App is opened, open the Emergency page first as mandatory (Index 0)
  int _currentIndex = 0;

  @override
  void initState() {
    super.initState();
    // Prompt location immediately upon entering the app
    WidgetsBinding.instance.addPostFrameCallback((_) {
      LocationService().checkAndRequestLocation(context: context);
    });

    // Listen for notification taps to automatically navigate to the Alerts screen
    EmergencyPingService.targetNavigationTab.addListener(_onTargetTabChanged);
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
