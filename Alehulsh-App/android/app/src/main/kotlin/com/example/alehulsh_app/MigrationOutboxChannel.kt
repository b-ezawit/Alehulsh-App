package com.example.alehulsh_app

import android.content.Context
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors
import org.json.JSONObject

/** Registers storage operations only; never schedules or sends an SOS. */
object MigrationOutboxChannel {
    private val executor by lazy { Executors.newSingleThreadExecutor() }
    fun register(messenger: BinaryMessenger, context: Context) {
        val store = EncryptedMigrationOutbox(context.applicationContext)
        val main = Handler(Looper.getMainLooper())
        MethodChannel(messenger, "com.example.alehulsh_app/migration_sos_outbox").setMethodCallHandler { call, result ->
            if (call.method !in setOf("enqueue", "pending", "acknowledge")) {
                result.notImplemented()
                return@setMethodCallHandler
            }
            executor.execute {
                try {
                    val args = call.arguments as? Map<*, *> ?: throw IllegalArgumentException()
                    val response: Any? = when (call.method) {
                        "enqueue" -> map(store.enqueue(store.decode(JSONObject(args)))).also {NativeTrustedSos.schedule(context.applicationContext)}
                        "pending" -> store.pending(args["ownerSubject"] as String).map { map(it) }
                        else -> { store.acknowledge(args["ownerSubject"] as String, args["requestId"] as String); null }
                    }
                    main.post { result.success(response) }
                } catch (_: Throwable) {
                    // No exception text, path, ciphertext, token or payload crosses the bridge.
                    main.post { result.error("storage_unavailable", "Secure SOS storage is unavailable.", null) }
                }
            }
        }
    }
    private fun map(item: MigrationSos): Map<String, Any?> = mapOf(
        "ownerSubject" to item.ownerSubject, "requestId" to item.requestId, "payload" to item.payload,
    )
}
