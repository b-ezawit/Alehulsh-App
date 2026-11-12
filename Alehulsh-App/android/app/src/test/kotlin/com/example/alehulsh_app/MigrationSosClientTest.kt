package com.example.alehulsh_app

import java.net.URI
import org.junit.Assert.*
import org.junit.Test

class MigrationSosClientTest {
    private class Store(val rows: MutableMap<String, MigrationSos> = mutableMapOf()) : MigrationOutbox {
        var failWrite = false
        override fun enqueue(item: MigrationSos): MigrationSos {
            if (failWrite) throw java.io.IOException("disk unavailable")
            return rows.getOrPut(item.ownerSubject) { item.copy(payload = item.payload.toMap()) }
        }
        override fun pending(ownerSubject: String) = listOfNotNull(rows[ownerSubject])
        override fun acknowledge(ownerSubject: String, requestId: String) {
            if (rows[ownerSubject]?.requestId == requestId) rows.remove(ownerSubject)
        }
    }
    private val pending = MigrationSos("alice", "request-stable", mapOf("requestId" to "request-stable", "latitude" to null))
    private fun client(store: Store, user: String = "alice", transport: MigrationTransport) =
        MigrationSosClient(URI("https://api.example.invalid"), { MigrationSession(user, "in-memory-token") }, {user}, store, transport)
    @Test fun storageFailureNeverClaimsQueued() {
        val store = Store().also { it.failWrite = true }
        try { client(store, transport = MigrationTransport { _, _, _ -> error("must not send") }).enqueue(pending); fail() }
        catch (_: java.io.IOException) { assertTrue(store.rows.isEmpty()) }
    }
    @Test fun lostResponseAndProcessReconstructionKeepRequestIdentity() {
        val rows = mutableMapOf<String, MigrationSos>(); val ids = mutableListOf<String>()
        val initial = client(Store(rows), transport = MigrationTransport { _, _, item -> ids.add(item.requestId); throw java.io.IOException("lost response") })
        initial.enqueue(pending); assertEquals(MigrationDelivery.QUEUED, initial.flush())
        val recreated = client(Store(rows), transport = MigrationTransport { _, token, item ->
            assertEquals("in-memory-token", token); ids.add(item.requestId); MigrationReceipt("incident", "active") })
        assertEquals(MigrationDelivery.SENT, recreated.flush()); assertEquals(listOf(pending.requestId, pending.requestId), ids)
        assertTrue(rows.isEmpty())
    }
    @Test fun accountSwitchNeverSendsAnotherAccountsLocation() {
        val store = Store(); store.enqueue(pending)
        val other = client(store, "bob", MigrationTransport { _, _, _ -> error("must not send") })
        assertEquals(MigrationDelivery.QUEUED, other.flush()); assertNotNull(store.rows["alice"])
    }
    @Test fun failedAuthenticationRetainsWork() {
        val store = Store(); store.enqueue(pending)
        assertEquals(MigrationDelivery.AUTHENTICATION_REQUIRED,
            client(store, transport = MigrationTransport { _, _, _ -> throw MigrationAuthenticationRequired() }).flush())
        assertNotNull(store.rows["alice"])
    }
    @Test fun invalidReceiptsCannotRemoveWork() {
        val store = Store(); store.enqueue(pending)
        assertEquals(MigrationDelivery.REVIEW_REQUIRED,
            client(store, transport = MigrationTransport { _, _, _ -> MigrationReceipt("", "active") }).flush())
        assertNotNull(store.rows["alice"])
    }
    @Test fun insecureOriginsAreRejected() {
        try { MigrationSosClient(URI("http://remote.invalid"), { null }, {null}, Store(), MigrationTransport { _, _, _ -> error("unused") }); fail() }
        catch (_: IllegalArgumentException) { }
    }
    @Test fun duplicateEnqueuePreservesOriginalEventAndDoesNotStoreToken() {
        val store = Store(); val api = client(store, transport = MigrationTransport { _, _, _ -> error("unused") })
        api.enqueue(pending); val existing = api.enqueue(pending.copy(requestId = "replacement", payload = mapOf("requestId" to "replacement")))
        assertEquals(pending.requestId, existing.requestId); assertFalse(existing.toString().contains("in-memory-token"))
    }
    @Test fun offlineTokenRefreshDoesNotPreventDurableEnqueue() {
        val store=Store();var refreshes=0
        val api=MigrationSosClient(URI("https://api.example.invalid"), {refreshes++;throw java.io.IOException("offline")},
            {"alice"},store,MigrationTransport{_,_,_->error("must not send")})
        api.enqueue(pending);assertEquals(0,refreshes);assertNotNull(store.rows["alice"])
        assertEquals(MigrationDelivery.QUEUED,api.flush());assertEquals(1,refreshes);assertNotNull(store.rows["alice"])
    }


    @Test fun accountChangesDuringTransportNeverAcknowledgeThePreviousOwnersWork() {
        val store=Store(); store.enqueue(pending); var owner="alice"; var epoch=0L
        val api=MigrationSosClient(URI("https://api.example.invalid"), { MigrationSession(owner,"synthetic-token") },
            {owner},store,MigrationTransport {_,_,_-> owner="bob"; epoch++; MigrationReceipt("incident","active")}, accountEpoch={epoch})
        assertEquals(MigrationDelivery.AUTHENTICATION_REQUIRED,api.flush()); assertNotNull(store.rows["alice"])
    }
    @Test fun sameAccountReauthenticationInvalidatesAnOldSubmissionResponse() {
        val store=Store(); store.enqueue(pending); var epoch=0L
        val api=MigrationSosClient(URI("https://api.example.invalid"), { MigrationSession("alice","synthetic-token") },
            {"alice"},store,MigrationTransport {_,_,_-> epoch+=2; MigrationReceipt("incident","active")}, accountEpoch={epoch})
        assertEquals(MigrationDelivery.AUTHENTICATION_REQUIRED,api.flush()); assertNotNull(store.rows["alice"])
    }
}
