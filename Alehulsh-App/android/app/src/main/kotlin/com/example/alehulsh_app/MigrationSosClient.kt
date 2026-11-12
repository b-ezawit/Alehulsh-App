package com.example.alehulsh_app

import java.net.URI

/** Inactive API path: the live dispatcher continues to use Firebase. */
data class MigrationSession(val subject: String, val accessToken: String)
data class MigrationSos(val ownerSubject: String, val requestId: String, val payload: Map<String, Any?>)
data class MigrationReceipt(val id: String, val status: String)
interface MigrationOutbox {
    fun enqueue(item: MigrationSos): MigrationSos
    fun pending(ownerSubject: String): List<MigrationSos>
    fun acknowledge(ownerSubject: String, requestId: String)
}
fun interface MigrationTransport {
    fun post(origin: URI, token: String, item: MigrationSos): MigrationReceipt
}
class MigrationAuthenticationRequired : Exception()
class MigrationReviewRequired : Exception()
enum class MigrationDelivery { QUEUED, SENT, AUTHENTICATION_REQUIRED, REVIEW_REQUIRED }

class MigrationSosClient(
    private val origin: URI,
    private val session: () -> MigrationSession?,
    private val knownSubject: () -> String?,
    private val outbox: MigrationOutbox,
    private val transport: MigrationTransport,
    allowLoopbackHttp: Boolean = false,
    private val accountEpoch: () -> Long = { 0L },
) {
    init {
        val loopback = origin.host in setOf("127.0.0.1", "localhost", "::1", "[::1]")
        require(origin.scheme == "https" || allowLoopbackHttp && loopback && origin.scheme == "http")
        require(origin.host != null && origin.userInfo == null && origin.query == null && origin.fragment == null)
        require(origin.path.isNullOrEmpty() || origin.path == "/")
    }
    fun enqueue(item: MigrationSos): MigrationSos {
        val owner = knownSubject() ?: throw MigrationAuthenticationRequired()
        require(owner.isNotBlank() && owner == item.ownerSubject && item.payload["requestId"] == item.requestId)
        return outbox.enqueue(item) // QUEUED is never reported before this durable commit.
    }
    @Synchronized
    fun flush(): MigrationDelivery {
        val owner = knownSubject() ?: return MigrationDelivery.AUTHENTICATION_REQUIRED
        val epoch = accountEpoch()
        fun sameAccount() = knownSubject() == owner && accountEpoch() == epoch
        val current = try { session() } catch (_: java.io.IOException) { return MigrationDelivery.QUEUED }
            ?: return MigrationDelivery.AUTHENTICATION_REQUIRED
        if (!sameAccount() || current.subject != owner || current.accessToken.isBlank()) return MigrationDelivery.AUTHENTICATION_REQUIRED
        val item = outbox.pending(current.subject).firstOrNull() ?: return MigrationDelivery.QUEUED
        if (!sameAccount()) return MigrationDelivery.AUTHENTICATION_REQUIRED
        if (item.ownerSubject != current.subject || item.payload["requestId"] != item.requestId) return MigrationDelivery.REVIEW_REQUIRED
        return try {
            val receipt = transport.post(origin, current.accessToken, item)
            if (receipt.id.isBlank() || receipt.status !in setOf("active", "escalated", "resolved", "cancelled", "expired")) return MigrationDelivery.REVIEW_REQUIRED
            if (!sameAccount()) return MigrationDelivery.AUTHENTICATION_REQUIRED
            outbox.acknowledge(item.ownerSubject, item.requestId)
            if (!sameAccount()) return MigrationDelivery.AUTHENTICATION_REQUIRED
            MigrationDelivery.SENT
        } catch (_: MigrationAuthenticationRequired) { MigrationDelivery.AUTHENTICATION_REQUIRED
        } catch (_: MigrationReviewRequired) { MigrationDelivery.REVIEW_REQUIRED
        } catch (_: java.io.IOException) { MigrationDelivery.QUEUED }
    }
}
