package com.example.alehulsh_app
import org.junit.Test
import org.junit.Assert.*
import java.net.URI

class NativeSosRecoveryTest {
    private class Store:MigrationOutbox {
        val rows=mutableListOf<MigrationSos>()
        override fun enqueue(item:MigrationSos):MigrationSos=rows.firstOrNull {it.ownerSubject==item.ownerSubject}?:item.also {rows.add(it)}
        override fun pending(ownerSubject:String)=rows.filter {it.ownerSubject==ownerSubject}
        override fun acknowledge(ownerSubject:String,requestId:String){rows.removeAll {it.ownerSubject==ownerSubject&&it.requestId==requestId}}
    }
    private val origin=URI("https://synthetic-api.invalid")
    private val alice=NativeAuthSnapshot("synthetic-a","session-a","synthetic-token-a",2000)
    @Test fun nativeAndFlutterShareOneDurableRequestAcrossProcessRecovery(){
        val store=Store();var requests=0
        val transport=MigrationTransport {_,_,_->requests++;MigrationReceipt("immutable-incident","active")}
        val before=NativeSosRecovery(origin,{alice},store,transport,{1000});val first=before.enqueue()
        assertEquals(first,before.enqueue());assertTrue(before.hasPending())
        val after=NativeSosRecovery(origin,{alice},store,transport,{1000})
        assertEquals(MigrationDelivery.SENT,after.recover());assertEquals(1,requests);assertFalse(after.hasPending())
    }
    @Test fun expiredSessionQueuesWithoutTransmittingOrInventingRefresh(){
        val store=Store();var sent=false
        val recovery=NativeSosRecovery(origin,{alice.copy(expiresAtMs=1)},store,MigrationTransport {_,_,_->sent=true;throw java.io.IOException()},{1000})
        recovery.enqueue();assertEquals(MigrationDelivery.AUTHENTICATION_REQUIRED,recovery.recover());assertFalse(sent);assertTrue(recovery.hasPending())
    }
    @Test fun networkFailureRetainsTheOriginalRequest(){
        val store=Store();val recovery=NativeSosRecovery(origin,{alice},store,MigrationTransport {_,_,_->throw java.io.IOException("offline")},{1000})
        val original=recovery.enqueue();assertEquals(MigrationDelivery.QUEUED,recovery.recover());assertEquals(original,store.rows.single())
    }
    @Test fun delayedAcknowledgmentCannotClearTheOldAccountAfterSwitch(){
        val store=Store();var selected:NativeAuthSnapshot?=alice
        val recovery=NativeSosRecovery(origin,{selected},store,MigrationTransport {_,_,_->selected=alice.copy(subject="synthetic-b",sessionId="session-b");MigrationReceipt("immutable-incident","active")},{1000})
        val original=recovery.enqueue();assertEquals(MigrationDelivery.AUTHENTICATION_REQUIRED,recovery.recover());assertEquals(original,store.rows.single())
    }
    @Test fun sameUserNewSessionIsAlsoFenced(){
        val store=Store();var selected=alice
        val recovery=NativeSosRecovery(origin,{selected},store,MigrationTransport {_,_,_->selected=alice.copy(sessionId="new-session");MigrationReceipt("immutable-incident","active")},{1000})
        recovery.enqueue();assertEquals(MigrationDelivery.AUTHENTICATION_REQUIRED,recovery.recover());assertEquals(1,store.rows.size)
    }
    @Test fun noAccountCannotCreateAnUnownedPendingRequest(){
        val store=Store();val recovery=NativeSosRecovery(origin,{null},store,MigrationTransport {_,_,_->throw AssertionError()},{1000})
        try{recovery.enqueue();fail("owner required")}catch(_:MigrationAuthenticationRequired){}
        assertTrue(store.rows.isEmpty());assertFalse(recovery.hasPending())
    }
}
