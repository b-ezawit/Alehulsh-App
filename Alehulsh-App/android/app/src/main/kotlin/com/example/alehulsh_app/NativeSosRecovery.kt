package com.example.alehulsh_app
import java.net.URI
import java.time.Instant
import java.util.UUID

data class NativeAuthSnapshot(val subject:String,val sessionId:String,val token:String,val expiresAtMs:Long)
/** Provider refresh belongs to the official Flutter SDK. Expired credentials
 * select a durable account outbox but can never authorize transmission. */
class NativeSosRecovery(origin:URI,private val identity:()->NativeAuthSnapshot?,private val outbox:MigrationOutbox,
    transport:MigrationTransport,private val now:()->Long={System.currentTimeMillis()}) {
    private var binding:Pair<String,String>?=null
    private var generation=0L
    @Synchronized private fun read():NativeAuthSnapshot? {
        val snapshot=identity();val next=snapshot?.let {it.subject to it.sessionId}
        if(next!=binding){generation++;binding=next};return snapshot
    }
    private val client=MigrationSosClient(origin,
        session={read()?.let {if(it.expiresAtMs>now())MigrationSession(it.subject,it.token)else null}},
        knownSubject={read()?.subject},outbox=outbox,transport=transport,accountEpoch={read();generation})
    fun enqueue():MigrationSos {
        val owner=read()?.subject?:throw MigrationAuthenticationRequired();val request=UUID.randomUUID().toString()
        return client.enqueue(MigrationSos(owner,request,mapOf("requestId" to request,"occurredAt" to Instant.ofEpochMilli(now()).toString())))
    }
    fun recover():MigrationDelivery=client.flush()
    fun hasPending():Boolean=read()?.subject?.let {outbox.pending(it).isNotEmpty()}?:false
}
