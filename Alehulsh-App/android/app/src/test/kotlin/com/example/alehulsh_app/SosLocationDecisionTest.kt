package com.example.alehulsh_app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression cover for the native SOS location decision.
 *
 * Exercises the production object directly - SosLocationDecision.decide is the
 * same call AlehulshSosDispatcher makes - so these cannot pass against a
 * reimplementation that drifted from what ships.
 *
 * The defect being guarded: the dispatcher used to substitute
 * (9.0125, 38.7636), Addis Ababa city centre, whenever no fix was available,
 * and labelled every alert "Live GPS" regardless of the fix's age.
 */
class SosLocationDecisionTest {

    private val lat = 8.9956
    private val lng = 38.7897
    private val fresh = 30_000L            // 30s
    private val stale = 45 * 60_000L       // 45 min

    // ---- 1. fresh valid fix ------------------------------------------------

    @Test
    fun `fresh fix keeps the real coordinates`() {
        val r = SosLocationDecision.decide(lat, lng, fresh)
        assertEquals(lat, r.latitude!!, 0.0)
        assertEquals(lng, r.longitude!!, 0.0)
        assertTrue(r.hasLocation)
    }

    @Test
    fun `fresh fix produces a geohash matching the coordinates`() {
        val r = SosLocationDecision.decide(lat, lng, fresh)
        assertEquals(GeoHash.encode(lat, lng, 9), r.geohash)
        assertTrue(r.geohash.isNotEmpty())
    }

    @Test
    fun `fresh fix is labelled as live`() {
        assertEquals(SosLocationDecision.LABEL_LIVE, SosLocationDecision.decide(lat, lng, fresh).label)
    }

    // ---- 2. stale valid fix ------------------------------------------------

    @Test
    fun `stale fix keeps its coordinates but is not called live`() {
        val r = SosLocationDecision.decide(lat, lng, stale)
        // Discarding it would throw away a real starting point for whoever is
        // looking for her; only the claim that it is current is withdrawn.
        assertEquals(lat, r.latitude!!, 0.0)
        assertTrue(r.hasLocation)
        assertFalse(r.label == SosLocationDecision.LABEL_LIVE)
    }

    @Test
    fun `stale fix reports its age in the label`() {
        val r = SosLocationDecision.decide(lat, lng, stale)
        assertTrue("label was '${r.label}'", r.label.contains("Last known location"))
        assertTrue("label was '${r.label}'", r.label.contains("45 min"))
    }

    // ---- 3. no fix ---------------------------------------------------------

    @Test
    fun `no fix yields no coordinates, no geohash, no geo field`() {
        val r = SosLocationDecision.decide(null, null, null)
        assertNull(r.latitude)
        assertNull(r.longitude)
        assertEquals("", r.geohash)
        assertFalse("a geo field must not be written", r.hasLocation)
        assertEquals(SosLocationDecision.LABEL_UNAVAILABLE, r.label)
    }

    @Test
    fun `no fix never substitutes the old Addis fallback`() {
        val r = SosLocationDecision.decide(null, null, null)
        // The exact values the dispatcher used to invent.
        assertFalse(r.latitude == 9.0125)
        assertFalse(r.longitude == 38.7636)
    }

    @Test
    fun `a half coordinate is not a location`() {
        assertFalse(SosLocationDecision.decide(lat, null, fresh).hasLocation)
        assertFalse(SosLocationDecision.decide(null, lng, fresh).hasLocation)
    }

    // ---- 4. invalid coordinates -------------------------------------------

    @Test
    fun `NaN and infinite coordinates are rejected`() {
        for (bad in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertFalse("lat=$bad", SosLocationDecision.decide(bad, lng, fresh).hasLocation)
            assertFalse("lng=$bad", SosLocationDecision.decide(lat, bad, fresh).hasLocation)
        }
    }

    @Test
    fun `out of range coordinates are rejected`() {
        assertFalse(SosLocationDecision.decide(90.1, lng, fresh).hasLocation)
        assertFalse(SosLocationDecision.decide(-90.1, lng, fresh).hasLocation)
        assertFalse(SosLocationDecision.decide(lat, 180.1, fresh).hasLocation)
        assertFalse(SosLocationDecision.decide(lat, -180.1, fresh).hasLocation)
    }

    @Test
    fun `the poles and the antimeridian remain valid`() {
        // Range checks must be inclusive - rejecting a real extreme would
        // silently strip a genuine position.
        assertTrue(SosLocationDecision.decide(90.0, 180.0, fresh).hasLocation)
        assertTrue(SosLocationDecision.decide(-90.0, -180.0, fresh).hasLocation)
    }

    // (0,0) policy: rejected ONLY as an uninitialised reading - that is, when
    // the provider offered no evidence it measured anything. It is a real
    // place and is published when accuracy metadata accompanies it.

    @Test
    fun `zero zero with no accuracy evidence is treated as no fix`() {
        val r = SosLocationDecision.decide(0.0, 0.0, fresh, accuracyMeters = null)
        assertFalse(r.hasLocation)
        assertEquals(SosLocationDecision.LABEL_UNAVAILABLE, r.label)
    }

    @Test
    fun `zero zero with zero accuracy is treated as no fix`() {
        // 0 m accuracy is not achievable; it is an unpopulated struct.
        val r = SosLocationDecision.decide(0.0, 0.0, fresh, accuracyMeters = 0.0)
        assertFalse(r.hasLocation)
    }

    @Test
    fun `zero zero WITH accuracy evidence is published`() {
        // Null Island is open ocean, but "unlikely" is not "invalid". A fix
        // the provider actually measured is kept, wherever it is.
        val r = SosLocationDecision.decide(0.0, 0.0, fresh, accuracyMeters = 12.5)
        assertTrue(r.hasLocation)
        assertEquals(0.0, r.latitude!!, 0.0)
        assertEquals(SosLocationDecision.LABEL_LIVE, r.label)
    }

    @Test
    fun `NaN or infinite accuracy is not evidence`() {
        for (bad in listOf(Double.NaN, Double.POSITIVE_INFINITY)) {
            assertFalse("accuracy=$bad", SosLocationDecision.decide(0.0, 0.0, fresh, bad).hasLocation)
        }
    }

    @Test
    fun `a poor accuracy fix is never discarded`() {
        // No quality threshold: a 2 km fix is a real position and a far better
        // starting point than "unknown".
        val r = SosLocationDecision.decide(lat, lng, fresh, accuracyMeters = 2000.0)
        assertTrue(r.hasLocation)
        assertEquals(lat, r.latitude!!, 0.0)
    }

    @Test
    fun `a normal coordinate needs no accuracy evidence`() {
        // Accuracy gates only the uninitialised-struct value, nothing else.
        assertTrue(SosLocationDecision.decide(lat, lng, fresh, accuracyMeters = null).hasLocation)
    }

    @Test
    fun `a zero on one axis only is still a real place`() {
        assertTrue(SosLocationDecision.decide(0.0, 38.7897, fresh).hasLocation)
        assertTrue(SosLocationDecision.decide(8.9956, 0.0, fresh).hasLocation)
    }

    // ---- 5. unknown age ----------------------------------------------------

    @Test
    fun `an unknown age never claims a live fix`() {
        val r = SosLocationDecision.decide(lat, lng, null)
        assertTrue(r.hasLocation)
        assertEquals(SosLocationDecision.LABEL_AGE_UNKNOWN, r.label)
        assertNull(r.ageMs)
    }

    // ---- 6. future timestamp / clock anomaly -------------------------------

    @Test
    fun `a negative age is treated as unknown, not shown`() {
        // Device clock moved backwards, or the fix is stamped in the future.
        val r = SosLocationDecision.decide(lat, lng, -5_000L)
        assertEquals(SosLocationDecision.LABEL_AGE_UNKNOWN, r.label)
        assertNull("a negative age must never surface", r.ageMs)
        assertFalse(r.label.contains("-"))
    }

    @Test
    fun `a clock anomaly keeps the coordinates`() {
        val r = SosLocationDecision.decide(lat, lng, -5_000L)
        assertTrue(r.hasLocation)
        assertEquals(lat, r.latitude!!, 0.0)
    }

    // ---- 7. freshness boundary --------------------------------------------
    // Semantics: the boundary is INCLUSIVE - exactly FRESH_FIX_MS is live.

    @Test
    fun `just below the boundary is live`() {
        val r = SosLocationDecision.decide(lat, lng, SosLocationDecision.FRESH_FIX_MS - 1)
        assertEquals(SosLocationDecision.LABEL_LIVE, r.label)
    }

    @Test
    fun `exactly at the boundary is live`() {
        val r = SosLocationDecision.decide(lat, lng, SosLocationDecision.FRESH_FIX_MS)
        assertEquals(SosLocationDecision.LABEL_LIVE, r.label)
    }

    @Test
    fun `just above the boundary is no longer live`() {
        val r = SosLocationDecision.decide(lat, lng, SosLocationDecision.FRESH_FIX_MS + 1)
        assertFalse(r.label == SosLocationDecision.LABEL_LIVE)
        assertTrue(r.label.contains("Last known location"))
    }

    @Test
    fun `a zero age is live`() {
        assertEquals(SosLocationDecision.LABEL_LIVE, SosLocationDecision.decide(lat, lng, 0L).label)
    }

    // ---- 8. proximity matching --------------------------------------------

    @Test
    fun `an unlocatable alert cannot be geographically matched`() {
        val r = SosLocationDecision.decide(null, null, null)
        // Empty geohash falls outside every geohash range query, and
        // hasLocation false means no GeoPoint is written at all.
        assertEquals("", r.geohash)
        assertFalse(r.hasLocation)
    }

    @Test
    fun `a located alert can be matched`() {
        val r = SosLocationDecision.decide(lat, lng, fresh)
        assertTrue(r.geohash.isNotEmpty())
        assertTrue(r.hasLocation)
    }

    @Test
    fun `rejected coordinates are not matchable either`() {
        // An invalid fix must be as unmatchable as a missing one.
        val r = SosLocationDecision.decide(Double.NaN, lng, fresh)
        assertEquals("", r.geohash)
        assertFalse(r.hasLocation)
    }

    // ---- 10. the label is correct for every location state ----------------

    @Test
    fun `every state yields its own distinct, honest label`() {
        assertEquals(SosLocationDecision.LABEL_LIVE,
            SosLocationDecision.decide(lat, lng, fresh).label)
        assertTrue(SosLocationDecision.decide(lat, lng, stale).label.startsWith("Last known location ("))
        assertEquals(SosLocationDecision.LABEL_AGE_UNKNOWN,
            SosLocationDecision.decide(lat, lng, null).label)
        assertEquals(SosLocationDecision.LABEL_UNAVAILABLE,
            SosLocationDecision.decide(null, null, null).label)
    }

    @Test
    fun `only a fresh valid fix is ever labelled live`() {
        // Exhaustive guard on the one claim that matters.
        val notLive = listOf(
            SosLocationDecision.decide(lat, lng, stale),
            SosLocationDecision.decide(lat, lng, null),
            SosLocationDecision.decide(lat, lng, -1L),
            SosLocationDecision.decide(null, null, fresh),
            SosLocationDecision.decide(Double.NaN, lng, fresh),
            SosLocationDecision.decide(0.0, 0.0, fresh, accuracyMeters = null),
        )
        for (r in notLive) {
            assertFalse("wrongly live: ${r.label}", r.label == SosLocationDecision.LABEL_LIVE)
        }
    }

    // ---- 12. nothing is ever fabricated -----------------------------------

    @Test
    fun `no unavailable result carries any placeholder value`() {
        val unavailable = listOf(
            SosLocationDecision.decide(null, null, null),
            SosLocationDecision.decide(Double.NaN, lng, fresh),
            SosLocationDecision.decide(91.0, lng, fresh),
            SosLocationDecision.decide(0.0, 0.0, fresh, accuracyMeters = null),
        )
        for (r in unavailable) {
            assertNull(r.latitude)
            assertNull(r.longitude)
            assertEquals("", r.geohash)
            assertNull(r.ageMs)
            assertFalse(r.hasLocation)
        }
    }

    @Test
    fun `the shared UNAVAILABLE value is itself clean`() {
        val u = SosLocationDecision.UNAVAILABLE
        assertNull(u.latitude)
        assertNull(u.longitude)
        assertEquals("", u.geohash)
        assertEquals("Location unavailable", u.label)
    }

    // ---- 13. permission denied / services off / no fix --------------------

    @Test
    fun `the states a denied permission or disabled provider produce`() {
        // lastKnownLocation() returns null for a denied permission, a disabled
        // provider, and an empty cache alike. The decision cannot tell them
        // apart - and must not: all three mean the same thing to her.
        val r = SosLocationDecision.decide(null, null, null)
        assertEquals(SosLocationDecision.UNAVAILABLE, r)
    }
}
