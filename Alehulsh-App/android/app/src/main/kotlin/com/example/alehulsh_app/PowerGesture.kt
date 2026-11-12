package com.example.alehulsh_app

/** Deliberate physical presses only; callers supply monotonic elapsed time. */
class PowerGesture {
    private var first: Long? = null
    private var last: Long? = null
    private var count = 0
    fun press(now: Long): Boolean {
        val previous = last
        if (previous != null && now == previous) return false
        if (now < 0 || (previous != null && (now < previous || now - previous > 1200)) ||
            (first != null && now - first!! > 4000)) reset()
        if (now < 0) return false
        if (first == null) first = now
        last = now
        count++
        if (count < 5) return false
        reset()
        return true
    }
    fun reset() { first = null; last = null; count = 0 }
}

/** Event admission shared with the Android service. Screen/window events never enter it. */
class PowerKeySource(private val gesture: PowerGesture = PowerGesture()) {
    fun event(enabled: Boolean, power: Boolean, down: Boolean, system: Boolean,
              repeatCount: Int, now: Long): Boolean {
        if (!enabled) { gesture.reset(); return false }
        if (!power || !down || !system || repeatCount != 0) return false
        return gesture.press(now)
    }
    fun reset() = gesture.reset()
}
