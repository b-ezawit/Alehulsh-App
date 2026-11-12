package com.example.alehulsh_app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.RandomAccessFile
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

/** Atomic shared Flutter/native storage, device-bound and excluded from backup. */
class EncryptedMigrationOutbox(context: Context) : MigrationOutbox {
    companion object { private val processLock = Any() }
    private val directory = File(context.noBackupFilesDir, "migration-sos")
    private val alias = "alehulsh.migration.sos.v1"
    private val allowed = setOf("requestId", "latitude", "longitude", "accuracyMeters", "locationAgeMs", "occurredAt")
    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        if (!create) throw java.io.IOException("outbox key unavailable")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
        }.generateKey()
    }
    private fun <T> locked(operation: (AtomicFile) -> T): T = synchronized(processLock) {
        if (!directory.exists() && !directory.mkdirs()) throw java.io.IOException("outbox directory unavailable")
        RandomAccessFile(File(directory, "lock"), "rw").use { file ->
            file.channel.lock().use { operation(AtomicFile(File(directory, "pending.bin"))) }
        }
    }
    private fun load(file: AtomicFile): MutableList<MigrationSos> {
        val encrypted = try { file.openRead().use { input ->
            if (file.baseFile.length() > 1024 * 1024) throw java.io.IOException("outbox exceeds limit")
            input.readBytes()
        } } catch (error: java.io.FileNotFoundException) {
            if (file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()) throw error
            return mutableListOf()
        }
        if (encrypted.size < 29 || encrypted[0] != 1.toByte()) throw java.io.IOException("outbox envelope invalid")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, encrypted.copyOfRange(1, 13)))
        val rows = JSONArray(String(cipher.doFinal(encrypted.copyOfRange(13, encrypted.size)), Charsets.UTF_8))
        return (0 until rows.length()).map { decode(rows.getJSONObject(it)) }.toMutableList()
    }
    private fun save(file: AtomicFile, records: List<MigrationSos>) {
        val json = JSONArray(records.map { encode(it) }).toString().toByteArray(Charsets.UTF_8)
        if (json.size > 1024 * 1024) throw java.io.IOException("outbox exceeds limit")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(true)) }
        check(cipher.iv.size == 12)
        val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(json)
        val output = file.startWrite()
        try { output.write(encrypted); file.finishWrite(output) }
        catch (error: Throwable) { file.failWrite(output); throw error }
    }
    private fun validate(item: MigrationSos) {
        require(item.ownerSubject.isNotBlank() && item.ownerSubject.length <= 128)
        require(item.requestId.length in 8..128 && item.payload["requestId"] == item.requestId)
        require(item.payload.keys.all { it in allowed })
        require(item.payload["occurredAt"] is String && (item.payload["occurredAt"] as String).length <= 64)
        for (field in listOf("latitude", "longitude", "accuracyMeters", "locationAgeMs")) {
            val value = item.payload[field]
            require(value == null || value is Number && value.toDouble().isFinite())
        }
        val lat = (item.payload["latitude"] as? Number)?.toDouble()
        val lon = (item.payload["longitude"] as? Number)?.toDouble()
        require((lat == null) == (lon == null))
        require(lat == null || lat in -90.0..90.0)
        require(lon == null || lon in -180.0..180.0)
        require((item.payload["accuracyMeters"] as? Number)?.toDouble()?.let { it > 0 } != false)
        require((item.payload["locationAgeMs"] as? Number)?.toDouble()?.let { it >= 0 } != false)
    }
    fun encode(item: MigrationSos): JSONObject = JSONObject().put("ownerSubject", item.ownerSubject)
        .put("requestId", item.requestId).put("payload", JSONObject(item.payload))
    fun decode(value: JSONObject): MigrationSos {
        val body = value.getJSONObject("payload")
        val fields = body.keys().asSequence().associateWith { name -> body.get(name).takeUnless { it == JSONObject.NULL } }
        return MigrationSos(value.getString("ownerSubject"), value.getString("requestId"), fields).also { validate(it) }
    }
    override fun enqueue(item: MigrationSos): MigrationSos = locked { file ->
        validate(item)
        val entries = load(file)
        entries.firstOrNull { it.ownerSubject == item.ownerSubject } ?: item.also {
            if (entries.size >= 128) throw java.io.IOException("outbox capacity reached")
            entries.add(it); save(file, entries)
        }
    }
    override fun pending(ownerSubject: String): List<MigrationSos> = locked { file -> load(file).filter { it.ownerSubject == ownerSubject } }
    override fun acknowledge(ownerSubject: String, requestId: String) = locked { file ->
        val entries = load(file)
        if (entries.removeAll { it.ownerSubject == ownerSubject && it.requestId == requestId }) save(file, entries)
    }
}
