import java.util.Base64
import java.util.Properties
import java.net.URI

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
fun dartDefineValue(key: String): String? {
    val raw = project.findProperty("dart-defines")?.toString() ?: return null
    return raw.split(",").mapNotNull { encoded ->
        runCatching { String(Base64.getDecoder().decode(encoded.trim())) }.getOrNull()
    }.lastOrNull { it.startsWith("$key=") }?.substringAfter("=")
}

fun dartDefineEnabled(key: String): Boolean {
    val raw = project.findProperty("dart-defines")?.toString() ?: return false
    return raw.split(",").any { encoded ->
        runCatching { String(Base64.getDecoder().decode(encoded.trim())) }
            .getOrDefault("") == "$key=true"
    }
}

// ---------------------------------------------------------------------------
// Release signing credentials, from a file that is NOT in version control.
//
// `key.properties` is already gitignored, along with *.keystore and *.jks. No
// credential value appears in this repository and none is invented here: if
// the file is absent, a release build FAILS rather than producing an artifact
// signed with something else.
//
// Required keys: storeFile, storePassword, keyAlias, keyPassword.
// storeFile is resolved relative to the `android/` directory.
// ---------------------------------------------------------------------------
fun publicOriginDefine(prefix:String):String {
    val env=dartDefineValue("FIREBASE_ENV")?.uppercase() ?: return "\"\""
    if(env !in setOf("DEV","PROD"))return "\"\""
    val raw=dartDefineValue("${prefix}_$env")?:return "\"\""
    val uri=runCatching { URI(raw) }.getOrNull()?:return "\"\""
    if(uri.scheme!="https"||uri.host==null||uri.rawUserInfo!=null||uri.rawQuery!=null||uri.rawFragment!=null||uri.rawPath !in listOf("","/"))return "\"\""
    val canonical=URI(uri.scheme.lowercase(),null,uri.host.lowercase(),if(uri.port==443)-1 else uri.port,null,null,null).toString()
    return "\""+canonical.replace("\\","\\\\").replace("\"","\\\"")+"\""
}
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}
val releaseSigningKeys = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
val releaseSigningAvailable = keystorePropertiesFile.exists() &&
    releaseSigningKeys.all { !keystoreProperties.getProperty(it).isNullOrBlank() }

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
    // EXPECTED_FIREBASE_PROJECT records the project this binary is BUILT for,
    // and IS enforced at runtime: FirebaseProjectGuard compares it against
    // FirebaseApp.getInstance().options.projectId and refuses the operation
    // when they disagree. Both native Firebase entry points are gated - the
    // SOS write in AlehulshSosDispatcher and the alert listener in
    // AlehulshForegroundService. A missing value on either side is a refusal
    // too, so the gate fails closed rather than open.
    //
    // The decision is in FirebaseProjectDecision, unit-tested on the JVM.
    // Those tests prove the DECISION; they prove nothing about device
    // behaviour - that the right google-services.json is packaged, or that a
    // real device refuses a real write - which needs an instrumented run on
    // hardware and has not been done.
    //
    // Separately, `dev` carries its own applicationId, so a dev
    // google-services.json without a matching Android app entry fails the
    // build. That is a build-time check and is not what isolates SOS writes.
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
        buildConfigField("String","TRUSTED_API_ORIGIN",publicOriginDefine("ALEHULSH_API_ORIGIN"))
        buildConfigField("String","TRUSTED_AUTH_ORIGIN",publicOriginDefine("ALEHULSH_SUPABASE_URL"))
        // Physical key delivery is OEM-dependent and has not passed device gates.
        // Even an opt-in define cannot enable this path in a release build.
        buildConfigField("boolean", "TRUSTED_API_REQUIRED", ((dartDefineValue("ALEHULSH_DATA_ACCESS") ?: "firestore") != "firestore").toString())
        buildConfigField("boolean", "HARDWARE_SOS_EXPERIMENTAL", dartDefineEnabled("HARDWARE_SOS_EXPERIMENTAL").toString())
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

    signingConfigs {
        if (releaseSigningAvailable) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            buildConfigField("boolean", "TRUSTED_API_REQUIRED", "true")
            // Previously `signingConfigs.getByName("debug")`, so EVERY release
            // build was signed with the debug key - a key whose private half
            // ships with the Android SDK on every developer machine on earth.
            // Anyone could have produced an update that Android would accept
            // as this app, for a safety application handling emergency
            // alerts, location and recordings.
            //
            // Now: the real config when credentials exist, and otherwise NO
            // config, with the build failed outright below. Debug builds are
            // untouched and still use the debug key, which is what it is for.
            signingConfig = if (releaseSigningAvailable) {
                signingConfigs.getByName("release")
            } else {
                null
            }
        }
    }
}

// Fail a release build that has no signing credentials, rather than letting it
// emit an unsigned artifact that looks like a release.
//
// Checked on the task graph rather than at configuration time, so `flutter
// run`, debug builds and the unit-test tasks are unaffected by the absence of
// a keystore - only a request to package a release is refused.
gradle.taskGraph.whenReady {
    if (releaseSigningAvailable) return@whenReady
    val offending = allTasks.map { it.name }.firstOrNull { name ->
        name.contains("Release") &&
            (name.startsWith("package") || name.startsWith("assemble") || name.startsWith("bundle"))
    } ?: return@whenReady

    val missing = if (!keystorePropertiesFile.exists()) {
        "android/key.properties does not exist"
    } else {
        "android/key.properties is missing or blank for: " +
            releaseSigningKeys.filter { keystoreProperties.getProperty(it).isNullOrBlank() }
    }
    throw GradleException(
        "Refusing to build a release artifact without release signing credentials " +
            "(task '$offending'). $missing\n" +
            "Create android/key.properties — it is gitignored — with storeFile, " +
            "storePassword, keyAlias and keyPassword. storeFile is relative to android/.\n" +
            "This build will NOT fall back to the debug signing key: the debug private " +
            "key is shipped with the Android SDK, so anyone could sign an update that " +
            "Android accepts as this app.",
    )
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
