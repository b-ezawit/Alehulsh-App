package com.example.alehulsh_app
import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors

/** Persisted Android network recovery. Force-stop, OEM restrictions and expired
 * credentials still require foreground recovery; no native refresh protocol. */
class SosRecoveryJob:JobService() {
    private val executor=Executors.newSingleThreadExecutor()
    @Volatile private var stopped=false
    override fun onStartJob(params:JobParameters):Boolean {
        stopped=false
        executor.execute {
            val retry=try {
                val recovery=NativeTrustedSos.recovery(applicationContext)
                if(!recovery.hasPending())false else when(recovery.recover()){
                    MigrationDelivery.SENT,MigrationDelivery.REVIEW_REQUIRED->false
                    else->true
                }
            }catch(_:Exception){true}
            Handler(Looper.getMainLooper()).post {if(!stopped)jobFinished(params,retry)}
        };return true
    }
    override fun onStopJob(params:JobParameters):Boolean {stopped=true;return true}
    override fun onDestroy(){executor.shutdown();super.onDestroy()}
}
