package com.example.alehulsh_app
import org.junit.Test
import org.junit.Assert.*
class PushIntentRevisionTest {
    @Test fun revisionsRemainStrictlyOrderedAndExactlyRepresentable(){
        assertEquals(1L,PushIntentRevision.increment(0));assertEquals(42L,PushIntentRevision.increment(41))
        assertEquals(9007199254740991L,PushIntentRevision.increment(9007199254740990L))
    }
    @Test fun corruptOrExhaustedCountersFailClosed(){
        for(value in listOf(-1L,9007199254740991L,Long.MAX_VALUE)){
            try{PushIntentRevision.increment(value);fail("counter must be refused")}catch(_:IllegalArgumentException){}
        }
    }
}
