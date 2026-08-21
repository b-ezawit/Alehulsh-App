import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb, TargetPlatform;

/// Default [FirebaseOptions] for use with your Firebase apps.
class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      return web;
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      case TargetPlatform.macOS:
        throw UnsupportedError(
          'DefaultFirebaseOptions have not been configured for macos - '
          'you can reconfigure this by running the FlutterFire CLI.',
        );
      case TargetPlatform.windows:
        throw UnsupportedError(
          'DefaultFirebaseOptions have not been configured for windows - '
          'you can reconfigure this by running the FlutterFire CLI.',
        );
      case TargetPlatform.linux:
        throw UnsupportedError(
          'DefaultFirebaseOptions have not been configured for linux - '
          'you can reconfigure this by running the FlutterFire CLI.',
        );
      default:
        throw UnsupportedError(
          'DefaultFirebaseOptions are not supported for this platform.',
        );
    }
  }

  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'AIzaSyBozC_DuvAGh51F2KV8ex8DwT67TOR9bqk',
    appId: '1:276071022271:web:983f70c2f45e3aca12500a',
    messagingSenderId: '276071022271',
    projectId: 'alehulsh-app',
    authDomain: 'alehulsh-app.firebaseapp.com',
    storageBucket: 'alehulsh-app.firebasestorage.app',
    measurementId: 'G-REEZ96BRWK',
  );

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyDIzsusGzcBaWtsY0CmFqYnPhyw2zhg6_g',
    appId: '1:276071022271:android:768378ccd98742d612500a',
    messagingSenderId: '276071022271',
    projectId: 'alehulsh-app',
    storageBucket: 'alehulsh-app.firebasestorage.app',
  );

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'AIzaSyApEQNHzjXvc4W1khYIWpcm54rmJPx2SM0',
    appId: '1:276071022271:ios:b900b9fd21ae710112500a',
    messagingSenderId: '276071022271',
    projectId: 'alehulsh-app',
    storageBucket: 'alehulsh-app.firebasestorage.app',
    iosBundleId: 'com.example.alehulshApp',
  );
}
