# 🛡️ Alehulsh (አለሁልሽ) — Comprehensive Technical Architecture & Developer Handoff Document

> **App Name:** Alehulsh (አለሁልሽ)  
> **Version:** 1.0.1+23  
> **Platform:** Flutter (Android, iOS, Web)  
> **Target Audience:** Women Safety, Emergency Proximity Response & Live Distress Dispatch Network


---

## 1. Executive Summary & Product Overview

**Alehulsh (አለሁልሽ)** is a real-time emergency safety and distress response platform engineered to protect individuals in distress. The system features a 500-meter proximity radar network that broadcasts high-priority emergency pings, live GPS tracking, 5x physical power-button hardware trigger detection, shake gestures, voice distress notes, and responder coordination.

The app supports **bilingual localization (English & Amharic / አማርኛ)** with persistent cloud synchronization, native Android background services, and Firebase Cloud Functions.

---

## 2. Complete Technology Stack

### 2.1 Core Framework & Language
* **Framework:** Flutter SDK (`>=3.0.0 <4.0.0`)
* **Languages:** Dart 3.x, Kotlin (Native Android), JavaScript/Node.js (Firebase Cloud Functions)
* **UI Design System:** Material 3, Custom Glassmorphism, Google Fonts (`Inter`, `Cinzel`, `Outfit`, `Noto Sans Ethiopic`), Custom Dark/Purple Palette (`#351C63`, `#6C5CE7`, `#E53935`, `#00E676`).

### 2.2 Dependencies & Third-Party Packages
| Package | Version | Purpose |
| :--- | :--- | :--- |
| `firebase_core` | `^3.10.0` | Firebase project initialization & cross-platform bridge |
| `firebase_auth` | `^5.4.0` | Email/password & session state management |
| `cloud_firestore` | `^5.6.0` | Real-time database for active alerts, user profiles, activities |
| `firebase_messaging` | `^15.2.1` | FCM push notifications & topic-based radar broadcasts |
| `geolocator` | `^13.0.0` | High-accuracy GPS positioning & distance calculations |
| `geoflutterfire_plus` | `^0.0.32` | Geohash generation & spatial proximity queries |
| `record` / `audioplayers` | `^5.1.2` / `^6.0.0` | Voice emergency note capture and playback |
| `shake` / `sensors_plus` | `^3.0.0` / `^6.1.2` | Accelerometer-based shake distress detection |
| `flutter_local_notifications` | `^17.2.4` | Heads-up emergency notifications & alert dismissal |
| `shared_preferences` | `^2.2.2` | Local offline caching for preferences and session data |
| `url_launcher` | `^6.3.0` | Direct phone calls (`tel://`), SMS (`sms://`), and Google Maps |

### 2.3 Native Android Subsystem (`android/app/src/main/kotlin/`)
* **`HardwareSosAccessibilityService.kt`**: 24/7 Accessibility service monitoring physical power-button key events (3-5 rapid presses) and system emergency window activations (Samsung/Google SOS) with zero in-app false alarms.
* **`AlehulshForegroundService.kt`**: Persistent foreground service with sticky notification channel, holding a partial `WakeLock` to prevent Android Doze mode termination.
* **`AlehulshSosDispatcher.kt`**: Headless SOS dispatcher that reads cached credentials, acquires high-accuracy GPS, computes a 5-character Geohash, and writes directly to Firestore even when Flutter UI is closed.
* **`GeoHash.kt`**: Native Kotlin spatial encoding matching Dart & Node.js geohash algorithms.

### 2.4 Cloud & Backend Infrastructure
* **Firebase Cloud Functions v2** (`functions/index.js`):
  1. `onAlertCreated`: Server-side trigger broadcasting high-priority FCM notifications to geohash topic channels (`sos_radar_{geohash5}`) within milliseconds.
  2. `cleanupExpiredAlerts`: Cloud Scheduler cron running every 15 minutes to purge orphaned alerts older than 2 hours (2-Hour TTL Safety Net).
  3. `onAlertDeleted`: Broadcasts silent dismissal payloads to dismiss notification banners on responders' devices once resolved.
* **Cloud Firestore Security Rules** (`firestore.rules`):
  - Strictly typed rules enforcing authenticated access, alert ownership, atomic responder joins, and user profile data isolation.

---

## 3. Detailed Breakdown of Completed Features

### 3.1 Screens (`lib/screens/`)
1. **`auth_screen.dart`**:
   - Modern glassmorphic login & registration forms.
   - Comprehensive registration: Full Name, Email, Phone, Home Address, Security Pet Name, Emergency Contacts (Name, Phone, Relationship).
   - Real-time input validation, password toggle, and error handling.
2. **`home_screen.dart`**:
   - Quick SOS dispatch widget with pulsating visual state.
   - Live location widget with street/city reverse-geocoding.
   - Quick navigation tiles to Emergency Hub, Nearby Radar, Safety Contacts, and Security Profile.
3. **`emergency_screen.dart`**:
   - One-tap SOS trigger with instant countdown and cancel safety grace period.
   - Real-time active broadcast state with GPS coordinate telemetry.
   - Emergency distress note dispatcher (custom message broadcasting).
   - Voice note recorder for quick 10-second distress audio transmission.
   - Direct shortcuts for Police (911/991), Ambulance (907), Fire Service (939), and Emergency Contacts.
4. **`women_for_women_screen.dart` (Proximity Radar Hub)**:
   - 500-meter proximity radar scanner listening to Firestore `active_alerts`.
   - Dynamic distance calculation (`Geolocator.distanceBetween`).
   - "Respond / I am Coming" interaction adding current responder to the alert document.
   - Direct Google Maps navigation link to victim coordinates.
   - Filter chips for All, Critical Distress, and Within 500m.
5. **`emergency_contacts_screen.dart`**:
   - CRUD management for trusted emergency contacts.
   - Instant direct dial and pre-formatted SMS emergency dispatch with GPS link.
6. **`profile_screen.dart`**:
   - Security profile management, account details update, and recent safety activities log.
   - Emergency contact list preview & language switcher.
7. **`main_navigation_screen.dart`**:
   - Custom animated bottom navigation bar with persistent tab switching.

### 3.2 Services & Utilities (`lib/services/` & `lib/utils/`)
* **`AuthService`**: Firebase authentication wrapper handling user session state, sign up, sign in, and complete logout cleanup.
* **`AlertService`**: Handles active SOS document creation, updates, and cancellations in Firestore `/active_alerts/{alertId}`.
* **`EmergencyPingService`**: Manages FCM token registration, foreground/background notification handlers, and radar topic subscriptions.
* **`EmergencyGestureService`**: Accelerometer shake detection trigger.
* **`LocationService`**: High-accuracy GPS position polling and geocoding.
* **`AudioRecordingService` & `AudioPlaybackService`**: Audio recording, local caching, and playback.
* **`UserDataService`**: Firestore user profile CRUD and in-memory caching.
* **`LocalizationService`**: Full bilingual translation matrix (English & Amharic).
* **`geohash_util.dart`**: Spatial geohash encoder/decoder.

---

## 4. Remaining Tasks & Technical Implementation Guide

The next developer should focus on the following three major milestones:

```
┌───────────────────────────────────────────────────────────────────────┐
│                           REMAINING ROADMAP                           │
├──────────────────────────────────┬────────────────────────────────────┤
│ 1. Google Authentication         │ Native OAuth 2.0 Sign-In Flow      │
│ 2. Database Scalability (100k+)  │ Geohash Queries, Caching & Shards  │
│ 3. Google Play Store Release     │ Signing, Permissions & Bundle      │
└──────────────────────────────────┴────────────────────────────────────┘
```

---

### Task 1: Authentication via Google (Google Sign-In)

#### Goal
Allow users to sign in and sign up with a single tap using their Google account, auto-populating their name and email, while gracefully prompting for mandatory safety fields (phone number and emergency contacts).

#### Step-by-Step Implementation

1. **Add Dependency** to `pubspec.yaml`:
   ```yaml
   dependencies:
     google_sign_in: ^6.2.2
   ```

2. **Configure Android SHA Fingerprints**:
   - Run in terminal:
     ```bash
     cd android
     ./gradlew signingReport
     ```
   - Copy the `SHA-1` and `SHA-256` keys for `debug` and `release` keystores.
   - Add them to **Firebase Console** -> **Project Settings** -> **Your Android Apps** (`com.example.alehulsh_app`) -> **Add Fingerprint**.
   - Download the updated `google-services.json` and replace `android/app/google-services.json`.

3. **Enable Google Provider in Firebase Console**:
   - Go to **Firebase Console** -> **Authentication** -> **Sign-in method** -> **Google** -> Enable and set support email.

4. **Implement `signInWithGoogle()` in `lib/services/auth_service.dart`**:
   ```dart
   import 'package:google_sign_in/google_sign_in.dart';

   final GoogleSignIn _googleSignIn = GoogleSignIn();

   Future<UserCredential?> signInWithGoogle() async {
     try {
       final GoogleSignInAccount? googleUser = await _googleSignIn.signIn();
       if (googleUser == null) return null; // User cancelled

       final GoogleSignInAuthentication googleAuth = await googleUser.authentication;
       final OAuthCredential credential = GoogleAuthProvider.credential(
         accessToken: googleAuth.accessToken,
         idToken: googleAuth.idToken,
       );

       UserCredential userCredential = await _auth.signInWithCredential(credential);
       User? user = userCredential.user;

       if (user != null) {
         // Check if user profile already exists in Firestore
         final doc = await _firestore.collection('users').doc(user.uid).get();
         if (!doc.exists) {
           // Create initial skeleton profile
           UserProfile newProfile = UserProfile(
             uid: user.uid,
             fullName: user.displayName ?? "Alehulsh User",
             email: user.email ?? "",
             phoneNumber: user.phoneNumber ?? "",
             homeAddress: "",
             catName: "",
             emergencyContacts: [],
             activities: [
               UserActivityLog(
                 id: "act_google_init",
                 title: "Google Sign-In Registered",
                 description: "Joined Alehulsh via Google authentication.",
                 timestamp: DateTime.now(),
                 type: "profile_updated",
               ),
             ],
             createdAt: DateTime.now(),
             lastActiveAt: DateTime.now(),
           );
           await _firestore.collection('users').doc(user.uid).set(newProfile.toMap());
         }
       }
       return userCredential;
     } catch (e) {
       debugPrint("[AuthService] Google Sign-In Error: $e");
       rethrow;
     }
   }
   ```

5. **Update `lib/screens/auth_screen.dart`**:
   - Wire the "Continue with Google" button to call `AuthService().signInWithGoogle()`.
   - If user has no phone number or emergency contacts, route them to a quick profile completion dialog.

---

### Task 2: Scalable Database Architecture for High Volume (100,000+ Users)

#### Goal
Ensure Firestore reads and writes remain efficient, cost-effective, and fast when thousands of users are broadcasting or listening to alerts concurrently.

#### Technical Blueprint

1. **Spatial Geohash Bounding Queries**:
   - Do **not** query all alerts globally and filter locally in Dart.
   - Use `geoflutterfire_plus` with 5-character geohashes (~2.4km bounding box) or 6-character geohashes (~610m box):
   ```dart
   final GeoFirePoint center = GeoFirePoint(GeoPoint(userLat, userLng));
   final collectionRef = FirebaseFirestore.instance.collection('active_alerts');
   
   Stream<List<DocumentSnapshot>> stream = GeoCollectionReference(collectionRef).subscribeWithin(
     center: center,
     radiusInKm: 0.5, // 500 meters
     field: 'geo',
     geopointFrom: (data) => (data['geo'] as Map<String, dynamic>)['geopoint'] as GeoPoint,
   );
   ```

2. **FCM Topic-Based Push Fanout (Zero Database Polling)**:
   - Responders do not need active Firestore listeners while in the background.
   - Subscribe devices to their current 5-char geohash topic:
     ```dart
     FirebaseMessaging.instance.subscribeToTopic("sos_radar_$geohash5");
     ```
   - When users move more than 2km, unsubscribe from the old topic and subscribe to the new one.

3. **Firestore Composite Indexes** (`firestore.indexes.json`):
   - Index `status` (Ascending) + `expiresAtTimestamp` (Ascending) for quick scheduled purge.
   - Index `geohash` (Ascending) + `timestamp` (Descending) for spatial feeds.

4. **Offline Persistence & In-Memory Cache**:
   - Enable local cache settings in `lib/main.dart`:
     ```dart
     FirebaseFirestore.instance.settings = const Settings(
       persistenceEnabled: true,
       cacheSizeBytes: Settings.CACHE_SIZE_UNLIMITED,
     );
     ```

5. **2-Hour Auto-TTL Cleanup**:
   - The Cloud Function `cleanupExpiredAlerts` (in `functions/index.js`) handles batch deletions so `active_alerts` collection stays under 500 documents at any given time.

---

### Task 3: Publishing to Google Play Store

#### Goal
Build, sign, and publish the release Android App Bundle (`.aab`) to the Google Play Console while meeting strict Google Play policies for emergency, background location, and accessibility services.

#### Step-by-Step Release Workflow

#### 1. Generate Production Upload Keystore
Run in terminal (replace paths and passwords as needed):
```bash
keytool -genkey -v -keystore C:/Users/HP/alehulsh-upload-keystore.jks -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -alias alehulsh
```

#### 2. Configure `android/key.properties`
Create `android/key.properties` (this is ignored by `.gitignore`):
```properties
storePassword=YOUR_KEYSTORE_PASSWORD
keyPassword=YOUR_KEY_PASSWORD
keyAlias=alehulsh
storeFile=C:/Users/HP/alehulsh-upload-keystore.jks
```

#### 3. Update `android/app/build.gradle.kts`
Configure release signing:
```kotlin
import java.util.Properties
import java.io.FileInputStream

val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

android {
    ...
    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
            }
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}
```

#### 4. Build the Release App Bundle
```bash
flutter clean
flutter pub get
flutter build appbundle --release
```
The output file is located at: `build/app/outputs/bundle/release/app-release.aab`.

#### 5. Google Play Console Compliance Requirements
Google Play requires strict declaration for the following sensitive permissions used in Alehulsh:
* **Background Location (`ACCESS_BACKGROUND_LOCATION`)**:
  - Provide a prominent in-app disclosure before requesting background location.
  - Record a video showing how background location powers the 500m proximity distress radar.
* **Foreground Service (`FOREGROUND_SERVICE_LOCATION` & `FOREGROUND_SERVICE_SPECIAL_USE`)**:
  - Declare the persistent guardian notification keeps the victim traceable during distress even if the screen locks.
* **Accessibility Service (`HardwareSosAccessibilityService`)**:
  - Submit a declaration explaining that the service is strictly used to detect rapid physical power button presses for hands-free emergency SOS dispatch when the user is under physical attack and cannot unlock their screen.

#### 6. Google Play Store Assets Checklist
- [ ] **App Name:** Alehulsh — Women Safety & SOS Radar
- [ ] **Short Description:** (80 chars max) Real-time 500m emergency proximity SOS radar and women safety guardian.
- [ ] **Full Description:** Comprehensive safety features, hardware SOS, voice note dispatch, and trusted contacts.
- [ ] **High-Res Icon:** 512 x 512 PNG (`assets/images/app_logo.png`)
- [ ] **Feature Graphic:** 1024 x 500 PNG/JPEG
- [ ] **Phone Screenshots:** At least 4 screenshots (Home, SOS Trigger, 500m Radar Hub, Profile).
- [ ] **Privacy Policy URL:** Public webpage hosted via Firebase Hosting or GitHub Pages explaining data collection and location usage.

---

## 5. Quick Reference: File Structure Directory

```
Alehulsh-App/
├── android/
│   ├── app/
│   │   ├── src/main/kotlin/com/example/alehulsh_app/
│   │   │   ├── AlehulshForegroundService.kt       # Persistent background guardian
│   │   │   ├── AlehulshSosDispatcher.kt           # Headless GPS & SOS dispatcher
│   │   │   ├── GeoHash.kt                         # Native spatial encoder
│   │   │   ├── HardwareSosAccessibilityService.kt # 5x Power button hardware trigger
│   │   │   └── MainActivity.kt                    # Flutter embedding entry
│   │   ├── build.gradle.kts                       # Android build configuration
│   │   └── google-services.json                   # Firebase Android config
├── functions/
│   ├── index.js                                   # Cloud Functions v2 (FCM & 2-hr TTL)
│   └── package.json
├── lib/
│   ├── models/
│   │   ├── alert_model.dart                       # Active alert data model
│   │   └── user_profile_model.dart                # User profile & contact models
│   ├── screens/
│   │   ├── auth_screen.dart                       # Login & Registration
│   │   ├── emergency_contacts_screen.dart         # Trusted contacts CRUD & SMS
│   │   ├── emergency_screen.dart                  # Instant SOS broadcast & voice note
│   │   ├── home_screen.dart                       # Dashboard & quick access
│   │   ├── main_navigation_screen.dart            # Persistent bottom navigation
│   │   ├── profile_screen.dart                    # Account & security settings
│   │   └── women_for_women_screen.dart            # 500m proximity radar feed
│   ├── services/
│   │   ├── alert_service.dart                     # Firestore alert management
│   │   ├── audio_playback_service.dart            # Voice note playback
│   │   ├── audio_recording_service.dart           # Distress audio recorder
│   │   ├── auth_service.dart                      # Firebase Auth integration
│   │   ├── emergency_gesture_service.dart         # Accelerometer shake listener
│   │   ├── emergency_ping_service.dart            # Push notifications & FCM topics
│   │   ├── localization_service.dart              # English & Amharic translator
│   │   ├── location_service.dart                  # GPS tracking & geocoding
│   │   └── user_data_service.dart                 # Profile caching & sync
│   ├── theme/
│   │   └── app_theme.dart                         # Brand styling & dark theme
│   ├── utils/
│   │   └── geohash_util.dart                      # Spatial coordinates encoder
│   ├── firebase_options.dart                      # Firebase platform options
│   └── main.dart                                  # Application entry point
├── firestore.indexes.json                         # Composite index definitions
├── firestore.rules                                # Firestore security policies
├── pubspec.yaml                                   # Dependency specifications
└── .gitignore                                     # Clean Git ignore rules
```
