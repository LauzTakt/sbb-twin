package ch.lauzhack.twin

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CoreTest {
    @Test fun serviceOriginIsNoonMinus12hSwissTime() {
        // CET (UTC+1): the GTFS origin of 2026-11-22 is 2026-11-21T23:00Z; CEST (UTC+2): 2026-07-01 -> 2026-06-30T22:00Z
        assertEquals(java.time.Instant.parse("2026-11-21T23:00:00Z").toEpochMilli(), serviceOrigin("2026-11-22"))
        assertEquals(java.time.Instant.parse("2026-06-30T22:00:00Z").toEpochMilli(), serviceOrigin("2026-07-01"))
    }

    @Test fun zurichDateAndTime() {
        val z = zurich(java.time.Instant.parse("2026-11-22T22:30:15Z").toEpochMilli())
        assertEquals("2026-11-22", zurich(java.time.Instant.parse("2026-11-22T10:00:00Z").toEpochMilli()).date)
        assertEquals("2026-11-22", z.date)
        assertEquals("23:30:15", z.time)
    }

    @Test fun jsRoundRoundsHalvesUp() {
        assertEquals(3.0, jsRound(2.5)); assertEquals(-2.0, jsRound(-2.5)); assertEquals(-3.0, jsRound(-3.4))
    }

    @Test fun jsonNumbersPrintLikeJavaScript() {
        assertEquals("3", Json.num(3.0)); assertEquals("0.00001", Json.num(1e-5)); assertEquals("1.5", Json.num(1.5))
        assertEquals("null", Json.num(Double.NaN)); assertEquals("1700000000000", Json.num(1.7e12))
        assertEquals("""{"a":1,"b":[1.5,null],"c":"x"}""", Json.str(obj("a" to 1.0, "b" to listOf(1.5, Double.NaN), "c" to "x", "d" to Undefined)))
    }

    @Test fun metresIsGreatCircleScale() {
        val d = metres(8.5417, 47.3769, 7.4474, 46.9480) // Zurich - Bern, about 95 km
        assertTrue(d in 90_000.0..100_000.0, "d=$d")
    }

    @Test fun pointAtInterpolatesAlongPath() {
        val a = Stop("a", "A", 8.0, 47.0); val b = Stop("b", "B", 8.0, 47.1)
        val p = Geometry.roadPath(a, b)
        val mid = pointAt(p, p.len / 2)
        assertEquals(47.05, mid.lat, 1e-6)
        assertEquals(0.0, mid.bearing, 1e-6)
        assertEquals(47.1, pointAt(p, p.len + 1000).lat, 1e-9)
    }

    @Test fun timelineBorrowsTwentySecondDwell() {
        val t0 = 1_000_000_000.0
        val trip = Trip("k", "id", "t", "20261122", "S", "S1", "X", intArrayOf(0, 1, 2), doubleArrayOf(t0, t0 + 300_000, t0 + 600_000), doubleArrayOf(t0, t0 + 300_000, t0 + 600_000))
        val tl = timeline(trip, null)
        assertEquals(t0 + 300_000, tl.eDep[1])
        assertEquals(t0 + 280_000, tl.eArr[1])
    }
}
