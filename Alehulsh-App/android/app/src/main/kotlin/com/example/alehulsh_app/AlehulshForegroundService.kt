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
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.PowerManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.GeoPoint
import com.google.firebase.firestore.ListenerRegistration
import kotlin.math.sqrt

/**
 * Sticky foreground radar:
 * - 24/7 Background Accelerometer listener with WakeLock: Detects 2.3-second sustained vigorous phone shake even when screen is locked/closed.
 * - Listens to Firestore active_alerts and posts high-priority pings immediately.
 */
class AlehulshForegroundService : Service(), SensorEventListener {
    private var alertsReg: ListenerRegistration? = null
    private val notifiedIds = mutableSetOf<String>()
    private var pingListenerSeeded = false
    private var wakeLock: PowerManager.WakeLock? = null

    // Shake Detector Variables (2.3s Continuous Window)
    private var sensorManager: SensorManager? = null
    private var accelerometer: Sensor? = null
    private var shakeCount = 0
    private var firstShakeTime = 0L
    private var lastShakeTime = 0L
    private var isSosDispatchedForCurrentShake = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private var shakeValidationRunnable: Runnable? = null

    // 3x Physical Power Button Press Detection (Works 24/7 Even When Screen is Off/Closed)
    private var powerButtonPressCount = 0
    private var firstPowerPressTime = 0L
    private var lastPowerPressTime = 0L

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val action = intent?.action
            val now = System.currentTimeMillis()

            if (action == Intent.ACTION_SCREEN_OFF || action == Intent.ACTION_SCREEN_ON) {
                // Track 3x consecutive Power Button clicks (each click toggles screen state)
                if (lastPowerPressTime > 0 && (now - lastPowerPressTime > 2500L)) {
                    powerButtonPressCount = 0
                    firstPowerPressTime = 0L
                }
                if (powerButtonPressCount == 0 || firstPowerPressTime == 0L) {
                    firstPowerPressTime = now
                }
                powerButtonPressCount++
                lastPowerPressTime = now
                Log.d("AlehulshForeground", "Power button toggle: count=$powerButtonPressCount, elapsed=${now - firstPowerPressTime}ms")

                if (powerButtonPressCount >= 3 && (now - firstPowerPressTime <= 3000L)) {
                    powerButtonPressCount = 0
                    firstPowerPressTime = 0L
                    lastPowerPressTime = 0L
                    Log.d("AlehulshForeground", "🚨 3x Physical Power Button Consecutive Click Confirmed! Dispatching SOS...")
                    AlehulshSosDispatcher.trigger(
                        this@AlehulshForegroundService,
                        "3x Power Button Gesture"
                    )
                }

                // Ensure WakeLock is held and sensor listener stays connected when screen turns off
                try {
                    if (wakeLock?.isHeld != true) {
                        wakeLock?.acquire()
                    }
                    accelerometer?.let {
                        sensorManager?.registerListener(
                            this@AlehulshForegroundService,
                            it,
                            SensorManager.SENSOR_DELAY_GAME
                        )
                    }
                } catch (e: Exception) {
                    Log.e("AlehulshForeground", "Screen toggle sensor re-register error: ${e.message}")
                }
            } else if (action == "android.intent.action.EMERGENCY_ASSISTANCE" ||
                action == "com.samsung.intent.action.EMERGENCY_STATE_CHANGED"
            ) {
                Log.d("AlehulshForeground", "OS Emergency broadcast received: $action")
                AlehulshSosDispatcher.trigger(
                    this@AlehulshForegroundService,
                    "5x Power Button Gesture / Android OS SOS"
                )
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        try {
            createChannels()
            startAsForeground()

            // 1. Acquire Partial WakeLock so CPU processes sensors 24/7 when screen is off
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Alehulsh::BackgroundShakeWakeLock")
            wakeLock?.setReferenceCounted(false)
            try {
                wakeLock?.acquire()
                Log.d("AlehulshForeground", "WakeLock acquired for 24/7 background shake monitoring.")
            } catch (e: Exception) {
                Log.e("AlehulshForeground", "WakeLock acquire failed: ${e.message}")
            }

            // 2. Register 24/7 Background Accelerometer Sensor Listener (Wake-up hardware sensor)
            sensorManager = getSystemService(SENSOR_SERVICE) as? SensorManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER, true)
            }
            if (accelerometer == null) {
                accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            }

            if (accelerometer != null) {
                sensorManager?.registerListener(
                    this,
                    accelerometer,
                    SensorManager.SENSOR_DELAY_GAME
                )
                Log.d("AlehulshForeground", "24/7 Background Wake-Up Shake Sensor Listener registered successfully.")
            } else {
                Log.w("AlehulshForeground", "Device accelerometer sensor not available.")
            }

            // 3. Register Screen toggle and OS Emergency Intent Filter
            val filter = IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_OFF)
                addAction(Intent.ACTION_SCREEN_ON)
                addAction("android.intent.action.EMERGENCY_ASSISTANCE")
                addAction("com.samsung.intent.action.EMERGENCY_STATE_CHANGED")
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.registerReceiver(this, screenReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(screenReceiver, filter)
            }
            startAlertPingListener()
        } catch (e: Exception) {
            Log.e("AlehulshForeground", "Error initializing service in onCreate: ${e.message}", e)
        }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null || event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
        val x = event.values[0] / SensorManager.GRAVITY_EARTH
        val y = event.values[1] / SensorManager.GRAVITY_EARTH
        val z = event.values[2] / SensorManager.GRAVITY_EARTH
        val gForce = sqrt(x * x + y * y + z * z)

        // Require deliberate vigorous force (2.7g)
        if (gForce > 2.7f) {
            val now = System.currentTimeMillis()

            // If more than 3.0s since last shake, reset window
            if (lastShakeTime > 0 && (now - lastShakeTime > 3000L)) {
                shakeCount = 0
                firstShakeTime = 0L
                isSosDispatchedForCurrentShake = false
                shakeValidationRunnable?.let { mainHandler.removeCallbacks(it) }
            }

            // Require minimum 350ms between distinct shake peaks
            if (lastShakeTime == 0L || (now - lastShakeTime >= 350L)) {
                if (shakeCount == 0 || firstShakeTime == 0L) {
                    firstShakeTime = now
                    isSosDispatchedForCurrentShake = false

                    // Schedule 2.3s validation window
                    shakeValidationRunnable?.let { mainHandler.removeCallbacks(it) }
                    val runnable = Runnable {
                        if (shakeCount >= 3 && lastShakeTime > 0) {
                            val elapsedSinceLast = System.currentTimeMillis() - lastShakeTime
                            if (elapsedSinceLast <= 1500L && !isSosDispatchedForCurrentShake) {
                                dispatchShakeSOS()
                                return@Runnable
                            }
                        }
                        shakeCount = 0
                        firstShakeTime = 0L
                        lastShakeTime = 0L
                    }
                    shakeValidationRunnable = runnable
                    mainHandler.postDelayed(runnable, 2300L)
                }

                lastShakeTime = now
                shakeCount++
                Log.d("AlehulshForeground", "Deliberate shake #$shakeCount in background (gForce: $gForce)")

                val elapsed = now - firstShakeTime
                if (shakeCount >= 3 && elapsed >= 2000L && !isSosDispatchedForCurrentShake) {
                    dispatchShakeSOS()
                }
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun dispatchShakeSOS() {
        isSosDispatchedForCurrentShake = true
        shakeValidationRunnable?.let { mainHandler.removeCallbacks(it) }
        shakeCount = 0
        firstShakeTime = 0L
        lastShakeTime = 0L
        Log.d("AlehulshForeground", "🚨 2.3-Second Sustained Phone Shake SOS Confirmed in Background! Dispatching SOS...")
        AlehulshSosDispatcher.trigger(
            this@AlehulshForegroundService,
            "Emergency Shake Gesture (2.3s/3x)"
        )
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
            sensorManager?.unregisterListener(this)
            shakeValidationRunnable?.let { mainHandler.removeCallbacks(it) }
            unregisterReceiver(screenReceiver)
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
                        // Only react to NEW alerts, not updates to existing ones
                        if (doc.type != com.google.firebase.firestore.DocumentChange.Type.ADDED) continue
                        val data = doc.document.data
                        val status = data["status"]?.toString() ?: "active"
                        if (status != "active") continue
                        val alertId = doc.document.id
                        val senderId = data["userId"]?.toString().orEmpty().ifEmpty { alertId }
                        val pingKey = "${alertId}_${data["timestamp"]}"
                        if (!notifiedIds.add(pingKey)) continue

                        // Sender confirmation is shown by the SOS dispatcher / Flutter.
                        // Never treat Android "Cancel emergency" as a reason to skip/cancel.
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
