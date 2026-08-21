package com.example.alehulsh_app

object GeoHash {
    private const val BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

    fun encode(latitude: Double, longitude: Double, precision: Int = 9): String {
        var minLat = -90.0
        var maxLat = 90.0
        var minLng = -180.0
        var maxLng = 180.0
        val builder = StringBuilder()
        var bit = 0
        var ch = 0
        var even = true

        while (builder.length < precision) {
            if (even) {
                val mid = (minLng + maxLng) / 2
                if (longitude >= mid) {
                    ch = ch or (1 shl (4 - bit))
                    minLng = mid
                } else {
                    maxLng = mid
                }
            } else {
                val minMid = (minLat + maxLat) / 2
                if (latitude >= minMid) {
                    ch = ch or (1 shl (4 - bit))
                    minLat = minMid
                } else {
                    maxLat = minMid
                }
            }
            even = !even
            if (bit < 4) {
                bit++
            } else {
                builder.append(BASE32[ch])
                bit = 0
                ch = 0
            }
        }
        return builder.toString()
    }
}
