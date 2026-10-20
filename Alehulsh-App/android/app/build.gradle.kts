import java.util.Base64

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    id("com.google.gms.google-services")
}

/**
 * Reads a Flutter --dart-define from the Gradle side.
 *
 * `flutter build` forwards them as the `dart-defines` project property: a
 * comma-separated list of base64-encoded KEY=VALUE pairs
 * (flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt).
 *
 * Returns false when the property is absent, which is the case for every build
 * that does not explicitly ask for it - including all release builds.
 */
fun dartDefineEnabled(key: String): Boolean {
    val raw = project.findProperty("dart-defines")?.toString() ?: return false
    return raw.split(",").any { encoded ->
        runCatching { String(Base64.getDecoder().decode(encoded.trim())) }
            .getOrDefault("") == "$key=true"
    }
}

android {
    namespace = "com.example.alehulsh_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    // ---------------------------------------------------------------------
    // Environment flavours.
    //
    // Defining ANY flavour removes the plain `assembleDebug` task, so a build
    // that does not name one fails outright rather than quietly picking a
    // project. That is the enforcement mechanism - production must be asked
    // for by name too.
    //
    // EXPECTED_FIREBASE_PROJECT records the project this binary is BUILT for.
    //
    // NOT ENFORCED AT RUNTIME. Nothing reads this field. The intended check -
    // compare it against the project Firebase actually resolved and refuse to
    // write when they disagree - is NOT implemented, so a stale or mismatched
    // google-services.json is not caught at the point of writing.
    //
    // What exists instead is narrower, and must not be mistaken for it: `dev`
    // carries its own applicationId, so a dev google-services.json without a
    // matching Android app entry fails the build. That catches a misconfigured
    // DEV build early. It does NOT isolate SOS writes - a prod-flavour binary
    // built against the wrong project would still write wherever Firebase
    // resolved - and it constrains nothing about which Firestore the native
    // services reach once the app is running.
    // ---------------------------------------------------------------------
    flavorDimensions += "env"

    productFlavors {
        create("prod") {
            dimension = "env"
            // Unchanged, so existing installations are undisturbed.
            buildConfigField("String", "EXPECTED_FIREBASE_PROJECT", "\"alehulsh-app\"")
        }
        create("dev") {
            dimension = "env"
            // Distinct package so dev and prod coexist on one device. The dev
            // Firebase Android app MUST be registered under this exact id or
            // google-services processing fails - which is the desired
            // fail-closed behaviour, not a bug.
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            buildConfigField("String", "EXPECTED_FIREBASE_PROJECT", "\"alehulsh-dev\"")
        }
    }

    buildFeatures {
        // Required so USE_FIREBASE_EMULATORS below reaches the Kotlin sources.
        buildConfig = true
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.example.alehulsh_app"

        // Mirrors the Dart --dart-define of the same name into native code.
        //
        // The native services talk to Firestore directly, without going through
        // FlutterFire, so lib/dev_config.dart cannot reach them: an emulator
        // build was still attaching a live listener to PRODUCTION active_alerts
        // and the native SOS path would still have written there.
        //
        // Decided at COMPILE time rather than through a runtime flag, because
        // MainActivity.onCreate starts the foreground service before Dart runs,
        // so any value Dart could set would always arrive too late on the first
        // launch - the launch that matters.
        //
        // A release build passes no defines, so this is false and production
        // behaviour is byte-for-byte unchanged.
        buildConfigField(
            "boolean",
            "USE_FIREBASE_EMULATORS",
            dartDefineEnabled("USE_FIREBASE_EMULATORS").toString(),
        )
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        multiDexEnabled = true
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    // Firebase Android SDK — required by native Kotlin SOS services
    implementation(platform("com.google.firebase:firebase-bom:33.8.0"))
    implementation("com.google.firebase:firebase-auth-ktx")
    implementation("com.google.firebase:firebase-firestore-ktx")
    // AndroidX Core for NotificationCompat used in foreground service
    implementation("androidx.core:core-ktx:1.16.0")

    // JUnit 4, test-only, for the SosLocationDecision unit tests.
    //
    // The project had no Kotlin test configuration at all. This is the
    // smallest addition that runs the real production decision on the JVM:
    // SosLocationDecision deliberately takes primitives and touches no Android
    // or Firebase type, so no Robolectric, no instrumentation and no mocking
    // framework is needed. testImplementation never ships in the APK.
    testImplementation("junit:junit:4.13.2")
}

flutter {
    source = "../.."
}

// ---------------------------------------------------------------------------
// Fail closed when no environment was named.
//
// Defining flavours is NOT sufficient on its own: `flutter build apk --debug`
// runs `assembleDebug`, which builds EVERY flavour rather than failing, so a
// forgotten --flavor would quietly produce a production binary.
//
// Flutter encodes the chosen flavour in the task name (assembleProdDebug),
// so the requested task names are the reliable signal. A build that asks for
// an assemble/bundle/install task without naming an environment stops here.
// ---------------------------------------------------------------------------
gradle.taskGraph.whenReady {
    val requested = gradle.startParameter.taskNames
    val unscoped = requested.filter { raw ->
        val task = raw.substringAfterLast(':')
        val isPackaging = task.startsWith("assemble") ||
            task.startsWith("bundle") ||
            task.startsWith("install")
        isPackaging &&
            !task.contains("Dev", ignoreCase = true) &&
            !task.contains("Prod", ignoreCase = true)
    }
    if (unscoped.isNotEmpty()) {
        throw GradleException(
            """
            |No Firebase environment selected for: ${unscoped.joinToString(", ")}
            |
            |Alehulsh will not build a package without being told which Firebase
            |project it is for. Production must be asked for by name too.
            |
            |  flutter build apk --debug --flavor dev    (alehulsh-dev,  app id .dev)
            |  flutter build apk --debug --flavor prod   (alehulsh-app,  production)
            |  flutter run --flavor dev
            """.trimMargin()
        )
    }
}
