package com.example.alehulsh_app

import android.util.Log
import com.google.firebase.FirebaseApp

/**
 * The runtime half of FirebaseProjectDecision: reads the project Firebase
 * actually resolved and applies the decision.
 *
 * Kept separate so the decision stays unit-testable without Android or
 * Firebase on the classpath.
 *
 * Every native entry point that touches Firebase must call this FIRST. There
 * are two: AlehulshSosDispatcher.writeFirestoreAlert (the SOS write) and
 * AlehulshForegroundService.startAlertPingListener (the alert listener).
 * MainActivity, HardwareSosAccessibilityService, GeoHash and
 * SosLocationDecision touch Firebase at all, so they need no gate.
 */
object FirebaseProjectGuard {

    /**
     * The project Firebase resolved, or null when there is none.
     *
     * FirebaseApp.getInstance() THROWS when no app has been initialised, which
     * is a legitimate state for a service started before Flutter has run. A
     * throw is treated as "no project", i.e. a refusal - fail closed.
     */
    private fun resolvedProjectId(): String? = try {
        FirebaseApp.getInstance().options.projectId
    } catch (e: IllegalStateException) {
        null
    } catch (e: Exception) {
        // Defensive: any other failure to resolve is also "unknown project".
        null
    }

    /**
     * @param operation named in the log line so an operator can tell which
     *   path was refused.
     * @return true when the operation may proceed.
     *
     * Logged at ERROR, not warn: a mismatch means a safety-critical path was
     * refused, and silence here is what this whole mechanism exists to remove.
     */
    fun allows(operation: String, expected: String? = BuildConfig.EXPECTED_FIREBASE_PROJECT): Boolean {
        return when (val verdict = FirebaseProjectDecision.evaluate(expected, resolvedProjectId())) {
            is FirebaseProjectDecision.Verdict.Allowed -> true
            is FirebaseProjectDecision.Verdict.Refused -> {
                Log.e(
                    TAG,
                    "REFUSED $operation: Firebase project does not match this build " +
                        "(${verdict.reason}) - ${verdict.detail}",
                )
                false
            }
        }
    }

    private const val TAG = "FirebaseProjectGuard"
}
