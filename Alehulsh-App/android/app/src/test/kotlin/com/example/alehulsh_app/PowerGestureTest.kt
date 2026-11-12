package com.example.alehulsh_app

import org.junit.Assert.*
import org.junit.Test

class PowerGestureTest {
    @Test fun duplicateTimestampCannotManufactureFivePhysicalPresses() {
        val gesture=PowerGesture()
        for(i in 0..10) assertFalse(gesture.press(100))
        for(t in listOf(200L,300L,400L)) assertFalse(gesture.press(t))
        assertTrue(gesture.press(500))
    }

    @Test fun acceptsTheWindowBoundaryButNotAnOverlongGesture() {
        val detector = PowerGesture()
        for (time in listOf(0L, 1000L, 2000L, 3000L)) assertFalse(detector.press(time))
        assertTrue(detector.press(4000))
        for (time in listOf(5000L, 6000L, 7000L, 8000L, 9001L)) assertFalse(detector.press(time))
    }
    @Test fun eventSourceRejectsSyntheticRepeatKeyUpAndOtherKeys() {
        val source = PowerKeySource()
        for (i in 0L..9L) {
            assertFalse(source.event(true, true, true, false, 0, i))
            assertFalse(source.event(true, true, true, true, 1, i))
            assertFalse(source.event(true, true, false, true, 0, i))
            assertFalse(source.event(true, false, true, true, 0, i))
        }
        for (i in 10L..13L) assertFalse(source.event(true, true, true, true, 0, i))
        assertTrue(source.event(true, true, true, true, 0, 14))
    }
    @Test fun disableAndInterruptCannotCarryPartialGesturesIntoANewSession() {
        val source = PowerKeySource()
        for (i in 0L..3L) assertFalse(source.event(true, true, true, true, 0, i))
        assertFalse(source.event(false, true, true, true, 0, 4))
        assertFalse(source.event(true, true, true, true, 0, 5))
        source.reset()
        for (i in 6L..9L) assertFalse(source.event(true, true, true, true, 0, i))
        assertTrue(source.event(true, true, true, true, 0, 10))
    }
    @Test fun requiresFiveDeliberatePresses() {
        val detector = PowerGesture()
        for (time in listOf(0L, 500L, 1000L, 1500L)) assertFalse(detector.press(time))
        assertTrue(detector.press(2000))
        assertFalse(detector.press(2200))
    }
    @Test fun longGapAndClockRewindResetTheGesture() {
        val detector = PowerGesture()
        for (time in listOf(0L, 500L, 1000L, 2301L, 2500L)) assertFalse(detector.press(time))
        assertFalse(detector.press(1))
        assertFalse(detector.press(-1))
    }
    @Test fun aNewGestureIsPossibleImmediatelyAfterReset() {
        val detector = PowerGesture()
        detector.press(0); detector.reset()
        for (time in listOf(10L, 20L, 30L, 40L)) assertFalse(detector.press(time))
        assertTrue(detector.press(50))
    }
}
