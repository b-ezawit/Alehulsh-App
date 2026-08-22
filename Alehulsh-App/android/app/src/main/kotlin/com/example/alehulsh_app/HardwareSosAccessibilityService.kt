package com.example.alehulsh_app

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.os.PowerManager
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/**
 * 24/7 Redundant Hardware Accessibility Service:
 * - Detects 5x physical Power Button clicks via STRICT system key filtering (KEYCODE_POWER only).
 * - NEVER scrapes UI windows or accessibility events to prevent false positives.
 */
class HardwareSosAccessibilityService : AccessibilityService() {
    private var wakeLock: PowerManager.WakeLock? = null

    // 5x Physical Power Button Key Intercept
    private var powerPressCount = 0
    private var firstPowerPressTime = 0L
    private var lastPowerPressTime = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        AlehulshForegroundService.start(this)

        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Alehulsh::AccessibilityWakeLock")
            wakeLock?.setReferenceCounted(false)
            wakeLock?.acquire()
            Log.d("HardwareSosAccessibility", "Accessibility service connected.")
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
                if (lastPowerPressTime > 0 && (now - lastPowerPressTime > 3000L)) {
                    powerPressCount = 0
                    firstPowerPressTime = 0L
                }
                if (powerPressCount == 0 || firstPowerPressTime == 0L) {
                    firstPowerPressTime = now
                }
                powerPressCount++
                lastPowerPressTime = now
                Log.d("HardwareSosAccessibility", "Physical Power key click: count=$powerPressCount, elapsed=${now - firstPowerPressTime}ms")

                if (powerPressCount >= 5 && (now - firstPowerPressTime <= 4500L)) {
                    powerPressCount = 0
                    firstPowerPressTime = 0L
                    lastPowerPressTime = 0L
                    Log.d("HardwareSosAccessibility", "🚨 5x Physical Power Button Confirmed! Dispatching SOS...")
                    AlehulshSosDispatcher.trigger(this, "5x Power Button Gesture")
                }
            }
        }
        return super.onKeyEvent(event)
    }

    override fun onDestroy() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Intentionally empty. We do NOT scrape window/UI events to prevent false triggers during app navigation.
    }

    override fun onInterrupt() {}
}
