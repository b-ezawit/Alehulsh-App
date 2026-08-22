package com.example.alehulsh_app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.os.Build
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
    private const val KEY_PENDING = "pending_hardware_sos"
    private const val KEY_PENDING_SOURCE = "pending_hardware_sos_source"
    private const val DEBOUNCE_MS = 8000L

    @Volatile
    var methodChannel: MethodChannel? = null

    @Volatile
    private var lastTriggerAt = 0L

    fun trigger(context: Context, source: String) {
        val now = System.currentTimeMillis()
        if (now - lastTriggerAt < DEBOUNCE_MS) {
            Log.d(TAG, "Debounced SOS from $source")
            return
        }
        lastTriggerAt = now

        persistPending(context, source)
        notifyFlutter(source)
        writeFirestoreAlert(context, source)
        bringAppToForeground(context)
    }

    fun consumePendingSource(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val pending = prefs.getBoolean(KEY_PENDING, false)
        if (!pending) return null
        val source = prefs.getString(KEY_PENDING_SOURCE, "Emergency Shake Gesture (4s/3x)")
        prefs.edit().putBoolean(KEY_PENDING, false).apply()
        return source
    }

    private fun persistPending(context: Context, source: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_PENDING, true)
            .putString(KEY_PENDING_SOURCE, source)
            .apply()
    }

    private fun notifyFlutter(source: String) {
        try {
            methodChannel?.invokeMethod(
                "onHardwareSOS",
                mapOf("source" to source, "independentOfOsCancel" to true)
            )
        } catch (e: Exception) {
            Log.w(TAG, "Flutter channel not ready: ${e.message}")
        }
    }

    private fun bringAppToForeground(context: Context) {
        try {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            launch?.addFlags(
                android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                    android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
            launch?.putExtra("open_alerts_tab", true)
            launch?.putExtra("hardware_sos", true)
            if (launch != null) {
                context.startActivity(launch)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not open app: ${e.message}")
        }
    }

    private fun getCachedOrDeviceId(context: Context): String {
        val prefs = context.getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
        val cachedUid = prefs.getString("flutter.active_user_uid", null)
        if (!cachedUid.isNullOrBlank()) return cachedUid
        val devicePrefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        var devId = devicePrefs.getString("device_user_id", null)
        if (devId.isNullOrBlank()) {
            devId = "device_" + java.util.UUID.randomUUID().toString().take(8)
            devicePrefs.edit().putString("device_user_id", devId).apply()
        }
        return devId
    }

    private fun setLocalSosActive(context: Context, alertId: String) {
        val prefs = context.getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
        prefs.edit()
            .putBoolean("flutter.is_sos_active", true)
            .putString("flutter.active_alert_id", alertId)
            .apply()
    }

    @Suppress("MissingPermission")
    private fun writeFirestoreAlert(context: Context, source: String) {
        try {
            val user = FirebaseAuth.getInstance().currentUser
            val uid = user?.uid ?: getCachedOrDeviceId(context)
            setLocalSosActive(context, uid)

            val db = FirebaseFirestore.getInstance()
            val loc = lastKnownLocation(context)
            val lat = loc?.latitude ?: 9.0125
            val lng = loc?.longitude ?: 38.7636
            val iso = utcIsoNow()

            // 1. Check if user already has an active alert (do NOT overwrite voice note or user note)
            db.collection("active_alerts").document(uid).get()
                .addOnSuccessListener { existingSnap ->
                    if (existingSnap.exists() && existingSnap.getString("status") == "active") {
                        Log.d(TAG, "Active SOS alert already exists for $uid; preserving voice notes & message.")
                        return@addOnSuccessListener
                    }

                    // 2. Otherwise create initial alert from profile
                    db.collection("users").document(uid).get()
                        .addOnSuccessListener { userSnap ->
                            val data = userSnap.data ?: emptyMap()
                            val fullName = (data["fullName"] as? String)?.takeIf { it.isNotBlank() }
                                ?: user?.displayName
                                ?: "Alehulsh User"
                            val email = (data["email"] as? String) ?: (user?.email ?: "")
                            val phone = (data["phoneNumber"] as? String) ?: ""
                            val contacts = parseContacts(data["emergencyContacts"])

                            val alert = hashMapOf<String, Any>(
                                "id" to uid,
                                "userId" to uid,
                                "userName" to fullName,
                                "userAvatar" to (fullName.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "U"),
                                "alerterPhone" to phone,
                                "alerterEmail" to email,
                                "latitude" to lat,
                                "longitude" to lng,
                                "locationName" to "Live GPS",
                                "timestamp" to iso,
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
                                "geo" to hashMapOf(
                                    "geohash" to GeoHash.encode(lat, lng, 9),
                                    "geopoint" to GeoPoint(lat, lng)
                                ),
                                "hardwareSource" to source,
                                "osCancelIndependent" to true,
                            )

                            db.collection("active_alerts").document(uid)
                                .set(alert, SetOptions.merge())
                                .addOnSuccessListener {
                                    Log.d(TAG, "Native initial SOS written for $uid")
                                    showSenderConfirmation(context)
                                    db.collection("users").document(uid).set(
                                        mapOf(
                                            "alertsTriggeredCount" to FieldValue.increment(1),
                                            "lastActiveAt" to iso
                                        ),
                                        SetOptions.merge()
                                    )
                                }
                                .addOnFailureListener { e ->
                                    Log.e(TAG, "Native SOS write failed: ${e.message}")
                                }
                        }
                        .addOnFailureListener { e ->
                            Log.e(TAG, "Profile fetch failed: ${e.message}")
                        }
                }
                .addOnFailureListener { e ->
                    Log.e(TAG, "Active alert check failed: ${e.message}")
                }
        } catch (e: Exception) {
            Log.e(TAG, "writeFirestoreAlert: ${e.message}")
        }
    }

    @Suppress("MissingPermission")
    private fun lastKnownLocation(context: Context): Location? {
        return try {
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            val gps = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
            val net = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            when {
                gps != null && net != null -> if (gps.time >= net.time) gps else net
                gps != null -> gps
                else -> net
            }
        } catch (_: Exception) {
            null
        }
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
                    description = "Instant SOS pings"
                    enableVibration(true)
                    enableLights(true)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                }
                nm.createNotificationChannel(channel)
            }

            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            launch?.addFlags(
                Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            )
            launch?.putExtra("open_alerts_tab", true)
            val pending = if (launch != null) {
                android.app.PendingIntent.getActivity(
                    context, 71002, launch,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
                )
            } else null

            val notification = NotificationCompat.Builder(context, "emergency_ping_channel")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("🚨 Your Alert has been sent.")
                .setContentText("Emergency SOS broadcast sent to nearby network and contacts.")
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setDefaults(android.app.Notification.DEFAULT_ALL)
                .apply { if (pending != null) setContentIntent(pending) }
                .build()

            nm.notify(71002, notification)
        } catch (e: Exception) {
            Log.w(TAG, "Sender confirmation notification failed: ${e.message}")
        }
    }

    private fun utcIsoNow(): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date())
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
