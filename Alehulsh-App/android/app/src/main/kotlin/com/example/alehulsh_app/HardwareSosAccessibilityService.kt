package com.example.alehulsh_app

import android.accessibilityservice.AccessibilityService
import android.os.SystemClock
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/** Opt-in physical gesture. Availability must be checked on the actual device. */
class HardwareSosAccessibilityService : AccessibilityService() {
    private val gesture = PowerKeySource()
    override fun onKeyEvent(event: KeyEvent?): Boolean {
        if (event != null && gesture.event(
                enabled = BuildConfig.DEBUG && BuildConfig.HARDWARE_SOS_EXPERIMENTAL,
                power = event.keyCode == KeyEvent.KEYCODE_POWER,
                down = event.action == KeyEvent.ACTION_DOWN,
                system = event.flags and KeyEvent.FLAG_FROM_SYSTEM != 0,
                repeatCount = event.repeatCount, now = SystemClock.elapsedRealtime())) {
            AlehulshSosDispatcher.trigger(this, "5x Power Button Gesture")
        }
        return super.onKeyEvent(event)
    }
    // Package/class labels and screen transitions are not SOS authorization.
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() { gesture.reset() }
    override fun onDestroy() { gesture.reset(); super.onDestroy() }
}
