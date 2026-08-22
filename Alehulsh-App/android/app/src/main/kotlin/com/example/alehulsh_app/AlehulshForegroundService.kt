package com.example.alehulsh_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.GeoPoint
import com.google.firebase.firestore.ListenerRegistration

/**
 * Sticky foreground service:
 * - 24/7 Screen transition listener: Detects rapid power button toggles when screen is closed.
 * - Listens to Firestore active_alerts and posts high-priority pings immediately.
 */
class AlehulshForegroundService : Service() {
    private var alertsReg: ListenerRegistration? = null
    private val notifiedIds = mutableSetOf<String>()
    private var pingListenerSeeded = false
    private var wakeLock: PowerManager.WakeLock? = null

    // Power Button Screen-Off counter
    // Each power-button press from ON state fires ACTION_SCREEN_OFF.
    // 5x presses from ON state = ~3 SCREEN_OFF events (ON→OFF→ON→OFF→ON→OFF pattern)
    // We also count SCREEN_ON presses as backup to handle ON→OFF→ON→OFF→ON (starts ON) pattern
    private var screenOffCount = 0
    private var screenAnyCount = 0
    private var firstScreenOffTime = 0L
    private var firstScreenAnyTime = 0L
    private var lastScreenTime = 0L

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val action = intent?.action
            val now = System.currentTimeMillis()

            // Android Emergency SOS detection for API 31+
            if (action == "android.intent.action.EMERGENCY_STATE_CHANGED" ||
                action == "android.telephony.action.SECRET_CODE") {
                Log.d("AlehulshForeground", "🚨 Android Emergency State Changed! Dispatching SOS...")
                AlehulshSosDispatcher.trigger(this@AlehulshForegroundService, "5x Power Button Gesture")
                return
            }

            if (action == Intent.ACTION_SCREEN_OFF) {
                // Reset if too long since last event
                if (lastScreenTime > 0 && (now - lastScreenTime > 3000L)) {
                    screenOffCount = 0
                    screenAnyCount = 0
                    firstScreenOffTime = 0L
                    firstScreenAnyTime = 0L
                }
                if (firstScreenOffTime == 0L) firstScreenOffTime = now
                if (firstScreenAnyTime == 0L) firstScreenAnyTime = now
                screenOffCount++
                screenAnyCount++
                lastScreenTime = now
                Log.d("AlehulshForeground", "SCREEN_OFF #$screenOffCount elapsed=${now - firstScreenOffTime}ms")

                // 2 SCREEN_OFF events in rapid sequence (<= 2.5s) indicates rapid power clicks
                if (screenOffCount >= 2 && (now - firstScreenOffTime <= 2500L)) {
                    resetScreenCounters()
                    Log.d("AlehulshForeground", "🚨 2x SCREEN_OFF Confirmed (Rapid power clicks)! Dispatching SOS...")
                    AlehulshSosDispatcher.trigger(this@AlehulshForegroundService, "5x Power Button Gesture")
                    return
                }
            }

            if (action == Intent.ACTION_SCREEN_ON) {
                if (lastScreenTime > 0 && (now - lastScreenTime > 3000L)) {
                    screenOffCount = 0
                    screenAnyCount = 0
                    firstScreenOffTime = 0L
                    firstScreenAnyTime = 0L
                }
                if (firstScreenAnyTime == 0L) firstScreenAnyTime = now
                screenAnyCount++
                lastScreenTime = now
                Log.d("AlehulshForeground", "SCREEN_ON #$screenAnyCount elapsed=${now - firstScreenAnyTime}ms")

                // 3 screen toggles within 3.0s indicates rapid power presses
                if (screenAnyCount >= 3 && (now - firstScreenAnyTime <= 3000L)) {
                    resetScreenCounters()
                    Log.d("AlehulshForeground", "🚨 3x Rapid Screen Toggle Confirmed! Dispatching SOS...")
                    AlehulshSosDispatcher.trigger(this@AlehulshForegroundService, "5x Power Button Gesture")
                    return
                }
            }

            try {
                if (wakeLock?.isHeld != true) {
                    wakeLock?.acquire()
                }
            } catch (e: Exception) {
                Log.e("AlehulshForeground", "WakeLock error: ${e.message}")
            }
        }
    }

    private fun resetScreenCounters() {
        screenOffCount = 0
        screenAnyCount = 0
        firstScreenOffTime = 0L
        firstScreenAnyTime = 0L
        lastScreenTime = 0L
    }

    override fun onCreate() {
        super.onCreate()
        try {
            createChannels()
            startAsForeground()

            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Alehulsh::ForegroundWakeLock")
            wakeLock?.setReferenceCounted(false)
            try {
                wakeLock?.acquire()
            } catch (e: Exception) {
                Log.e("AlehulshForeground", "WakeLock acquire failed: ${e.message}")
            }

            val filter = IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_OFF)
                addAction(Intent.ACTION_SCREEN_ON)
                // Android 12+ Emergency SOS state change broadcast
                addAction("android.intent.action.EMERGENCY_STATE_CHANGED")
                addAction("android.telephony.action.SECRET_CODE")
            }
            // Screen events must be registered as not-exported but without RECEIVER_NOT_EXPORTED
            // restriction because ACTION_SCREEN_OFF/ON are protected system broadcasts
            try {
                registerReceiver(screenReceiver, filter)
            } catch (e: Exception) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    ContextCompat.registerReceiver(this, screenReceiver, filter, ContextCompat.RECEIVER_EXPORTED)
                }
            }
            startAlertPingListener()
        } catch (e: Exception) {
            Log.e("AlehulshForeground", "Error initializing service in onCreate: ${e.message}", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            startAsForeground()
            if (wakeLock?.isHeld != true) {
                wakeLock?.acquire()
            }
        } catch (e: Exception) {
            Log.e("AlehulshForeground", "Error in onStartCommand: ${e.message}")
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        try {
            unregisterReceiver(screenReceiver)
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {
        }
        alertsReg?.remove()
        super.onDestroy()
    }

    private fun startAsForeground() {
        try {
            val notification = NotificationCompat.Builder(this, CHANNEL_RADAR)
                .setContentTitle(getString(R.string.radar_notification_title))
                .setContentText(getString(R.string.radar_notification_text))
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setSilent(true)
                .build()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(RADAR_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(RADAR_ID, notification)
            }
        } catch (e: Exception) {
            Log.e("AlehulshForeground", "Failed to startAsForeground: ${e.message}", e)
        }
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_RADAR,
                getString(R.string.radar_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = getString(R.string.radar_channel_desc) }
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_PING,
                "Emergency Proximity Pings",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Instant SOS pings"
                enableVibration(true)
                enableLights(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
        )
    }

    private fun startAlertPingListener() {
        try {
            alertsReg = FirebaseFirestore.getInstance()
                .collection("active_alerts")
                .whereEqualTo("status", "active")
                .limit(25)
                .addSnapshotListener { snap, error ->
                    if (error != null || snap == null) return@addSnapshotListener
                    if (!pingListenerSeeded) {
                        for (doc in snap.documents) {
                            notifiedIds.add("${doc.id}_${doc.get("timestamp")}")
                        }
                        pingListenerSeeded = true
                        return@addSnapshotListener
                    }
                    val cachedUid = getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
                        .getString("flutter.active_user_uid", "").orEmpty()
                    val me = FirebaseAuth.getInstance().currentUser?.uid.orEmpty().ifEmpty { cachedUid }
                    val myEmail = FirebaseAuth.getInstance().currentUser?.email?.trim()?.lowercase().orEmpty()
                    val myLoc = lastKnownLocation()

                    for (doc in snap.documentChanges) {
                        if (doc.type != com.google.firebase.firestore.DocumentChange.Type.ADDED) continue
                        val data = doc.document.data
                        val status = data["status"]?.toString() ?: "active"
                        if (status != "active") continue
                        val alertId = doc.document.id
                        val senderId = data["userId"]?.toString().orEmpty().ifEmpty { alertId }
                        val pingKey = "${alertId}_${data["timestamp"]}"
                        if (!notifiedIds.add(pingKey)) continue

                        if (senderId == me || alertId == me || (cachedUid.isNotEmpty() && (senderId == cachedUid || alertId == cachedUid))) continue

                        val userName = data["userName"]?.toString()?.ifBlank { "Someone" } ?: "Someone"
                        val contact = isEmergencyContactMatch(data, me, myEmail)
                        val within500 = isWithin500m(data, myLoc)
                        if (!contact && !within500) continue

                        showPing(
                            alertId = alertId,
                            title = "$userName is requesting for help!!",
                            body = "Open Alehulsh Alerts to respond.",
                            isSender = false
                        )
                    }
                }
        } catch (e: Exception) {
            Log.e("AlehulshRadar", "Listener failed: ${e.message}")
        }
    }

    private fun isEmergencyContactMatch(data: Map<String, Any>, myUid: String, myEmail: String): Boolean {
        fun listOf(key: String): List<String> {
            val raw = data[key]
            return if (raw is List<*>) raw.mapNotNull { it?.toString()?.trim()?.lowercase() } else emptyList()
        }
        if (myEmail.isNotEmpty() && listOf("emergencyContactEmails").contains(myEmail)) return true
        if (myUid.isNotEmpty() && listOf("emergencyContactUids").contains(myUid.lowercase())) return true
        return false
    }

    @Suppress("MissingPermission")
    private fun isWithin500m(data: Map<String, Any>, myLoc: Location?): Boolean {
        if (myLoc == null) return false
        val lat = (data["latitude"] as? Number)?.toDouble()
        val lng = (data["longitude"] as? Number)?.toDouble()
        val geo = data["geo"] as? Map<*, *>
        val gp = geo?.get("geopoint") as? GeoPoint
        val aLat = lat ?: gp?.latitude ?: return false
        val aLng = lng ?: gp?.longitude ?: return false
        val result = FloatArray(1)
        Location.distanceBetween(myLoc.latitude, myLoc.longitude, aLat, aLng, result)
        return result[0] <= 500f
    }

    @Suppress("MissingPermission")
    private fun lastKnownLocation(): Location? {
        return try {
            val lm = getSystemService(LOCATION_SERVICE) as LocationManager
            lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
        } catch (_: Exception) {
            null
        }
    }

    private fun showPing(alertId: String, title: String, body: String, isSender: Boolean) {
        val prefs = getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
        val notifsEnabled = prefs.getBoolean("flutter.notifications_enabled", true)
        if (!isSender && !notifsEnabled) {
            Log.d("AlehulshForeground", "Notifications disabled in settings. Skipping ping.")
            return
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        launch.putExtra("open_alerts_tab", true)
        launch.putExtra("highlight_alert_id", alertId)
        val pending = PendingIntent.getActivity(
            this,
            alertId.hashCode(),
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_PING)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setDefaults(Notification.DEFAULT_ALL)
            .build()
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val id = if (isSender) SENDER_PING_ID else alertId.hashCode()
        nm.notify(id, notification)
    }

    companion object {
        private const val CHANNEL_RADAR = "alehulsh_radar_channel"
        private const val CHANNEL_PING = "emergency_ping_channel"
        private const val RADAR_ID = 71001
        private const val SENDER_PING_ID = 71002

        fun start(context: Context) {
            try {
                val intent = Intent(context, AlehulshForegroundService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                Log.e("AlehulshForeground", "Failed to start foreground service: ${e.message}")
            }
        }
    }
}
