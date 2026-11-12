package com.example.alehulsh_app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The native Firebase project gate.
 *
 * Unit tests only. These prove the DECISION is correct and fails closed; they
 * prove nothing about device behaviour - whether the right
 * google-services.json is packaged, whether FirebaseApp is initialised when a
 * service starts, or that a real device refuses a real write. That needs an
 * instrumented run on hardware and has not been done.
 */
class FirebaseProjectDecisionTest {

    private fun refusal(expected: String?, actual: String?): FirebaseProjectDecision.Verdict.Refused {
        val v = FirebaseProjectDecision.evaluate(expected, actual)
        assertTrue("expected a refusal, got $v", v is FirebaseProjectDecision.Verdict.Refused)
        return v as FirebaseProjectDecision.Verdict.Refused
    }

    // ---- the allowed case ------------------------------------------------

    @Test
    fun `matching project is allowed`() {
        assertEquals(
            FirebaseProjectDecision.Verdict.Allowed,
            FirebaseProjectDecision.evaluate("alehulsh-app", "alehulsh-app"),
        )
        assertTrue(FirebaseProjectDecision.isAllowed("alehulsh-app", "alehulsh-app"))
    }

    @Test
    fun `build plumbing whitespace is tolerated`() {
        // Both values arrive through a gradle buildConfigField and generated
        // JSON, where a stray space is a formatting artefact, not a different
        // project.
        assertTrue(FirebaseProjectDecision.isAllowed(" alehulsh-app", "alehulsh-app "))
        assertTrue(FirebaseProjectDecision.isAllowed("\talehulsh-app\n", "alehulsh-app"))
    }

    // ---- the dangerous case ----------------------------------------------

    @Test
    fun `dev binary against the production project is refused`() {
        val r = refusal("alehulsh-dev", "alehulsh-app")
        assertEquals(FirebaseProjectDecision.Reason.MISMATCH, r.reason)
        assertTrue(r.detail.contains("alehulsh-dev"))
        assertTrue(r.detail.contains("alehulsh-app"))
    }

    @Test
    fun `production binary against a dev project is refused too`() {
        // The other direction matters as much: a real SOS written into a
        // project nobody watches is still an unanswered emergency.
        assertEquals(
            FirebaseProjectDecision.Reason.MISMATCH,
            refusal("alehulsh-app", "alehulsh-dev").reason,
        )
    }

    @Test
    fun `case is NOT folded away`() {
        // A Firebase project id is always lower case, so folding case could
        // only ever hide a real difference.
        assertEquals(
            FirebaseProjectDecision.Reason.MISMATCH,
            refusal("alehulsh-app", "Alehulsh-App").reason,
        )
    }

    @Test
    fun `a near-miss project id is refused`() {
        assertEquals(
            FirebaseProjectDecision.Reason.MISMATCH,
            refusal("alehulsh-app", "alehulsh-app-2").reason,
        )
        assertEquals(
            FirebaseProjectDecision.Reason.MISMATCH,
            refusal("alehulsh-app", "alehulshapp").reason,
        )
    }

    // ---- fail closed ------------------------------------------------------

    @Test
    fun `a build that declared no project is refused`() {
        for (missing in listOf(null, "", "   ", "\n")) {
            val r = refusal(missing, "alehulsh-app")
            assertEquals(
                "expected EXPECTED_MISSING for ${missing?.let { "'$it'" } ?: "null"}",
                FirebaseProjectDecision.Reason.EXPECTED_MISSING, r.reason,
            )
        }
    }

    @Test
    fun `an unresolved Firebase project is refused`() {
        // FirebaseApp.getInstance() throws when nothing is initialised, which
        // the guard maps to null. That must not be read as "no objection".
        for (missing in listOf(null, "", "  ")) {
            assertEquals(
                FirebaseProjectDecision.Reason.ACTUAL_MISSING,
                refusal("alehulsh-app", missing).reason,
            )
        }
    }

    @Test
    fun `neither side present is still a refusal`() {
        assertFalse(FirebaseProjectDecision.isAllowed(null, null))
        // Reported as the build's fault, which is the actionable one.
        assertEquals(
            FirebaseProjectDecision.Reason.EXPECTED_MISSING,
            refusal(null, null).reason,
        )
    }

    @Test
    fun `two blank strings are not treated as equal`() {
        // The bug this guards against: a naive `expected == actual` would
        // ALLOW this, because "" == "".
        assertFalse(FirebaseProjectDecision.isAllowed("", ""))
    }

    // ---- what gets logged -------------------------------------------------

    @Test
    fun `refusal detail carries project ids and nothing else`() {
        val r = refusal("alehulsh-dev", "alehulsh-app")
        // A project id is not a secret and holds no personal data, which is
        // what makes it loggable. Nothing else may appear.
        for (forbidden in listOf("token", "key", "password", "uid", "phone", "@", "AIza")) {
            assertFalse(
                "refusal detail leaked '$forbidden': ${r.detail}",
                r.detail.contains(forbidden, ignoreCase = true),
            )
        }
    }
}
