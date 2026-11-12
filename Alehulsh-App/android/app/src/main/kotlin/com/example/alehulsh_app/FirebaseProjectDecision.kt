package com.example.alehulsh_app

/**
 * Decides whether a native Firebase operation may proceed, by comparing the
 * project this binary was BUILT for against the project Firebase actually
 * resolved at runtime.
 *
 * WHY THIS EXISTS. The native Kotlin services talk to Firestore directly
 * rather than through FlutterFire, so nothing on the Dart side constrains
 * which project they reach. `google-services.json` is picked up per flavour at
 * build time, and a stale or wrong one resolves silently: a dev build would
 * write a fabricated SOS into the production project, in front of real
 * responders, or a production build would write a real SOS into a dev project
 * that nobody is watching. Both are silent.
 *
 * `build.gradle.kts` records EXPECTED_FIREBASE_PROJECT per flavour. Until now
 * nothing read it - the comment claimed a runtime refusal that did not exist.
 * This is that refusal.
 *
 * PURE ON PURPOSE. No Android and no Firebase types, so it is unit-testable on
 * the JVM. The runtime read lives in FirebaseProjectGuard. Same split as
 * SosLocationDecision.
 *
 * WHAT A REFUSAL COSTS, and why it is still right. A mismatch means the SOS
 * does not reach responders either way: written to the wrong project nobody
 * sees it, refused it never leaves. So refusing loses nothing that proceeding
 * would have saved - and it keeps test traffic out of the live project, keeps
 * real alerts out of a dev project, and above all is LOUD rather than silent.
 * A mismatch is a build error, not a runtime condition, so a correctly built
 * release never meets this.
 */
object FirebaseProjectDecision {

    /** Why an operation was refused. */
    enum class Reason {
        /** The build declared no expected project. Fail closed. */
        EXPECTED_MISSING,

        /** Firebase resolved no project - usually no FirebaseApp initialised. */
        ACTUAL_MISSING,

        /** Both present and different. The dangerous case. */
        MISMATCH,
    }

    sealed class Verdict {
        /** The resolved project is the one this binary was built for. */
        object Allowed : Verdict()

        /**
         * @param detail safe to log: project IDS ONLY. A Firebase project id is
         *   not a secret and carries no personal data, which is what makes it
         *   loggable - the whole point of the refusal is that an operator can
         *   see which two projects disagreed.
         */
        data class Refused(val reason: Reason, val detail: String) : Verdict()
    }

    /**
     * @param expected BuildConfig.EXPECTED_FIREBASE_PROJECT
     * @param actual FirebaseApp.getInstance().options.projectId
     *
     * Surrounding whitespace is tolerated because both values arrive through
     * build plumbing - a gradle `buildConfigField` and a generated JSON - where
     * a stray space is a formatting artefact rather than a different project.
     * Nothing else is normalised: a Firebase project id is always lower case,
     * so case-folding would only ever hide a genuine difference.
     */
    fun evaluate(expected: String?, actual: String?): Verdict {
        val want = expected?.trim().orEmpty()
        val got = actual?.trim().orEmpty()

        if (want.isEmpty()) {
            return Verdict.Refused(
                Reason.EXPECTED_MISSING,
                "build declared no expected Firebase project",
            )
        }
        if (got.isEmpty()) {
            return Verdict.Refused(
                Reason.ACTUAL_MISSING,
                "Firebase resolved no project id (expected '$want')",
            )
        }
        if (want != got) {
            return Verdict.Refused(
                Reason.MISMATCH,
                "built for '$want' but Firebase resolved '$got'",
            )
        }
        return Verdict.Allowed
    }

    /** Convenience for call sites that only branch. */
    fun isAllowed(expected: String?, actual: String?): Boolean =
        evaluate(expected, actual) is Verdict.Allowed
}
