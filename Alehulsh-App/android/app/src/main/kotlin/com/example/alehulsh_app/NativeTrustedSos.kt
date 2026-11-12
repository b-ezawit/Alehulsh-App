package com.example.alehulsh_app
import android.content.Context
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import java.net.URI
import java.util.Base64
import java.util.UUID
import org.json.JSONObject

object NativeTrustedSos {
    fun recovery(context:Context):NativeSosRecovery {
        val origin=URI(BuildConfig.TRUSTED_AUTH_ORIGIN)
        require(origin.scheme=="https"&&origin.host!=null&&origin.userInfo==null&&origin.query==null&&origin.fragment==null&&origin.path.isNullOrEmpty())
        val vault=TrustedSessionVault(context,origin.toString())
        return NativeSosRecovery(URI(BuildConfig.TRUSTED_API_ORIGIN),identity={
            val raw=vault.read()
            if(raw==null)null else {
                val session=JSONObject(raw);val token=session.getString("access_token");val parts=token.split('.')
                require(parts.size==3)
                val claims=JSONObject(String(Base64.getUrlDecoder().decode(parts[1]),Charsets.UTF_8))
                val owner=session.getJSONObject("user").getString("id")
                require(claims.getString("sub")==owner&&claims.getString("role")=="authenticated")
                require(claims.getString("iss")==origin.resolve("/auth/v1").toString())
                val sid=claims.getString("session_id");UUID.fromString(sid);UUID.fromString(owner)
                val expiry=claims.getLong("exp");require(expiry in 1..(Long.MAX_VALUE/1000))
                NativeAuthSnapshot(owner,sid,token,expiry*1000)
            }
        },outbox=EncryptedMigrationOutbox(context),transport=HttpsSosTransport())
    }
    fun schedule(context:Context):Boolean {
        if(!BuildConfig.TRUSTED_API_REQUIRED)return false
        return try {
            val scheduler=context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            scheduler.schedule(JobInfo.Builder(71004,ComponentName(context,SosRecoveryJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true)
                .setBackoffCriteria(30_000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).build())==JobScheduler.RESULT_SUCCESS
        }catch(_:Exception){false}
    }
}
