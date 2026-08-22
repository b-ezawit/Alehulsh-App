package com.example.alehulsh_app

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "com.example.alehulsh_app/hardware_sos"

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
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
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

    override fun onNewIntent(intent: Intent) {
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

    private fun handleLaunchExtras(intent: Intent?) {
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
