package com.example.alehulsh_app

import java.net.HttpURLConnection
import java.net.URI
import java.time.Instant
import org.json.JSONObject

/** Fresh access tokens are supplied in memory and never enter the outbox. */
class HttpsSosTransport(private val timeoutMs: Int = 10_000) : MigrationTransport {
    override fun post(origin: URI, token: String, item: MigrationSos): MigrationReceipt {
        val connection = origin.resolve("/v1/alerts").toURL().openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(JSONObject(item.payload).toString().toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            if (status == 401) throw MigrationAuthenticationRequired()
            if (status == 429 || status >= 500) throw java.io.IOException("retryable API response")
            if (status != 200 && status != 201) throw MigrationReviewRequired()
            val bytes = connection.inputStream.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val block = ByteArray(4096)
                while (true) {
                    val n = input.read(block)
                    if (n < 0) break
                    if (output.size() + n > 65536) throw MigrationReviewRequired()
                    output.write(block, 0, n)
                }
                output.toByteArray()
            }
            try {
                val alert = JSONObject(String(bytes, Charsets.UTF_8)).getJSONObject("alert")
                val id = alert.getString("id")
                val created = Instant.parse(alert.getString("createdAt"))
                val expiry = Instant.parse(alert.getString("expiresAt"))
                if (id.isBlank() || id.length > 128 || expiry < created) throw MigrationReviewRequired()
                return MigrationReceipt(id, alert.getString("status"))
            } catch (_: org.json.JSONException) { throw MigrationReviewRequired()
            } catch (_: java.time.format.DateTimeParseException) { throw MigrationReviewRequired() }
        } finally { connection.disconnect() }
    }
}
