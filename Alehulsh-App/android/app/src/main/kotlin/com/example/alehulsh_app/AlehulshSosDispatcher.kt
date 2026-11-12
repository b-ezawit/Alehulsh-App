package com.example.alehulsh_app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.SystemClock
import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.GeoPoint
import com.google.firebase.firestore.SetOptions
import io.flutter.plugin.common.MethodChannel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Single entry point for hardware / Android-OS SOS.
 * Android "Cancel emergency" is ignored on purpose — only the Flutter app can cancel.
 */
object AlehulshSosDispatcher {
    private const val TAG = "AlehulshSosDispatcher"
    private const val PREFS = "alehulsh_sos"
    private const val DEBOUNCE_MS = 20000L


    @Volatile
    var methodChannel: MethodChannel? = null

    @Volatile
    private var lastTriggerAt = 0L
    private val trustedExecutor by lazy {Executors.newSingleThreadExecutor()}

    fun recordCancellation() {
        // A new genuine emergency must not be disabled by cancellation.
        lastTriggerAt = 0L
    }

    fun trigger(context: Context, source: String) {
        val now = System.currentTimeMillis()
        if (now - lastTriggerAt < DEBOUNCE_MS) {
            Log.d(TAG, "Debounced SOS from $source (cooldown active)")
            return
        }
        lastTriggerAt = now

        if(BuildConfig.TRUSTED_API_REQUIRED){
            val app=context.applicationContext
            trustedExecutor.execute {
                var requestId:String?=null
                var owner:String?=null
                try {
                    val saved=NativeTrustedSos.recovery(app).enqueue();requestId=saved.requestId;owner=saved.ownerSubject
                    val scheduled=NativeTrustedSos.schedule(app)
                    Log.i(TAG,if(scheduled)"SOS saved; recovery scheduled"else"SOS saved; foreground recovery required")
                }catch(_:Exception){Log.w(TAG,"Native SOS could not be saved; foreground action required")}
                Handler(Looper.getMainLooper()).post {notifyFlutter(source,requestId,owner);bringAppToForeground(app)}
            };return
        }
        notifyFlutter(source)
        if (!BuildConfig.TRUSTED_API_REQUIRED) writeFirestoreAlert(context, source)
        bringAppToForeground(context)
    }

    private fun notifyFlutter(source: String,requestId:String?=null,owner:String?=null) {
        try {
            methodChannel?.invokeMethod(
                "onHardwareSOS",
                mapOf("source" to source,"requestId" to requestId,"ownerSubject" to owner, "independentOfOsCancel" to true)
            )
        } catch (e: Exception) {
            Log.w(TAG, "Flutter channel not ready: ${e.javaClass.simpleName}")
        }
    }

    private fun bringAppToForeground(context: Context) {
        try {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            launch?.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
            launch?.putExtra("open_alerts_tab", true)
            launch?.putExtra("hardware_sos", true)
            if (launch != null) {
                context.startActivity(launch)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not open app: ${e.javaClass.simpleName}")
        }
    }

    private fun setLocalSosActive(context: Context, alertId: String) {
        try {
            val prefs = context.getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
            prefs.edit()
                .putBoolean("flutter.is_sos_active:$alertId", true)
                .putString("flutter.active_alert_id:$alertId", alertId)
                                .apply()
        } catch (e: Exception) {
            Log.w(TAG, "Could not set local SOS state: ${e.javaClass.simpleName}")
        }
    }

    @Suppress("MissingPermission")
    private fun writeFirestoreAlert(context: Context, source: String) {
        if(!BuildConfig.DEBUG || BuildConfig.TRUSTED_API_REQUIRED) return
        // A WRITE to the live project from a test build would be worse than a
        // read: it would put a fabricated alert in front of real responders.
        // This path does not go through FlutterFire, so the Dart emulator
        // switch does not cover it.
        if (BuildConfig.USE_FIREBASE_EMULATORS) {
            Log.w(TAG, "Emulator build: native SOS write suppressed (no live-project access).")
            return
        }

        // And the project this binary was BUILT for must be the one Firebase
        // resolved. A stale or wrong google-services.json would otherwise put
        // a test SOS in front of real responders, or a real SOS into a project
        // nobody is watching - silently, in both directions.
        //
        // Returning here means notifyFlutter() has already run, so the Dart
        // SOS path still executes and reports its own outcome. What is skipped
        // is this write AND showSenderConfirmation(), which is only reached
        // from the write's success callback - so a refusal cannot produce
        // "Your Alert has been sent."
        if (!FirebaseProjectGuard.allows("native SOS write")) return

        try {
            val user = FirebaseAuth.getInstance().currentUser
            val uid = user?.uid ?: return
            fun stillOwner(): Boolean = FirebaseAuth.getInstance().currentUser?.uid == uid
            setLocalSosActive(context, uid)

            val db = FirebaseFirestore.getInstance()

            // 1. Check if user already has an active alert (do NOT overwrite voice note or user note)
            db.collection("active_alerts").document(uid).get()
                .addOnSuccessListener { existingSnap ->
                    if (!stillOwner()) return@addOnSuccessListener
                    if (existingSnap.exists() && existingSnap.getString("status") in setOf("active", "escalated") &&
                        (existingSnap.getTimestamp("expiresAtTimestamp")?.toDate()?.time ?: 0L) > System.currentTimeMillis()) {
                        Log.d(TAG, "Active SOS alert already exists for $uid; preserving voice notes & message.")
                        return@addOnSuccessListener
                    }

                    // 2. Otherwise create initial alert from profile
                    db.collection("users").document(uid).get()
                        .addOnSuccessListener { userSnap ->
                            if (!stillOwner()) return@addOnSuccessListener
                            val data = userSnap.data ?: emptyMap()
                            // No fallback coordinate. This used to default to
                            // (9.0125, 38.7636) - Addis Ababa city centre - so an SOS raised
                            // with no GPS asserted she was downtown, and responders would be
                            // sent to the wrong place while the alert looked complete.
                            //
                            // Null here is a real, supported state: latitude/longitude are
                            // nullable in the Dart model, AlertService writes them as null,
                            // and AlehulshForegroundService already reads them null-safely
                            // (`?: return false`), so an unlocatable alert is simply never
                            // proximity-matched. The alert itself is still raised - her
                            // emergency contacts are matched by explicit link, not by
                            // distance, so losing GPS must not cost her the alert.
                            val sharing = data["isLocationSharingEnabled"] == true && (data["locationSharingConsentVersion"] as? Number)?.toInt() == 1
                            val loc = if (sharing) lastKnownLocation(context) else null

                            // Age from the MONOTONIC clock, not wall time. Location.time is
                            // wall-clock and moves when the device clock does - NTP sync, a
                            // manual change, a timezone-confused ROM - which previously could
                            // make a stale fix look current, or a current one look negative.
                            // elapsedRealtimeNanos counts from boot and cannot be rewritten.
                            //
                            // Some providers leave it unset (0); that is reported as unknown
                            // age rather than as an enormous one.
                            val fixAgeMs: Long? = loc?.let {
                                val stamped = it.elapsedRealtimeNanos
                                if (stamped <= 0L) {
                                    null
                                } else {
                                    (SystemClock.elapsedRealtimeNanos() - stamped) / 1_000_000L
                                }
                            }

                            // Accuracy is passed as EVIDENCE the provider measured something,
                            // not as a quality bar - no fix is discarded for being imprecise.
                            // hasAccuracy() distinguishes "no accuracy reported" from 0.0.
                            val accuracyMeters: Double? =
                                loc?.takeIf { it.hasAccuracy() }?.accuracy?.toDouble()

                            val fix = SosLocationDecision.decide(
                                latitude = loc?.latitude,
                                longitude = loc?.longitude,
                                ageMs = fixAgeMs,
                                accuracyMeters = accuracyMeters,
                            )
                            val lat: Double? = fix.latitude
                            val lng: Double? = fix.longitude
                            val iso = utcIsoNow()


                            val fullName = (data["fullName"] as? String)?.takeIf { it.isNotBlank() }
                                ?: user?.displayName
                                ?: "Alehulsh User"
                            val email = (data["email"] as? String) ?: (user?.email ?: "")
                            val phone = (data["phoneNumber"] as? String) ?: ""
                            val contacts = parseContacts(data["emergencyContacts"])
                            val cal = java.util.Calendar.getInstance()
                            cal.add(java.util.Calendar.HOUR, 2)
                            val expiresAtDate = cal.time
                            val expiresAtIso = utcIsoFromDate(expiresAtDate)
                            // Both decided in SosLocationDecision, which is
                            // unit tested. Empty geohash and the label are part
                            // of the same decision as the coordinates, so they
                            // cannot drift apart.
                            val hashVal = fix.geohash
                            val locationLabel = fix.label

                            // Any? so latitude/longitude can be written as real
                            // nulls. Firestore stores a null field, and the Dart
                            // reader treats absent and null identically
                            // ((map['latitude'] as num?)?.toDouble()).
                            val alert = hashMapOf<String, Any?>(
                                "id" to uid,
                                "userId" to uid,
                                "userName" to fullName,
                                "userAvatar" to (fullName.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "U"),
                                "alerterPhone" to phone,
                                "alerterEmail" to email,
                                "latitude" to lat,
                                "longitude" to lng,
                                "locationName" to locationLabel,
                                "timestamp" to iso,
                                "expiresAt" to expiresAtIso,
                                "expiresAtTimestamp" to com.google.firebase.Timestamp(expiresAtDate),
                                "ttlHours" to 2,
                                "geohash" to hashVal,
                                "category" to "Urgent Distress Alert",
                                "message" to "EMERGENCY DISTRESS TRIGGERED! Please send help immediately!",
                                "isUrgent" to true,
                                "status" to "active",
                                "voiceNotes" to emptyList<Any>(),
                                "responders" to emptyList<String>(),
                                "emergencyContactEmails" to contacts.emails,
                                "emergencyContactPhones" to contacts.phones,
                                "emergencyContactNames" to contacts.names,
                                "emergencyContactUids" to contacts.ids,
                                "hardwareSource" to source,
                                "osCancelIndependent" to true,
                            )

                            // Added only when there is a genuine fix. Writing a
                            // placeholder GeoPoint would make an unlocatable
                            // alert queryable by proximity at a place she is
                            // not - the exact failure the nulls above prevent.
                            // EmergencyAlert.toMap omits the key the same way.
                            // Local vals so Kotlin can smart-cast; hasLocation
                            // is a getter and does not narrow the type.
                            val geoLat = fix.latitude
                            val geoLng = fix.longitude
                            if (geoLat != null && geoLng != null) {
                                alert["geo"] = hashMapOf(
                                    "geohash" to hashVal,
                                    "geopoint" to GeoPoint(geoLat, geoLng)
                                )
                            }

                            db.collection("active_alerts").document(uid)
                                .set(alert, SetOptions.merge())
                                .addOnSuccessListener {
                                    if (!stillOwner()) return@addOnSuccessListener
                                    Log.d(TAG, "Native initial SOS acknowledged")
                                    showSenderConfirmation(context)
                                    db.collection("users").document(uid).set(
                                        mapOf(
                                            "alertsTriggeredCount" to FieldValue.increment(1),
                                            "lastActiveAt" to iso
                                        ),
                                        SetOptions.merge()
                                    )
                                }.addOnFailureListener { Log.w(TAG, "Native SOS write could not be confirmed; Flutter recovery remains available") }
                        }.addOnFailureListener { Log.w(TAG, "Native profile read unavailable; Flutter recovery remains available") }
                }.addOnFailureListener { Log.w(TAG, "Native incident read unavailable; Flutter recovery remains available") }
        } catch (e: Exception) {
            Log.e(TAG, "writeFirestoreAlert failed: ${e.javaClass.simpleName}")
        }
    }

    @Suppress("MissingPermission")
    private fun lastKnownLocation(context: Context): Location? {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        val gps = try { lm.getLastKnownLocation(LocationManager.GPS_PROVIDER) } catch (_: Exception) { null }
        val net = try { lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER) } catch (_: Exception) { null }
        val pass = try { lm.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER) } catch (_: Exception) { null }
        val candidates = listOfNotNull(gps, net, pass)
        return candidates.maxByOrNull { it.time }
    }

    private fun showSenderConfirmation(context: Context) {
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    "emergency_ping_channel",
                    "Emergency Proximity Pings",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Urgent alerts from nearby women requesting help"
                    enableVibration(true)
                    setShowBadge(true)
                }
                nm.createNotificationChannel(channel)
            }

            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val pending = if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                launch.putExtra("open_alerts_tab", true)
                android.app.PendingIntent.getActivity(
                    context,
                    71002,
                    launch,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
                )
            } else null

            // The lock-screen face of this notification carries NO mention of
            // an alert. VISIBILITY_PUBLIC put "Your Alert has been sent" on the
            // lock screen, so a coercer holding her phone learned she had
            // called for help - the single most dangerous thing this app can
            // disclose. The full text is still shown once the device is
            // unlocked, so she loses no confirmation.
            //
            // LIMIT, not a guarantee: VISIBILITY_PRIVATE only redacts on a
            // SECURE lock screen. With no PIN, pattern or biometric set,
            // Android shows the real content regardless and nothing here can
            // prevent that.
            val redacted = NotificationCompat.Builder(context, "emergency_ping_channel")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(context.getString(R.string.lockscreen_redacted_title))
                .setContentText(context.getString(R.string.lockscreen_redacted_text))
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .build()

            val notification = NotificationCompat.Builder(context, "emergency_ping_channel")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("🚨 Your Alert has been sent.")
                .setContentText("Emergency SOS broadcast sent to nearby network and contacts.")
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(redacted)
                .setAutoCancel(true)
                .setDefaults(android.app.Notification.DEFAULT_ALL)
                .apply { if (pending != null) setContentIntent(pending) }
                .build()

            nm.notify(71002, notification)
        } catch (e: Exception) {
            Log.w(TAG, "Sender confirmation notification failed: ${e.javaClass.simpleName}")
        }
    }

    private fun utcIsoNow(): String {
        return utcIsoFromDate(Date())
    }

    private fun utcIsoFromDate(date: Date): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(date)
    }

    private data class ContactLists(
        val emails: List<String>,
        val phones: List<String>,
        val names: List<String>,
        val ids: List<String>,
    )

    private fun parseContacts(raw: Any?): ContactLists {
        val emails = mutableListOf<String>()
        val phones = mutableListOf<String>()
        val names = mutableListOf<String>()
        val ids = mutableListOf<String>()
        if (raw is List<*>) {
            for (item in raw) {
                if (item !is Map<*, *>) continue
                val email = item["email"]?.toString()?.trim()?.lowercase().orEmpty()
                val phone = item["phone"]?.toString()?.replace(" ", "")?.replace("-", "").orEmpty()
                val name = item["name"]?.toString()?.trim()?.lowercase().orEmpty()
                val id = item["id"]?.toString()?.trim().orEmpty()
                if (email.isNotEmpty()) emails.add(email)
                if (phone.isNotEmpty()) phones.add(phone)
                if (name.isNotEmpty()) names.add(name)
                if (id.isNotEmpty()) ids.add(id)
            }
        }
        return ContactLists(emails, phones, names, ids)
    }
}
