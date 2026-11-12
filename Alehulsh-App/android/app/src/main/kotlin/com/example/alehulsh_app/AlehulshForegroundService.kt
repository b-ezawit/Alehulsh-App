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
 * Legacy alert listener only. Hardware events are handled by the gated key source.
 * - Listens to Firestore active_alerts and posts high-priority pings immediately.
 */
class AlehulshForegroundService : Service() {
    private var alertsReg: ListenerRegistration? = null
    private val notifiedIds = mutableSetOf<String>()
    private var pingListenerSeeded = false
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        try {
            createChannels()
            startAsForeground()

            startAlertPingListener()
        } catch (e: Exception) {
            Log.e("AlehulshForeground", "Error initializing service in onCreate: ${e.message}", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) { stopSelf(startId) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        try {
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
                // Channel default. A ping names the woman who raised the
                // alert, so a public lock screen hands her identity and
                // emergency to whoever is holding the responder's phone.
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            }
        )
    }

    private fun startAlertPingListener() {
        if(!BuildConfig.DEBUG || BuildConfig.TRUSTED_API_REQUIRED) return
        // An emulator build must not reach the live project. This listener runs
        // in native Kotlin, outside FlutterFire, so useFirestoreEmulator() on
        // the Dart side never applied to it: it was querying PRODUCTION
        // active_alerts during local testing.
        //
        // Starting it is also what broke every Dart Firestore call in emulator
        // mode. FirebaseFirestore.getInstance() here STARTS the native
        // singleton, and FlutterFire can only apply its emulator settings to an
        // instance that has not started yet - after which
        // getFirestoreFromPigeon throws before it reaches its caching line, so
        // every later query from Dart fails too.
        //
        // Not routed to the emulator, simply not started: the native path has
        // nothing to contribute to a local test, and refusing is the outcome
        // that cannot leak. Production is unaffected - the flag is false in any
        // build that did not explicitly ask for emulators.
        if (BuildConfig.USE_FIREBASE_EMULATORS) {
            Log.w("AlehulshForegroundService", "Emulator build: native alert listener NOT started (no live-project access).")
            return
        }

        // Same gate as the SOS write. A listener against the wrong project
        // shows this user other people's live alerts from an environment she
        // has no relationship to - exact coordinates included - or shows her
        // nothing while appearing to work.
        if (!FirebaseProjectGuard.allows("native alert listener")) return

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
        // `title` and `body` carry the name of the woman who raised the alert,
        // so the lock-screen face is replaced with an urgent but ANONYMOUS
        // one: a responder still sees that someone nearby needs help and can
        // act, without her identity being readable by anyone who picks up the
        // phone. Urgency is preserved; identity is not disclosed.
        //
        // LIMIT: VISIBILITY_PRIVATE redacts only on a SECURE lock screen.
        val redacted = NotificationCompat.Builder(this, CHANNEL_PING)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(getString(R.string.lockscreen_ping_title))
            .setContentText(getString(R.string.lockscreen_ping_text))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()

        val notification = NotificationCompat.Builder(this, CHANNEL_PING)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(redacted)
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
