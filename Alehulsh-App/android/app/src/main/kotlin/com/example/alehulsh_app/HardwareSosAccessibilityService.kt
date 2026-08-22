package com.example.alehulsh_app

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlin.math.sqrt

/**
 * 24/7 Redundant Hardware & Gesture Accessibility Service:
 * - Detects 5x physical Power Button clicks via system key filtering.
 * - Detects 2.0s phone shake even if screen is locked or app is closed.
 * - Detects OS Emergency SOS / 911 countdown and ignores OS cancel dialogs.
 */
class HardwareSosAccessibilityService : AccessibilityService(), SensorEventListener {
    private var lastOsSosWindowAt = 0L
    private var wakeLock: PowerManager.WakeLock? = null
    private var sensorManager: SensorManager? = null
    private var accelerometer: Sensor? = null
    private var shakeCount = 0
    private var firstShakeTime = 0L
    private var lastShakeTime = 0L
    private var isSosDispatchedForCurrentShake = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private var shakeValidationRunnable: Runnable? = null

    // 5x Power Button Key Intercept
    private var powerPressCount = 0
    private var firstPowerPressTime = 0L
    private var lastPowerPressTime = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        AlehulshForegroundService.start(this)

        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Alehulsh::AccessibilityShakeWakeLock")
            wakeLock?.setReferenceCounted(false)
            wakeLock?.acquire()

            sensorManager = getSystemService(Context.SENSOR_SERVICE) as? SensorManager
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
                Log.d("HardwareSosAccessibility", "Accessibility shake sensor registered.")
            }
        } catch (e: Exception) {
            Log.e("HardwareSosAccessibility", "Error in onServiceConnected: ${e.message}")
        }
    }

    override fun onKeyEvent(event: KeyEvent?): Boolean {
        if (event == null) return false
        if (event.action == KeyEvent.ACTION_DOWN) {
            val keyCode = event.keyCode
            if (keyCode == KeyEvent.KEYCODE_POWER ||
                keyCode == KeyEvent.KEYCODE_SLEEP ||
                keyCode == KeyEvent.KEYCODE_SOFT_SLEEP ||
                keyCode == KeyEvent.KEYCODE_WAKEUP
            ) {
                val now = System.currentTimeMillis()
                if (lastPowerPressTime > 0 && (now - lastPowerPressTime > 3500L)) {
                    powerPressCount = 0
                    firstPowerPressTime = 0L
                }
                if (powerPressCount == 0 || firstPowerPressTime == 0L) {
                    firstPowerPressTime = now
                }
                powerPressCount++
                lastPowerPressTime = now
                Log.d("HardwareSosAccessibility", "Power key click in Accessibility: count=$powerPressCount, elapsed=${now - firstPowerPressTime}ms")

                if (powerPressCount >= 5 && (now - firstPowerPressTime <= 5000L)) {
                    powerPressCount = 0
                    firstPowerPressTime = 0L
                    lastPowerPressTime = 0L
                    Log.d("HardwareSosAccessibility", "🚨 5x Physical Power Button Confirmed in Accessibility! Dispatching SOS...")
                    AlehulshSosDispatcher.trigger(this, "5x Power Button Gesture")
                }
            }
        }
        return super.onKeyEvent(event)
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null || event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
        val x = event.values[0] / SensorManager.GRAVITY_EARTH
        val y = event.values[1] / SensorManager.GRAVITY_EARTH
        val z = event.values[2] / SensorManager.GRAVITY_EARTH
        val gForce = sqrt(x * x + y * y + z * z)

        if (gForce > 2.6f) {
            val now = System.currentTimeMillis()

            if (lastShakeTime > 0 && (now - lastShakeTime > 2500L)) {
                shakeCount = 0
                firstShakeTime = 0L
                isSosDispatchedForCurrentShake = false
                shakeValidationRunnable?.let { mainHandler.removeCallbacks(it) }
            }

            if (lastShakeTime == 0L || (now - lastShakeTime >= 300L)) {
                if (shakeCount == 0 || firstShakeTime == 0L) {
                    firstShakeTime = now
                    isSosDispatchedForCurrentShake = false

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
                    mainHandler.postDelayed(runnable, 2000L) // 2.0s validation window
                }

                lastShakeTime = now
                shakeCount++

                val elapsed = now - firstShakeTime
                if (shakeCount >= 3 && elapsed >= 1600L && !isSosDispatchedForCurrentShake) {
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
        Log.d("HardwareSosAccessibility", "🚨 2.0s Sustained Phone Shake SOS Confirmed in Accessibility! Dispatching SOS...")
        AlehulshSosDispatcher.trigger(this, "Emergency Shake Gesture (2s/3x)")
    }

    override fun onDestroy() {
        try {
            sensorManager?.unregisterListener(this)
            shakeValidationRunnable?.let { mainHandler.removeCallbacks(it) }
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val type = event.eventType
        if (type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) {
            return
        }

        val pkg = event.packageName?.toString().orEmpty()
        if (pkg == packageName) return

        val className = event.className?.toString().orEmpty()
        val texts = collectText(event)

        if (isOsCancelEmergencyUi(texts)) {
            // Explicitly do nothing to Alehulsh SOS.
            Log.d("HardwareSosAccessibility", "OS Cancel Emergency dialog detected; strictly preserving Alehulsh SOS state.")
            return
        }

        if (isOsEmergencySosUi(pkg, className, texts)) {
            val now = System.currentTimeMillis()
            if (now - lastOsSosWindowAt > 6000) {
                lastOsSosWindowAt = now
                Log.d("HardwareSosAccessibility", "🚨 Android 5x Power Button Emergency SOS / 911 screen detected (pkg=$pkg, class=$className)! Dispatching Alehulsh SOS...")
                AlehulshSosDispatcher.trigger(this, "5x Power Button / Android Emergency SOS")
            }
        }
    }

    override fun onInterrupt() {}

    private fun collectText(event: AccessibilityEvent): String {
        val builder = StringBuilder()
        event.text?.forEach { builder.append(it).append(' ') }
        event.contentDescription?.let { builder.append(it).append(' ') }
        collectNodeText(rootInActiveWindow, builder, 0)
        return builder.toString().lowercase()
    }

    private fun collectNodeText(node: AccessibilityNodeInfo?, into: StringBuilder, depth: Int) {
        if (node == null || depth > 12) return
        node.text?.let { into.append(it).append(' ') }
        node.contentDescription?.let { into.append(it).append(' ') }
        for (i in 0 until node.childCount) {
            collectNodeText(node.getChild(i), into, depth + 1)
        }
    }

    private fun isOsCancelEmergencyUi(text: String): Boolean {
        return text.contains("cancel emergency") ||
            text.contains("emergency cancelled") ||
            text.contains("emergency canceled")
    }

    private fun isOsEmergencySosUi(pkg: String, className: String, text: String): Boolean {
        val lowerPkg = pkg.lowercase()
        val lowerClass = className.lowercase()
        val lowerText = text.lowercase()

        val sosPkg = lowerPkg.contains("systemui") ||
            lowerPkg.contains("emergency") ||
            lowerPkg.contains("safety") ||
            lowerPkg.contains("safetyhub") ||
            lowerPkg.contains("safetycenter") ||
            lowerPkg.contains("personal.safety") ||
            lowerPkg.contains("telephony") ||
            lowerPkg.contains("incall") ||
            lowerPkg.contains("phone") ||
            lowerPkg.contains("dialer") ||
            lowerPkg.contains("sec.android") ||
            lowerPkg.contains("samsung")

        val sosClass = lowerClass.contains("emergency") ||
            lowerClass.contains("sos") ||
            lowerClass.contains("incall") ||
            lowerClass.contains("dialpad") ||
            lowerClass.contains("call") ||
            lowerClass.contains("safety")

        val sosKeywords = lowerText.contains("emergency sos") ||
            lowerText.contains("call 911") ||
            lowerText.contains("call emergency") ||
            lowerText.contains("emergency call") ||
            lowerText.contains("slide to call") ||
            lowerText.contains("swipe to call") ||
            lowerText.contains("counting down") ||
            lowerText.contains("calling emergency") ||
            lowerText.contains("emergency sharing") ||
            lowerText.contains("emergency number") ||
            lowerText.contains("emergency contacts") ||
            lowerText.contains("send sos") ||
            (lowerText.contains("emergency") && (lowerText.contains("911") || lowerText.contains("112") || lowerText.contains("999") || lowerText.contains("call") || lowerText.contains("sos")))

        return (sosPkg && (sosClass || sosKeywords)) || sosKeywords
    }
}
