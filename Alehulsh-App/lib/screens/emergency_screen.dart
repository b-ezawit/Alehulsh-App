import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import '../theme/app_theme.dart';
import '../models/alert_model.dart';
import '../models/sos_submission_state.dart';
import '../models/user_profile_model.dart';
import '../services/user_data_service.dart';
import '../services/alert_service.dart';
import '../services/location_service.dart';
import '../services/localization_service.dart';
import '../services/audio_recording_service.dart';
import '../services/emergency_gesture_service.dart';
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

  // Active SOS alert tracking state.
  //
  // _sosState is the source of truth. _isSOSSent is derived and means "an alert
  // exists", which is what the active-SOS controls key off. It deliberately does
  // NOT mean "delivered" - use _sosState.isDelivered for that. Conflating the
  // two is the bug this replaced.
  SosSubmissionState _sosState = SosSubmissionState.idle;
  bool get _isSOSSent => _sosState.hasAlert;
  String? _sosFailureDetail;
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
  StreamSubscription<ActiveAlertSnapshot>? _userAlertSubscription;

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
      // We know an alert was raised on this device, but not whether the server
      // ever received it. Restore as queued, not sent. The Firestore stream
      // below promotes it to sent once the server confirms the document exists,
      // which is the reconciliation path after a crash or restart.
      setState(() {
        _sosState = SosSubmissionState.queued;
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

    _userAlertSubscription = _alertService.getUserActiveAlertStream(userId).listen((snapshot) async {
      if (!mounted) return;

      final activeAlert = snapshot.alert;
      if (activeAlert != null) {
        setState(() {
          // The ONLY place the app concludes the alert was delivered, and only
          // on the server's word. A snapshot with pending writes came from this
          // phone's cache and proves nothing about delivery.
          //
          // While a send is still in flight we do not downgrade to `queued`:
          // the local cache write fires this listener within milliseconds, and
          // flashing "NOT SENT" during a normal send would frighten her for no
          // reason. _triggerSOS owns the outcome until it resolves, and it
          // settles on queued itself if the server does not acknowledge in
          // time. Promotion to `sent` is always allowed.
          if (snapshot.isPendingDelivery) {
            if (_sosState != SosSubmissionState.sending) {
              _sosState = SosSubmissionState.queued;
            }
          } else {
            _sosState = SosSubmissionState.sent;
          }
          if (snapshot.isConfirmedDelivered) _sosFailureDetail = null;
          _activeAlertId = activeAlert.id;
          _isUrgent = activeAlert.isUrgent;
          if (activeAlert.message.trim().isNotEmpty) {
            _messageCtrl.text = activeAlert.message.trim();
            _isMessageSent = true;
          }
        });
        await _userDataService.setSOSActiveLocally(true, activeAlert.id);
      } else {
        // No alert on the server. Only clear if this device does not believe one
        // is outstanding, so an offline queued alert is not silently forgotten.
        final isLocallyActive = await _userDataService.isSOSActiveLocally();
        if (!isLocallyActive && mounted) {
          setState(() {
            _sosState = SosSubmissionState.idle;
            _sosFailureDetail = null;
            _activeAlertId = null;
            _isUrgent = false;
            _isMessageSent = false;
            _messageCtrl.clear();
          });
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

  /// How long to wait for the server to acknowledge the alert before reporting
  /// it as queued rather than sent.
  ///
  /// A compromise, not a measured value: long enough for a slow Ethiopian mobile
  /// connection, short enough that she is not left without feedback.
  /// NEEDS MEASUREMENT on a real network.
  static const Duration _serverAckTimeout = Duration(seconds: 10);

  // Trigger SOS Alert (Instant Tap Response + Haptics)
  Future<void> _triggerSOS() async {
    if (!_userDataService.isLoggedIn) {
      _showLoginRequiredDialog(_loc.isAmharic
          ? "የአደጋ ጊዜ ጥሪ (SOS) ለመላክ በመጀመሪያ መግባት (Login) አለብዎት!"
          : "You must log in to call for help and broadcast emergency SOS!");
      return;
    }

    // Already sending, or an alert already exists. Retrying a FAILED send is
    // allowed and lands here from the retry button.
    if (_sosState.isBusy || _sosState.hasAlert) return;

    // Immediate tactile feedback
    HapticFeedback.heavyImpact();

    final profile = _userDataService.currentProfile;

    // No fabricated fallback. This previously defaulted to (9.0125, 38.7636),
    // Addis Ababa city centre, so an SOS sent without a GPS fix asserted she was
    // downtown and would send responders to the wrong place.
    final double? lat = _livePosition?.latitude ?? _locationService.currentPosition?.latitude;
    final double? lng = _livePosition?.longitude ?? _locationService.currentPosition?.longitude;
    final bool hasLocation = lat != null && lng != null;

    // "sending", NOT "sent". Nothing has been confirmed at this point.
    setState(() {
      _sosState = SosSubmissionState.sending;
      _sosFailureDetail = null;
      _activeAlertId = profile.uid;
    });

    // Record the INTENT before attempting the write: mark intent -> send ->
    // mark completion. If the app is killed between the tap and the server
    // acknowledgement, this flag is what tells the next launch that an alert is
    // outstanding, so it restores as `queued` and the Firestore stream
    // reconciles it. Without it a crash mid-send would leave her believing
    // nothing had been raised while a queued write was still pending.
    //
    // The alert id is known in advance because the document id is the user's
    // uid, which is also what makes a retry idempotent.
    await _userDataService.setSOSActiveLocally(true, profile.uid);

    try {
      // Firestore resolves set() on SERVER acknowledgement. Offline it never
      // completes and never throws, so without this timeout the method would
      // hang here forever while the screen showed an active broadcast.
      final String alertId = await _alertService
          .createSOSAlert(
            profile: profile,
            latitude: lat,
            longitude: lng,
            locationName: hasLocation ? "Live GPS" : "Location unavailable",
            message: _messageCtrl.text,
            isUrgent: _isUrgent,
          )
          .timeout(_serverAckTimeout);

      // The server has it. This is the only path that may claim delivery.
      await _userDataService.setSOSActiveLocally(true, alertId);
      _userDataService.recordSOSTriggered();

      if (!mounted) return;
      setState(() {
        _sosState = SosSubmissionState.sent;
        _activeAlertId = alertId;
      });

      await _notifySosOutcome(
        title: _loc.isAmharic ? "ጥሪዎ ተልኳል" : "Alert sent",
        body: hasLocation
            ? (_loc.isAmharic
                ? "የአደጋ ጥሪዎ ከቦታዎ ጋር ተልኳል።"
                : "Your emergency alert was sent with your location.")
            : (_loc.isAmharic
                ? "ጥሪዎ ተልኳል፤ ነገር ግን ቦታዎ አልታወቀም።"
                : "Your emergency alert was sent, but your location could not be determined."),
      );

      if (mounted) {
        _showSosSnack(
          hasLocation
              ? (_loc.isAmharic
                  ? "ጥሪዎ ተልኳል።"
                  : "Your alert was sent.")
              : (_loc.isAmharic
                  ? "ጥሪዎ ተልኳል፤ ቦታዎ ግን አልታወቀም።"
                  : "Alert sent, but your location is unknown."),
          Colors.green.shade700,
        );
      }
    } on TimeoutException {
      // The write stays queued in Firestore's cache and will be sent when
      // connectivity returns. It has NOT reached anyone. Say exactly that: the
      // old copy claimed the alert "will broadcast the millisecond connection is
      // restored", which overstates what we can promise.
      await _userDataService.setSOSActiveLocally(true, profile.uid);
      _userDataService.recordSOSTriggered();

      if (!mounted) return;
      setState(() => _sosState = SosSubmissionState.queued);

      await _notifySosOutcome(
        title: _loc.isAmharic ? "ጥሪዎ አልተላከም" : "Alert NOT yet delivered",
        body: _loc.isAmharic
            ? "በስልክዎ ተቀምጧል። አውታረ መረብ ሲኖር ይላካል። ከተቻለ በቀጥታ ይደውሉ።"
            : "Saved on your phone and will send when you have signal. Call for help directly if you can.",
      );

      if (mounted) {
        _showSosSnack(
          _loc.isAmharic
              ? "ጥሪዎ እስካሁን አልተላከም። በስልክዎ ተቀምጧል። ከተቻለ በቀጥታ ይደውሉ።"
              : "Not delivered yet - saved on your phone. Call for help directly if you can.",
          Colors.orange.shade800,
          seconds: 8,
        );
      }
    } catch (e) {
      // A failed SOS must be impossible to mistake for a successful one. The old
      // implementation only wrote to debugPrint here and left the screen showing
      // an active broadcast.
      debugPrint("[EmergencyScreen] SOS send failed: $e");

      // Terminal failure, so the intent must be withdrawn. Firestore queues
      // transient/offline writes itself and those surface as a timeout, not
      // here; what reaches this branch (permission denied, invalid document)
      // will never succeed on its own. Leaving the flag set would make the next
      // launch restore a `queued` alert that does not exist and never will.
      await _userDataService.setSOSActiveLocally(false);

      if (!mounted) return;
      setState(() {
        _sosState = SosSubmissionState.failed;
        _sosFailureDetail = e.toString();
        _activeAlertId = null;
      });

      await _notifySosOutcome(
        title: _loc.isAmharic ? "ጥሪዎ አልተላከም!" : "SOS FAILED to send",
        body: _loc.isAmharic
            ? "ጥሪዎ መላክ አልተቻለም። እባክዎ እንደገና ይሞክሩ ወይም በቀጥታ ይደውሉ።"
            : "Your alert could not be sent. Try again, or call for help directly.",
      );

      if (mounted) {
        _showSosSnack(
          _loc.isAmharic
              ? "ጥሪዎ አልተላከም። እንደገና ይሞክሩ ወይም በቀጥታ ይደውሉ።"
              : "SOS failed to send. Try again, or call for help directly.",
          AppTheme.emergencyRed,
          seconds: 10,
        );
      }
    }
  }

  // ---- State presentation -------------------------------------------------
  // Green is reserved for SosSubmissionState.sent. Every other state must look
  // visibly different, because the whole point is that she can tell at a glance
  // whether her alert actually reached anyone.

  Color get _sosStatusColor {
    switch (_sosState) {
      case SosSubmissionState.sent:
        return Colors.green;
      case SosSubmissionState.queued:
        return Colors.orange.shade800;
      case SosSubmissionState.failed:
        return AppTheme.emergencyRed;
      case SosSubmissionState.sending:
        return Colors.blue.shade700;
      case SosSubmissionState.idle:
        return AppTheme.emergencyRed;
    }
  }

  IconData get _sosStatusIcon {
    switch (_sosState) {
      case SosSubmissionState.sent:
        return Icons.check_circle_rounded;
      case SosSubmissionState.queued:
        return Icons.cloud_off_rounded;
      case SosSubmissionState.failed:
        return Icons.error_rounded;
      case SosSubmissionState.sending:
        return Icons.sync_rounded;
      case SosSubmissionState.idle:
        return Icons.cell_tower_rounded;
    }
  }

  String get _sosStatusTitle {
    final amharic = _loc.isAmharic;
    switch (_sosState) {
      case SosSubmissionState.sent:
        return _loc.tr('sos_broadcast_active');
      case SosSubmissionState.queued:
        return amharic ? "አልተላከም - በስልክዎ ተቀምጧል" : "NOT SENT - saved on your phone";
      case SosSubmissionState.failed:
        return amharic ? "ጥሪዎ አልተላከም" : "SOS FAILED TO SEND";
      case SosSubmissionState.sending:
        return amharic ? "በመላክ ላይ..." : "Sending...";
      case SosSubmissionState.idle:
        return _loc.tr('sos_shield_standby');
    }
  }

  /// Second line of the banner: what she should do, not what we hope happened.
  String get _sosStatusDetail {
    final amharic = _loc.isAmharic;
    switch (_sosState) {
      case SosSubmissionState.queued:
        return amharic
            ? "አውታረ መረብ ሲኖር ይላካል። ከተቻለ በቀጥታ ይደውሉ።"
            : "Will send when you have signal. Call for help directly if you can.";
      case SosSubmissionState.failed:
        // The main SOS button is the retry: `failed` is neither busy nor
        // has-alert, so _triggerSOS runs again. Re-sending is safe because the
        // document id is the user's uid, so a retry overwrites rather than
        // raising a second alert.
        return amharic
            ? "SOS ን እንደገና ይጫኑ ወይም በቀጥታ ይደውሉ።"
            : "Press SOS again, or call for help directly.";
      case SosSubmissionState.sending:
        return amharic ? "እስካሁን አልተረጋገጠም..." : "Not confirmed yet...";
      case SosSubmissionState.sent:
      case SosSubmissionState.idle:
        // Only here is it safe to show the GPS readout as reassurance.
        if (_livePosition != null) {
          return "GPS Live: ${_livePosition!.latitude.toStringAsFixed(4)}, ${_livePosition!.longitude.toStringAsFixed(4)}";
        }
        return _isFetchingLocation
            ? (amharic ? "ቦታ በመፈለግ ላይ..." : "Fetching GPS location...")
            : (amharic ? "ቦታዎ አልታወቀም" : "Location unknown");
    }
  }

  void _showSosSnack(String text, Color background, {int seconds = 5}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(text, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
        backgroundColor: background,
        duration: Duration(seconds: seconds),
      ),
    );
  }

  /// Post the outcome of a send attempt, whatever it was.
  ///
  /// The screen may already be off or in her pocket, so this is the channel she
  /// actually has. Every path through _triggerSOS posts exactly one, including
  /// the failures, which previously posted nothing at all.
  Future<void> _notifySosOutcome({required String title, required String body}) async {
    const AndroidNotificationDetails androidDetails = AndroidNotificationDetails(
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
      // Was VISIBILITY_PUBLIC, which printed the full text on the lock screen of
      // a phone that may be in the hands of the person she is escaping.
      visibility: NotificationVisibility.private,
    );
    try {
      await FlutterLocalNotificationsPlugin().show(
        71002,
        title,
        body,
        const NotificationDetails(android: androidDetails),
      );
    } catch (e) {
      debugPrint("[EmergencyScreen] Could not post SOS outcome notification: $e");
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
                  final result = await _alertService.cancelSOSAlert(
                    alertId: _activeAlertId!,
                    userCatName: profile.catName,
                    inputCatName: catNameInputCtrl.text,
                  );

                  if (result.isSuccess) {
                    await _userDataService.setSOSActiveLocally(false);
                    await EmergencyGestureService().recordCancellation();
                    Navigator.pop(ctx);
                    setState(() {
                      _sosState = SosSubmissionState.idle;
                      _sosFailureDetail = null;
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
                      if (result.isSecurityMismatch) {
                        errorTxt = _loc.isAmharic
                            ? "የተሳሳተ የደህንነት መልስ። ማረጋገጫው አልተሳካም!"
                            : "Incorrect security code. Verification failed!";
                      } else {
                        errorTxt = _loc.isAmharic
                            ? "የዳታቤዝ ፍቃድ ስህተት: እባክዎ የFirebase Rules ይመልከቱ።"
                            : "Database permission error: Please update Firestore Security Rules.";
                      }
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
                        color: _sosStatusColor.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: _sosStatusColor),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            _sosStatusIcon,
                            color: _sosStatusColor,
                            size: 28,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  _sosStatusTitle,
                                  style: TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.bold,
                                    color: _sosStatusColor,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  _sosStatusDetail,
                                  style: TextStyle(fontSize: 11, color: isDarkMode ? Colors.white70 : Colors.black87),
                                ),
                                if (_sosState == SosSubmissionState.failed && _sosFailureDetail != null) ...[
                                  const SizedBox(height: 4),
                                  Text(
                                    // Shown so a tester can report WHY it failed.
                                    // Technical, deliberately not reassuring.
                                    _sosFailureDetail!,
                                    maxLines: 3,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: 9,
                                      color: isDarkMode ? Colors.white54 : Colors.black54,
                                    ),
                                  ),
                                ],
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
                          if (_sosState.isBusy)
                            // Sending: not armed, and explicitly NOT confirmed.
                            Container(
                              width: 200,
                              height: 200,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: Colors.blue.shade700,
                              ),
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  const SizedBox(
                                    width: 46,
                                    height: 46,
                                    child: CircularProgressIndicator(color: Colors.white, strokeWidth: 4),
                                  ),
                                  const SizedBox(height: 14),
                                  Text(
                                    _loc.isAmharic ? "በመላክ ላይ..." : "SENDING...",
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
                            )
                          else if (!_isSOSSent)
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
                            // An alert exists. Green and a tick are reserved for
                            // a server-acknowledged alert; a queued one is amber
                            // and says so, because nobody has been notified yet.
                            Container(
                              width: 200,
                              height: 200,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: _sosStatusColor,
                                boxShadow: [
                                  BoxShadow(
                                    color: _sosStatusColor.withValues(alpha: 0.4),
                                    blurRadius: 25,
                                    spreadRadius: 4,
                                  ),
                                ],
                              ),
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Icon(_sosStatusIcon, size: 56, color: Colors.white),
                                  const SizedBox(height: 8),
                                  Padding(
                                    padding: const EdgeInsets.symmetric(horizontal: 14),
                                    child: Text(
                                      _sosState.isDelivered
                                          ? _loc.tr('sos_sent_btn')
                                          : (_loc.isAmharic ? "አልተላከም" : "NOT DELIVERED"),
                                      textAlign: TextAlign.center,
                                      style: const TextStyle(
                                        color: Colors.white,
                                        fontSize: 16,
                                        fontWeight: FontWeight.bold,
                                        letterSpacing: 1,
                                      ),
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
