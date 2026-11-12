package com.example.alehulsh_app

import android.content.Context
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors

object TrustedSessionChannel {
    private val executor by lazy { Executors.newSingleThreadExecutor() }
    fun register(messenger: BinaryMessenger,context:Context) {
        val main=Handler(Looper.getMainLooper())
        MethodChannel(messenger,"com.example.alehulsh_app/trusted_session").setMethodCallHandler { call,result ->
            if(call.method !in setOf("read","write","remove","nextPushRevision")){result.notImplemented();return@setMethodCallHandler}
            executor.execute {
                try {
                    val args=call.arguments as? Map<*,*> ?: throw IllegalArgumentException()
                    if(call.method=="nextPushRevision"){
                        val revision=PushIntentRevision.next(context.applicationContext,args["namespace"] as String,args["owner"] as String,args["deviceId"] as String)
                        main.post {result.success(revision)};return@execute
                    }
                    val vault=TrustedSessionVault(context.applicationContext,args["namespace"] as String,args["slot"] as? String ?: "session")
                    val value:Any?=when(call.method){
                        "read"->vault.read()
                        "write"->{vault.write(args["session"] as String);null}
                        else->{vault.remove();null}
                    }
                    if(call.method=="write"&&(args["slot"]?:"session")=="session")NativeTrustedSos.schedule(context.applicationContext)
                    main.post {result.success(value)}
                }catch(_:Throwable){main.post {result.error("session_storage_unavailable","Secure session storage is unavailable.",null)}}
            }
        }
    }
}
