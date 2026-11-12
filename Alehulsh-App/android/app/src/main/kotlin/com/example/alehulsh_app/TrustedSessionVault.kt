package com.example.alehulsh_app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.RandomAccessFile
import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One provider environment per encrypted namespace. No tokens in preferences,
 * external storage, backups, logs, or platform exception messages. */
class TrustedSessionVault(context: Context, private val namespace: String,private val slot:String="session") {
    companion object { private val processLock=Any() }
    private val digest: String
    private val directory=File(context.noBackupFilesDir,"trusted-auth")
    init {
        val uri=URI(namespace)
        require(slot in setOf("session","pkce","evidence"))
        require(uri.scheme=="https" && uri.host!=null && uri.userInfo==null && uri.query==null && uri.fragment==null && uri.path.isNullOrEmpty())
        digest=MessageDigest.getInstance("SHA-256").digest("$namespace/$slot".toByteArray()).joinToString("") { "%02x".format(it) }
    }
    private fun key(create: Boolean): SecretKey {
        val alias="alehulsh.trusted.auth.v1.$digest"
        val keys=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keys.getKey(alias,null) as? SecretKey)?.let { return it }
        if(!create)throw java.io.IOException("secure session key unavailable")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    private fun <T> locked(operation:(AtomicFile)->T):T=synchronized(processLock) {
        if(!directory.exists()&&!directory.mkdirs())throw java.io.IOException("secure session unavailable")
        RandomAccessFile(File(directory,"$digest.lock"),"rw").use { f ->
            f.channel.lock().use { operation(AtomicFile(File(directory,"$digest.bin"))) }
        }
    }
    fun read():String?=locked { file ->
        val bytes=try {file.openRead().use { input ->
            if(file.baseFile.length()>65536+29)throw java.io.IOException("secure session limit")
            input.readBytes()
        }}catch(error:java.io.FileNotFoundException){
            if(file.baseFile.exists()||File(file.baseFile.path+".bak").exists())throw error
            return@locked null
        }
        require(bytes.size>=29 && bytes[0]==1.toByte())
        val cipher=Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE,key(false),GCMParameterSpec(128,bytes.copyOfRange(1,13)))
        cipher.updateAAD(namespace.toByteArray(Charsets.UTF_8))
        String(cipher.doFinal(bytes.copyOfRange(13,bytes.size)),Charsets.UTF_8)
    }
    fun write(value:String)=locked { file ->
        val bytes=value.toByteArray(Charsets.UTF_8);require(bytes.isNotEmpty()&&bytes.size<=65536)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE,key(true));updateAAD(namespace.toByteArray(Charsets.UTF_8)) }
        check(cipher.iv.size==12)
        val output=file.startWrite()
        try {output.write(byteArrayOf(1)+cipher.iv+cipher.doFinal(bytes));file.finishWrite(output)}
        catch(error:Throwable){file.failWrite(output);throw error}
    }
    fun remove()=locked { it.delete() }
}
