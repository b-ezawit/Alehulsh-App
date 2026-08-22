package com.example.alehulsh_app

import android.accessibilityservice.AccessibilityService
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Detects 5 consecutive power presses and the Android Emergency SOS / 911 UI.
 * Clicks on "Cancel emergency" are ignored and never forwarded as a cancel.
 */
class HardwareSosAccessibilityService : AccessibilityService() {
    private val powerKeyTimestamps = mutableListOf<Long>()
    private var lastOsSosWindowAt = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        AlehulshForegroundService.start(this)
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        // Never consume — Android OS SOS / 911 UI must still appear.
        return false
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
            return
        }

        if (isOsEmergencySosUi(pkg, className, texts)) {
            val now = System.currentTimeMillis()
            if (now - lastOsSosWindowAt > 8000) {
                lastOsSosWindowAt = now
                AlehulshSosDispatcher.trigger(this, "Android Emergency SOS Screen")
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
        val sosPkg = pkg.contains("systemui") ||
            pkg.contains("emergency") ||
            pkg.contains("safetyhub") ||
            pkg.contains("safetycenter") ||
            pkg.contains("personal.safety") ||
            pkg.contains("com.samsung.android.app.telephonyui") ||
            pkg.contains("com.android.phone")
        val sosClass = className.contains("Emergency", ignoreCase = true) ||
            className.contains("Sos", ignoreCase = true)
        val sosText = text.contains("emergency sos") ||
            text.contains("call 911") ||
            text.contains("call emergency") ||
            text.contains("slide to call") ||
            text.contains("emergency call") ||
            text.contains("counting down") ||
            (text.contains("emergency") && text.contains("911"))
        return (sosPkg && (sosClass || sosText)) || sosText
    }
}
