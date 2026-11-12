package com.example.alehulsh_app

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.RandomAccessFile
import java.net.URI
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID

object PushIntentRevision {
    private val processLock=Any()
    fun increment(previous:Long):Long {
        require(previous in 0 until 9007199254740991L)
        return previous+1
    }
    /** No credential or token is stored here. Commit before any HTTP intent. */
    fun next(context:Context,namespace:String,owner:String,device:String):Long=synchronized(processLock){
        val origin=URI(namespace)
        require(origin.scheme=="https"&&origin.host!=null&&origin.userInfo==null&&origin.query==null&&origin.fragment==null&&origin.path.isNullOrEmpty())
        require(owner.isNotBlank()&&owner.length<=128);UUID.fromString(device)
        val digest=MessageDigest.getInstance("SHA-256").digest("$namespace/$owner/$device".toByteArray()).joinToString(""){"%02x".format(it)}
        val directory=File(context.noBackupFilesDir,"push-intents")
        if(!directory.exists()&&!directory.mkdirs())throw java.io.IOException("intent storage unavailable")
        RandomAccessFile(File(directory,"$digest.lock"),"rw").use { lock ->lock.channel.lock().use {
            val file=AtomicFile(File(directory,"$digest.bin"))
            val previous=try{file.openRead().use { input ->require(file.baseFile.length()==8L);val bytes=input.readBytes();require(bytes.size==8);ByteBuffer.wrap(bytes).long}}
            catch(error:java.io.FileNotFoundException){if(file.baseFile.exists()||File(file.baseFile.path+".bak").exists())throw error;0L}
            val revision=increment(previous)
            val output=file.startWrite()
            try{output.write(ByteBuffer.allocate(8).putLong(revision).array());file.finishWrite(output)}
            catch(error:Throwable){file.failWrite(output);throw error}
            revision
        }}
    }
}
