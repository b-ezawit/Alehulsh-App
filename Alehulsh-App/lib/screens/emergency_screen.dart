import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import '../theme/app_theme.dart';
import '../models/alert_model.dart';
import '../models/user_profile_model.dart';
import '../services/user_data_service.dart';
import '../services/alert_service.dart';
import '../services/location_service.dart';
import '../services/localization_service.dart';
import '../services/audio_recording_service.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'auth_screen.dart';

class EmergencyScreen extends StatefulWidget {
  const EmergencyScreen({Key? key}) : super(key: key);

  @override
  State<EmergencyScreen> createState() => _EmergencyScreenState();
}

class _EmergencyScreenState extends State<EmergencyScreen> with SingleTickerProviderStateMixin {
  final UserDataService _userDataService = UserDataService();
  final AlertService _alertService = AlertService();
  final LocationService _locationService = LocationService();
  final LocalizationService _loc = LocalizationService();

  // Active SOS alert tracking state
  bool _isSOSSent = false;
  String? _activeAlertId;
  bool _isUrgent = false;
  final TextEditingController _messageCtrl = TextEditingController();
  bool _isMessageSent = false;

  // Live Location
  Position? _livePosition;
  bool _isFetchingLocation = false;

  // Telegram-style Voice Recorder State
  bool _isRecordingVoice = false;
  int _recordSeconds = 0;
  Timer? _recordTimer;

  // Animation controller for pulsing SOS button
  late AnimationController _pulseController;
  late Animation<double> _pulseAnimation;

  // Stream subscription for active user alert persistence across navigation
  StreamSubscription<EmergencyAlert?>? _userAlertSubscription;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat(reverse: true);

    _pulseAnimation = Tween<double>(begin: 1.0, end: 1.12).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );

    _userDataService.profileNotifier.addListener(_onProfileChanged);
    _initLocationAndAlertStream();
  }

  void _onProfileChanged() {
    _subscribeToUserActiveAlert();
  }

  Future<void> _initLocationAndAlertStream() async {
    // 1. Instantly check persistent local storage for ongoing SOS
    final wasSOSActive = await _userDataService.isSOSActiveLocally();
    final cachedAlertId = await _userDataService.getActiveSOSAlertIdLocally();
    if (wasSOSActive && mounted) {
      setState(() {
        _isSOSSent = true;
        _activeAlertId = cachedAlertId ?? _userDataService.currentProfile.uid;
      });
    }

    // 2. Fetch live GPS coordinates
    _livePosition = _locationService.currentPosition;
    setState(() => _isFetchingLocation = _livePosition == null);
    Position? pos = await _locationService.getCurrentLocation();
    if (mounted) {
      setState(() {
        _livePosition = pos ?? _locationService.currentPosition;
        _isFetchingLocation = false;
      });
    }

    // 3. Listen to live user active alert in Firestore
    _subscribeToUserActiveAlert();
  }

  void _subscribeToUserActiveAlert() async {
    _userAlertSubscription?.cancel();
    final cachedAlertId = await _userDataService.getActiveSOSAlertIdLocally();
    final userId = _userDataService.currentProfile.uid.isNotEmpty
        ? _userDataService.currentProfile.uid
        : (cachedAlertId ?? FirebaseAuth.instance.currentUser?.uid ?? '');
    if (userId.isEmpty) return;

    _userAlertSubscription = _alertService.getUserActiveAlertStream(userId).listen((activeAlert) async {
      if (mounted) {
        if (activeAlert != null) {
          setState(() {
            _isSOSSent = true;
            _activeAlertId = activeAlert.id;
            _isUrgent = activeAlert.isUrgent;
            if (activeAlert.message.trim().isNotEmpty) {
              _messageCtrl.text = activeAlert.message.trim();
              _isMessageSent = true;
            }
          });
          await _userDataService.setSOSActiveLocally(true, activeAlert.id);
        } else {
          final isLocallyActive = await _userDataService.isSOSActiveLocally();
          if (!isLocallyActive) {
            setState(() {
              _isSOSSent = false;
              _activeAlertId = null;
              _isUrgent = false;
              _isMessageSent = false;
              _messageCtrl.clear();
            });
          }
        }
      }
    });
  }

  @override
  void dispose() {
    _pulseController.dispose();
    _recordTimer?.cancel();
    _userDataService.profileNotifier.removeListener(_onProfileChanged);
    _userAlertSubscription?.cancel();
    _messageCtrl.dispose();
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

  // Trigger SOS Alert (Instant Tap Response + Haptics)
  Future<void> _triggerSOS() async {
    if (!_userDataService.isLoggedIn) {
      _showLoginRequiredDialog(_loc.isAmharic
          ? "የአደጋ ጊዜ ጥሪ (SOS) ለመላክ በመጀመሪያ መግባት (Login) አለብዎት!"
          : "You must log in to call for help and broadcast emergency SOS!");
      return;
    }

    if (_isSOSSent) return;

    // Immediate tactile feedback
    HapticFeedback.heavyImpact();

    final profile = _userDataService.currentProfile;

    // Use live GPS coordinates or fast cache
    double lat = _livePosition?.latitude ?? _locationService.currentPosition?.latitude ?? 9.0125;
    double lng = _livePosition?.longitude ?? _locationService.currentPosition?.longitude ?? 38.7636;

    // Instant local state update for zero lag
    setState(() {
      _isSOSSent = true;
      _activeAlertId = profile.uid;
    });

    try {
      // Check network connectivity for offline queueing status
      bool isOnline = true;
      try {
        final res = await InternetAddress.lookup('example.com').timeout(const Duration(milliseconds: 1500));
        isOnline = res.isNotEmpty && res[0].rawAddress.isNotEmpty;
      } catch (_) {
        isOnline = false;
      }

      // Create or reuse single active SOS Alert in Firestore (automatically queued if offline)
      String alertId = await _alertService.createSOSAlert(
        profile: profile,
        latitude: lat,
        longitude: lng,
        locationName: "Live GPS",
        message: _messageCtrl.text,
        isUrgent: _isUrgent,
      );

      // Lock SOS active locally so app reopen maintains emergency state
      await _userDataService.setSOSActiveLocally(true, alertId);

      if (mounted) {
        setState(() {
          _activeAlertId = alertId;
        });
      }

      _userDataService.recordSOSTriggered();

      // Fire system-level "Your Alert has been sent" notification for persistent confirmation
      const AndroidNotificationDetails senderAndroidDetails = AndroidNotificationDetails(
        'emergency_ping_channel',
        'Emergency Proximity Pings',
        channelDescription: 'Emergency trigger confirmation',
        importance: Importance.max,
        priority: Priority.high,
        enableVibration: true,
        playSound: true,
        color: Color(0xFFE91E63),
        fullScreenIntent: true,
        category: AndroidNotificationCategory.alarm,
        visibility: NotificationVisibility.public,
      );
      final FlutterLocalNotificationsPlugin notifPlugin = FlutterLocalNotificationsPlugin();
      await notifPlugin.show(
        71002,
        _loc.isAmharic ? "🚨 ጥሪዎ ተልኳል!" : "🚨 Your Alert has been sent.",
        _loc.isAmharic
            ? "የአደጋ ጊዜ ጥሪ ለአቅራቢያዎ ያሉ ሰዎች እና እውቂያዎች ተልኳል!"
            : "Emergency SOS broadcast sent to nearby network and contacts!",
        const NotificationDetails(android: senderAndroidDetails),
      );

      if (mounted) {
        if (!isOnline) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Row(
                children: [
                  const Icon(Icons.wifi_off_rounded, color: Colors.white),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      _loc.isAmharic
                          ? "⚠️ በአሁኑ ወቅት ኢንተርኔት የለም። የአደጋ ጥሪዎ በስልክዎ ተመዝግቧል፤ ኢንተርኔት እንደተገናኘ ወዲያውኑ ይሰራጫል!"
                          : "⚠️ You are currently offline. SOS alert is queued locally and will broadcast to nearby network the millisecond connection is restored!",
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold),
                    ),
                  ),
                ],
              ),
              backgroundColor: Colors.orange.shade800,
              duration: const Duration(seconds: 6),
            ),
          );
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(_loc.isAmharic
                  ? "🚨 ጥሪዎ ተልኳል! የአደጋ ጊዜ ጥሪ ለአቅራቢያዎ ያሉ ሰዎች ተልኳል!"
                  : "🚨 Your Alert has been sent! SOS broadcast dispatched to nearby network!"),
              backgroundColor: Colors.green,
              duration: const Duration(seconds: 4),
            ),
          );
        }
      }
    } catch (e) {
      debugPrint("[EmergencyScreen] Error in _triggerSOS: $e");
    }
  }

  // Toggle Urgent Status
  void _onToggleUrgent(bool val) {
    setState(() {
      _isUrgent = val;
    });
    if (_activeAlertId != null) {
      _alertService.toggleUrgentStatus(_activeAlertId!, val);
    }
  }

  final AudioRecordingService _audioRecordingService = AudioRecordingService();

  // Telegram-Style Real Voice Note Recording Flow
  Future<void> _startVoiceRecording() async {
    bool started = await _audioRecordingService.startRecording();
    if (!started) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(_loc.isAmharic ? "እባክዎ የማይክሮፎን ፈቃድ ይስጡ!" : "Please grant microphone permission to record voice!"),
            backgroundColor: Colors.redAccent,
          ),
        );
      }
      return;
    }

    setState(() {
      _isRecordingVoice = true;
      _recordSeconds = 0;
    });

    _recordTimer?.cancel();
    _recordTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (mounted) {
        setState(() {
          _recordSeconds++;
        });
      }
    });
  }

  Future<void> _sendVoiceNote() async {
    if (!_isRecordingVoice) return;

    _recordTimer?.cancel();
    int secondsRecorded = _recordSeconds;

    setState(() {
      _isRecordingVoice = false;
      _recordSeconds = 0;
    });

    // Stop real microphone recording and get base64 encoded audio string
    final String? audioBase64 = await _audioRecordingService.stopRecording();

    String durationStr = "0:${secondsRecorded.toString().padLeft(2, '0')}";

    final voiceNote = VoiceNoteItem(
      id: "vn_${DateTime.now().millisecondsSinceEpoch}",
      title: "Emergency Audio Clip",
      duration: durationStr,
      timestamp: DateTime.now(),
      audioUrl: audioBase64 ?? '',
    );

    final targetAlertId = _activeAlertId ?? _userDataService.currentProfile.uid;
    await _alertService.addVoiceNote(targetAlertId, voiceNote);

    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(_loc.isAmharic ? "የድምፅ መልእክት ($durationStr) ከአደጋ ጥሪዎ ጋር ተያይዟል!" : "Voice note ($durationStr) recorded and attached to alert!"),
          backgroundColor: AppTheme.primaryPink,
        ),
      );
    }
  }

  Future<void> _cancelVoiceRecording() async {
    _recordTimer?.cancel();
    await _audioRecordingService.cancelRecording();
    setState(() {
      _isRecordingVoice = false;
      _recordSeconds = 0;
    });
  }

  // Security Verification SOS Cancellation Modal ("What is your cat's name?")
  void _showCancelSOSDialog() {
    final catNameInputCtrl = TextEditingController();
    final profile = _userDataService.currentProfile;
    String errorTxt = '';

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setStateModal) => AlertDialog(
          title: Row(
            children: [
              const Icon(Icons.shield_outlined, color: AppTheme.primaryPink),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _loc.tr('sos_security_dialog_title'),
                  style: const TextStyle(fontSize: 16),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _loc.tr('sos_security_dialog_desc'),
                style: const TextStyle(fontSize: 13),
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppTheme.primaryPink.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.pets, color: AppTheme.primaryPink, size: 18),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _loc.tr('sos_cat_question'),
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: catNameInputCtrl,
                decoration: InputDecoration(
                  labelText: _loc.isAmharic ? "የደህንነት መልስ ያስገቡ" : "Enter security answer",
                  hintText: "e.g. Milo",
                ),
              ),
              if (errorTxt.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(
                  errorTxt,
                  style: const TextStyle(color: Colors.redAccent, fontSize: 12, fontWeight: FontWeight.bold),
                ),
              ],
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: Text(_loc.tr('sos_keep_active'))),
            ElevatedButton(
              onPressed: () async {
                if (_activeAlertId != null) {
                  bool success = await _alertService.cancelSOSAlert(
                    alertId: _activeAlertId!,
                    userCatName: profile.catName,
                    inputCatName: catNameInputCtrl.text,
                  );

                  if (success) {
                    await _userDataService.setSOSActiveLocally(false);
                    Navigator.pop(ctx);
                    setState(() {
                      _isSOSSent = false;
                      _activeAlertId = null;
                      _isUrgent = false;
                      _isMessageSent = false;
                      _messageCtrl.clear();
                    });
                    if (mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(
                          content: Text(_loc.isAmharic ? "የአደጋ ጥሪው ተሰርዟል። ሁኔታው ደህና ተብሏል።" : "SOS Alert safely cancelled. Status set to SAFE."),
                          backgroundColor: Colors.green,
                        ),
                      );
                    }
                  } else {
                    setStateModal(() {
                      errorTxt = _loc.isAmharic ? "የተሳሳተ የደህንነት መልስ። ማረጋገጫው አልተሳካም!" : "Incorrect security code. Verification failed!";
                    });
                  }
                }
              },
              style: ElevatedButton.styleFrom(backgroundColor: Colors.green),
              child: Text(_loc.tr('sos_confirm_cancel'), style: const TextStyle(color: Colors.white)),
            ),
          ],
        ),
      ),
    );
  }

  void _sendEmergencyMessageNote() {
    final text = _messageCtrl.text.trim();
    if (text.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(_loc.isAmharic ? "እባክዎ ማስታወሻ ይጻፉ" : "Please type an emergency note first"),
          backgroundColor: Colors.orange.shade800,
        ),
      );
      return;
    }
    if (_activeAlertId != null) {
      _alertService.updateMessageNote(_activeAlertId!, text);
    }
    setState(() {
      _isMessageSent = true;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(_loc.isAmharic ? "🚨 የአደጋ ጊዜ ማስታወሻዎ ተልኳል!" : "🚨 Emergency note sent and attached to your SOS!"),
        backgroundColor: Colors.green,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final isDarkMode = Theme.of(context).brightness == Brightness.dark;
    final cardColor = isDarkMode ? AppTheme.darkCard : AppTheme.lightCard;

    return ValueListenableBuilder<String>(
      valueListenable: _loc.currentLocale,
      builder: (context, currentLang, child) {
        return ValueListenableBuilder<UserProfile>(
          valueListenable: _userDataService.profileNotifier,
          builder: (context, profile, child) {
            return Scaffold(
              appBar: AppBar(
                backgroundColor: Theme.of(context).scaffoldBackgroundColor,
                elevation: 0,
                title: Row(
                  children: [
                    const Icon(Icons.warning_amber_rounded, color: AppTheme.emergencyRed),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _loc.tr('sos_title'),
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
                actions: [
                  IconButton(
                    icon: const Icon(Icons.my_location_rounded, color: AppTheme.primaryPink),
                    tooltip: "Update Live GPS Location",
                    onPressed: () async {
                      setState(() => _isFetchingLocation = true);
                      Position? pos = await _locationService.getCurrentLocation();
                      setState(() {
                        _livePosition = pos;
                        _isFetchingLocation = false;
                      });
                    },
                  ),
                ],
              ),
              body: SingleChildScrollView(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Live Location & Protection Banner
                    Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: _isSOSSent ? Colors.green.withValues(alpha: 0.15) : AppTheme.emergencyRed.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: _isSOSSent ? Colors.green : AppTheme.emergencyRed),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            _isSOSSent ? Icons.check_circle_rounded : Icons.cell_tower_rounded,
                            color: _isSOSSent ? Colors.green : AppTheme.emergencyRed,
                            size: 28,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  _isSOSSent ? _loc.tr('sos_broadcast_active') : _loc.tr('sos_shield_standby'),
                                  style: TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.bold,
                                    color: _isSOSSent ? Colors.green : AppTheme.emergencyRed,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  _livePosition != null
                                      ? "GPS Live: ${_livePosition!.latitude.toStringAsFixed(4)}, ${_livePosition!.longitude.toStringAsFixed(4)}"
                                      : (_isFetchingLocation ? "Fetching GPS location..." : _loc.tr('sos_ready_desc')),
                                  style: TextStyle(fontSize: 11, color: isDarkMode ? Colors.white70 : Colors.black87),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),

                    const SizedBox(height: 28),

                    // SOS Main Button Area
                    Center(
                      child: Column(
                        children: [
                          if (!_isSOSSent)
                            ScaleTransition(
                              scale: _pulseAnimation,
                              child: GestureDetector(
                                onTap: _triggerSOS,
                                child: Container(
                                  width: 190,
                                  height: 190,
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    gradient: const LinearGradient(
                                      colors: [AppTheme.emergencyRed, Color(0xFFB91C1C)],
                                    ),
                                    boxShadow: [
                                      BoxShadow(
                                        color: AppTheme.emergencyRed.withValues(alpha: 0.5),
                                        blurRadius: 30,
                                        spreadRadius: 8,
                                      ),
                                    ],
                                  ),
                                  child: Column(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      const Icon(Icons.touch_app_rounded, size: 54, color: Colors.white),
                                      const SizedBox(height: 6),
                                      Text(
                                        _loc.tr('sos_tap_btn'),
                                        style: const TextStyle(
                                          color: Colors.white,
                                          fontSize: 20,
                                          fontWeight: FontWeight.bold,
                                          letterSpacing: 1.5,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            )
                          else
                            // GREEN DISABLED "SOS HAS BEEN SENT" BUTTON
                            Container(
                              width: 200,
                              height: 200,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: Colors.green,
                                boxShadow: [
                                  BoxShadow(
                                    color: Colors.green.withValues(alpha: 0.4),
                                    blurRadius: 25,
                                    spreadRadius: 4,
                                  ),
                                ],
                              ),
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  const Icon(Icons.check_circle_rounded, size: 56, color: Colors.white),
                                  const SizedBox(height: 8),
                                  Text(
                                    _loc.tr('sos_sent_btn'),
                                    textAlign: TextAlign.center,
                                    style: const TextStyle(
                                      color: Colors.white,
                                      fontSize: 16,
                                      fontWeight: FontWeight.bold,
                                      letterSpacing: 1,
                                    ),
                                  ),
                                ],
                              ),
                            ),

                          const SizedBox(height: 16),

                          // GUEST NOTICE: IF NOT LOGGED IN, PROMINENTLY TELL THEM TO LOGIN TO CALL FOR HELP
                          if (!_isSOSSent && !_userDataService.isLoggedIn) ...[
                            const SizedBox(height: 16),
                            Container(
                              constraints: const BoxConstraints(maxWidth: 320),
                              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                              decoration: BoxDecoration(
                                color: AppTheme.emergencyRed.withValues(alpha: 0.12),
                                borderRadius: BorderRadius.circular(16),
                                border: Border.all(color: AppTheme.emergencyRed.withValues(alpha: 0.4), width: 1.5),
                              ),
                              child: Column(
                                children: [
                                  Row(
                                    children: [
                                      const Icon(Icons.lock_outline_rounded, color: AppTheme.emergencyRed, size: 22),
                                      const SizedBox(width: 10),
                                      Expanded(
                                        child: Text(
                                          _loc.isAmharic
                                              ? "የአደጋ ጊዜ ጥሪ (SOS) ለመላክ መግባት አለብዎት"
                                              : "You must log in to call for help",
                                          style: const TextStyle(
                                            fontSize: 13,
                                            fontWeight: FontWeight.bold,
                                            color: AppTheme.emergencyRed,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 12),
                                  SizedBox(
                                    width: double.infinity,
                                    child: ElevatedButton.icon(
                                      onPressed: () {
                                        Navigator.push(
                                          context,
                                          MaterialPageRoute(builder: (_) => const AuthScreen()),
                                        );
                                      },
                                      icon: const Icon(Icons.login_rounded, size: 16, color: Colors.white),
                                      label: Text(
                                        _loc.isAmharic ? "ግባ / ተመዝገብ" : "Login / Sign Up",
                                        style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
                                      ),
                                      style: ElevatedButton.styleFrom(
                                        backgroundColor: AppTheme.primaryPink,
                                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                        padding: const EdgeInsets.symmetric(vertical: 10),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],

                          // SMALLER GREEN "CANCEL SOS" BUTTON JUST BELOW
                          if (_isSOSSent)
                            ElevatedButton.icon(
                              onPressed: _showCancelSOSDialog,
                              icon: const Icon(Icons.cancel_rounded, color: Colors.white, size: 18),
                              label: Text(_loc.tr('sos_cancel_btn'), style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.bold)),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: Colors.green.shade700,
                                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                              ),
                            ),
                        ],
                      ),
                    ),

                    // ACTIVE SOS CONTROLS: ONLY VISIBLE WHEN SOS IS ON (_isSOSSent == true)
                    if (_isSOSSent) ...[
                      const SizedBox(height: 24),

                      // 1. Urgent Toggle Switch Card
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: cardColor,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder),
                        ),
                        child: SwitchListTile(
                          contentPadding: EdgeInsets.zero,
                          value: _isUrgent,
                          onChanged: _onToggleUrgent,
                          activeTrackColor: AppTheme.emergencyRed,
                          secondary: Container(
                            padding: const EdgeInsets.all(8),
                            decoration: BoxDecoration(
                              color: AppTheme.emergencyRed.withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Icon(Icons.flash_on_rounded, color: AppTheme.emergencyRed, size: 20),
                          ),
                          title: Text(_loc.tr('sos_urgent_label'), style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                          subtitle: Text(_loc.tr('sos_urgent_sub'), style: const TextStyle(fontSize: 11)),
                        ),
                      ),

                      const SizedBox(height: 16),

                      // 2. TELEGRAM-STYLE VOICE RECORDER CARD (ABOVE MESSAGE NOTE)
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: cardColor,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              _loc.tr('sos_voice_title'),
                              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              _isRecordingVoice
                                  ? _loc.tr('sos_voice_sub_rec')
                                  : _loc.tr('sos_voice_sub_idle'),
                              style: TextStyle(fontSize: 11, color: isDarkMode ? Colors.white60 : Colors.black54),
                            ),
                            const SizedBox(height: 12),

                            if (!_isRecordingVoice)
                              ElevatedButton.icon(
                                onPressed: _startVoiceRecording,
                                icon: const Icon(Icons.mic, color: Colors.white),
                                label: Text(_loc.tr('sos_voice_record_btn'), style: const TextStyle(color: Colors.white)),
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: AppTheme.primaryPink,
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                ),
                              )
                            else
                              // RECORDING ACTIVE BAR WITH AUTOMATIC SEND BUTTON ON RIGHT (TELEGRAM STYLE)
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                                decoration: BoxDecoration(
                                  color: AppTheme.primaryPink.withValues(alpha: 0.15),
                                  borderRadius: BorderRadius.circular(14),
                                  border: Border.all(color: AppTheme.primaryPink),
                                ),
                                child: Row(
                                  children: [
                                    const Icon(Icons.fiber_manual_record, color: Colors.red, size: 20),
                                    const SizedBox(width: 8),
                                    Text(
                                      "0:${_recordSeconds.toString().padLeft(2, '0')}",
                                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: AppTheme.primaryPink),
                                    ),
                                    const Spacer(),
                                    IconButton(
                                      icon: const Icon(Icons.close, color: Colors.grey),
                                      onPressed: _cancelVoiceRecording,
                                      tooltip: "Discard Recording",
                                    ),
                                    const SizedBox(width: 8),
                                    ElevatedButton.icon(
                                      onPressed: _sendVoiceNote,
                                      icon: const Icon(Icons.send_rounded, size: 16, color: Colors.white),
                                      label: Text(_loc.tr('sos_voice_send_btn'), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                                      style: ElevatedButton.styleFrom(
                                        backgroundColor: AppTheme.primaryPink,
                                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                          ],
                        ),
                      ),

                      const SizedBox(height: 16),

                      // 3. EMERGENCY MESSAGE NOTE CARD (BELOW VOICE NOTE, WITH SEND BUTTON & LOCKED ONCE SENT)
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: cardColor,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(_loc.tr('sos_message_label'), style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                            const SizedBox(height: 10),

                            if (!_isMessageSent) ...[
                              TextField(
                                controller: _messageCtrl,
                                maxLines: 2,
                                decoration: InputDecoration(
                                  hintText: _loc.tr('sos_message_hint'),
                                  contentPadding: const EdgeInsets.all(12),
                                ),
                              ),
                              const SizedBox(height: 12),
                              Align(
                                alignment: Alignment.centerRight,
                                child: ElevatedButton.icon(
                                  onPressed: _sendEmergencyMessageNote,
                                  icon: const Icon(Icons.send_rounded, size: 16, color: Colors.white),
                                  label: Text(_loc.tr('sos_message_send_btn'), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13)),
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: AppTheme.primaryPink,
                                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                                    padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
                                  ),
                                ),
                              ),
                            ] else ...[
                              // LOCKED MESSAGE SENT CONFIRMATION CARD
                              Container(
                                width: double.infinity,
                                padding: const EdgeInsets.all(14),
                                decoration: BoxDecoration(
                                  color: Colors.green.withValues(alpha: 0.12),
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(color: Colors.green.withValues(alpha: 0.5)),
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        const Icon(Icons.check_circle_rounded, color: Colors.green, size: 20),
                                        const SizedBox(width: 8),
                                        Text(
                                          _loc.tr('sos_message_sent'),
                                          style: const TextStyle(
                                            color: Colors.green,
                                            fontWeight: FontWeight.bold,
                                            fontSize: 14,
                                          ),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 6),
                                    Text(
                                      _loc.tr('sos_message_sent_sub'),
                                      style: TextStyle(
                                        fontSize: 11,
                                        color: isDarkMode ? Colors.white70 : Colors.black87,
                                      ),
                                    ),
                                    if (_messageCtrl.text.isNotEmpty) ...[
                                      const SizedBox(height: 10),
                                      Container(
                                        width: double.infinity,
                                        padding: const EdgeInsets.all(12),
                                        decoration: BoxDecoration(
                                          color: isDarkMode ? Colors.black38 : Colors.white70,
                                          borderRadius: BorderRadius.circular(8),
                                        ),
                                        child: Text(
                                          "\"${_messageCtrl.text.trim()}\"",
                                          style: const TextStyle(
                                            fontSize: 13,
                                            fontStyle: FontStyle.italic,
                                            fontWeight: FontWeight.w500,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }
}
