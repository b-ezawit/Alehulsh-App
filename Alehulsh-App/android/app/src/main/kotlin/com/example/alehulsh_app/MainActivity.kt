package com.example.alehulsh_app

import android.os.Bundle
import android.provider.Settings
import android.view.KeyEvent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "com.example.alehulsh_app/hardware_sos"
    private var volumePressCount = 0
    private var lastVolumePressTime = 0L

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
        AlehulshSosDispatcher.methodChannel = channel
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "startBackgroundServices" -> {
                    AlehulshForegroundService.start(this)
                    result.success(true)
                }
                "consumePendingSos" -> {
                    result.success(AlehulshSosDispatcher.consumePendingSource(this))
                }
                "isAccessibilityEnabled" -> {
                    result.success(isAccessibilityServiceEnabled())
                }
                "openAccessibilitySettings" -> {
                    startActivity(android.content.Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AlehulshForegroundService.start(this)
        handleLaunchExtras(intent)
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchExtras(intent)
    }

    override fun onResume() {
        super.onResume()
        val pending = AlehulshSosDispatcher.consumePendingSource(this)
        if (pending != null) {
            AlehulshSosDispatcher.methodChannel?.invokeMethod(
                "onHardwareSOS",
                mapOf("source" to pending, "independentOfOsCancel" to true)
            )
        }
    }

    override fun onDestroy() {
        if (AlehulshSosDispatcher.methodChannel != null) {
            // Keep dispatcher usable from the foreground service after activity teardown.
        }
        super.onDestroy()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            val keyCode = event.keyCode
            if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN ||
                keyCode == KeyEvent.KEYCODE_VOLUME_UP ||
                keyCode == KeyEvent.KEYCODE_POWER
            ) {
                val now = System.currentTimeMillis()
                if (now - lastVolumePressTime > 2500) {
                    volumePressCount = 1
                } else {
                    volumePressCount++
                }
                lastVolumePressTime = now
                if (keyCode == KeyEvent.KEYCODE_POWER) {
                    // Power counting is owned by the foreground / accessibility services (5 clicks).
                } else if (volumePressCount >= 3) {
                    volumePressCount = 0
                    AlehulshSosDispatcher.trigger(this, "Hardware Volume Button SOS")
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private fun handleLaunchExtras(intent: android.content.Intent?) {
        if (intent == null) return
        val openAlerts = intent.getBooleanExtra("open_alerts_tab", false)
        val highlight = intent.getStringExtra("highlight_alert_id")
        val hardware = intent.getBooleanExtra("hardware_sos", false)
        if (openAlerts || highlight != null || hardware) {
            AlehulshSosDispatcher.methodChannel?.invokeMethod(
                "onNotificationOpen",
                mapOf(
                    "alertId" to (highlight ?: ""),
                    "openAlerts" to true
                )
            )
        }
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val expected = "$packageName/${HardwareSosAccessibilityService::class.java.canonicalName}"
        val enabled = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }
}
