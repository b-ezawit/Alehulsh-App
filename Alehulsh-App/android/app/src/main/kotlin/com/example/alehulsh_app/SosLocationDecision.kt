package com.example.alehulsh_app

/**
 * Decides what an SOS alert may claim about where she is.
 *
 * Deliberately free of Android and Firebase types so the one decision that can
 * send responders to the wrong place runs as a plain JVM unit test. The
 * dispatcher reads the platform [android.location.Location] and hands the three
 * primitives below to [decide]; everything else about that decision lives here.
 *
 * The rule it enforces: a coordinate is published only when it is genuinely
 * known, and it is called current only when freshness can actually be
 * established. Nothing is invented to fill a gap - this replaces a fallback
 * that wrote Addis Ababa city centre (9.0125, 38.7636) whenever GPS failed.
 */
data class SosLocation(
    /** Null when no trustworthy position exists. Never a stand-in value. */
    val latitude: Double?,
    val longitude: Double?,
    /**
     * Empty when there is no position. An empty geohash falls outside every
     * geohash range query, which is how an unlocatable alert stays out of
     * proximity matching.
     */
    val geohash: String,
    /** Display string. Never claims "Live GPS" without a fresh, valid fix. */
    val label: String,
    /** Age of the fix, or null when it could not be established. Never negative. */
    val ageMs: Long?,
) {
    /** Whether a `geo` field (geohash + GeoPoint) may be written at all. */
    val hasLocation: Boolean get() = latitude != null && longitude != null
}

object SosLocationDecision {

    /**
     * At or under this age a fix is reported as current.
     *
     * A judgment call, not a measured product requirement: long enough to
     * cover the gap between providers refreshing, short enough that she has
     * probably not moved far. Boundary is inclusive - exactly this age still
     * counts as live. NEEDS PRODUCT REVIEW.
     */
    const val FRESH_FIX_MS: Long = 2 * 60 * 1000L

    const val LABEL_UNAVAILABLE = "Location unavailable"
    const val LABEL_LIVE = "Live GPS"
    /** Used when a position exists but its age cannot be trusted. */
    const val LABEL_AGE_UNKNOWN = "Last known location (age unknown)"

    /** The single representation of "we do not know where she is". */
    val UNAVAILABLE = SosLocation(
        latitude = null,
        longitude = null,
        geohash = "",
        label = LABEL_UNAVAILABLE,
        ageMs = null,
    )

    /**
     * @param ageMs how long ago the fix was taken, ideally from a monotonic
     *   clock. Null when unknown. A negative value means the device clock
     *   moved, and is treated as unknown rather than shown.
     */
    fun decide(
        latitude: Double?,
        longitude: Double?,
        ageMs: Long?,
        /**
         * Horizontal accuracy the provider reported, in metres. Null when it
         * reported none. Used as EVIDENCE that a fix is real - never as a
         * quality threshold; see [isUsableCoordinate].
         */
        accuracyMeters: Double? = null,
    ): SosLocation {
        if (!isUsableCoordinate(latitude, longitude, accuracyMeters)) return UNAVAILABLE

        val lat = latitude!!
        val lng = longitude!!
        val geohash = GeoHash.encode(lat, lng, 9)

        // Unknown or impossible age: keep the position, withdraw the claim that
        // it is current. Discarding it would throw away a real starting point
        // for someone looking for her; calling it live would be a lie.
        if (ageMs == null || ageMs < 0L) {
            return SosLocation(lat, lng, geohash, LABEL_AGE_UNKNOWN, null)
        }

        val label = if (ageMs <= FRESH_FIX_MS) {
            LABEL_LIVE
        } else {
            "Last known location (${ageMs / 60_000L} min old)"
        }
        return SosLocation(lat, lng, geohash, label, ageMs)
    }

    /**
     * Whether a coordinate may be published as her position.
     *
     * Two kinds of rejection, deliberately kept apart:
     *
     * STRUCTURAL - NaN, infinity, or outside the valid range. These are not
     * points on Earth under any interpretation, so they are rejected whatever
     * the provider says. No geography is assumed: the poles, the antimeridian
     * and a zero on a single axis are all legitimate and are kept.
     *
     * EVIDENTIAL - exactly (0, 0). This is a real place, so it is NOT rejected
     * for being geographically unlikely. It is rejected only when the provider
     * offered no evidence that it measured anything: (0, 0) is the value a
     * location struct holds when it was never populated, so a (0, 0) carrying
     * no accuracy - or an impossible accuracy of zero - is an uninitialised
     * reading rather than a fix. A (0, 0) that arrives WITH plausible accuracy
     * metadata is treated as genuine and published.
     *
     * Deliberately NOT implemented: an accuracy threshold. A 2 km fix is still
     * a real position and a far better starting point than "unknown", so no
     * fix is discarded for being imprecise. Accuracy is read here only as
     * evidence of measurement, never as a quality bar.
     *
     * Limitation: the premise that an uninitialised reading lacks accuracy
     * metadata is not verified against real provider behaviour on hardware.
     * See the device-test procedure in the task report.
     */
    fun isUsableCoordinate(
        latitude: Double?,
        longitude: Double?,
        accuracyMeters: Double? = null,
    ): Boolean {
        if (latitude == null || longitude == null) return false

        // Structural.
        if (latitude.isNaN() || longitude.isNaN()) return false
        if (latitude.isInfinite() || longitude.isInfinite()) return false
        if (latitude < -90.0 || latitude > 90.0) return false
        if (longitude < -180.0 || longitude > 180.0) return false

        // Evidential, and only for the uninitialised-struct value.
        if (latitude == 0.0 && longitude == 0.0) {
            return hasMeasurementEvidence(accuracyMeters)
        }
        return true
    }

    /** Accuracy that could only come from an actual measurement. */
    private fun hasMeasurementEvidence(accuracyMeters: Double?): Boolean {
        if (accuracyMeters == null) return false
        if (accuracyMeters.isNaN() || accuracyMeters.isInfinite()) return false
        return accuracyMeters > 0.0
    }
}
