package ch.lauzhack.twin

import java.io.ByteArrayOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun varint(v: Long): ByteArray { val o = ByteArrayOutputStream(); var x = v; while (true) { val b = (x and 0x7f).toInt(); x = x ushr 7; if (x == 0L) { o.write(b); break }; o.write(b or 0x80) }; return o.toByteArray() }
private fun tag(n: Int, w: Int) = varint(((n shl 3) or w).toLong())
private fun vi(n: Int, v: Long) = tag(n, 0) + varint(v)
private fun ld(n: Int, b: ByteArray) = tag(n, 2) + varint(b.size.toLong()) + b
private fun st(n: Int, s: String) = ld(n, s.toByteArray())

class FeedsTest {
    @Test fun stationMapping() {
        assertEquals("8510665", rtStation("ch:1:sloid:10665:0:19728"))
        assertEquals("8503000", rtStation("8503000:0:5"))
        assertEquals("8503000", rtStation("Parent8503000"))
        assertEquals("8500001", rtStation("ch:1:sloid:1"))
    }

    @Test fun tripUpdatesDecode() {
        val arrival = vi(1, 120) + vi(2, 1000)
        val stu = vi(1, 3) + ld(2, arrival) + st(4, "ch:1:sloid:10665:0:1")
        val stuSkipped = st(4, "8503000") + vi(5, 1)
        val trip = st(1, ".tripA") + st(3, "20261122") + vi(4, 3)
        val tu = ld(1, trip) + ld(2, stu) + ld(2, stuSkipped)
        val entity = st(1, "e1") + ld(3, tu)
        val msg = ld(1, vi(3, 1700000000)) + ld(2, entity)
        val (trips, ts) = decodeTripUpdates(msg)
        assertEquals(1_700_000_000_000, ts)
        val t = trips["20261122/.tripA"]!!
        assertTrue(t.cancelled)
        assertEquals(2, t.updates.size)
        assertEquals("8510665", t.updates[0].stopId); assertEquals(120.0, t.updates[0].arrDelay); assertEquals(1000.0, t.updates[0].arrTime)
        assertNull(t.updates[0].depDelay)
        assertTrue(t.updates[1].skipped)
    }

    @Test fun negativeDelay() {
        val neg = ByteArrayOutputStream().apply { write(tag(1, 0)); var x = -60L; repeat(10) { val b = (x and 0x7f).toInt(); x = x ushr 7; write(if (it < 9) b or 0x80 else b) } }.toByteArray()
        val stu = ld(3, neg) + st(4, "8503000")
        val msg = ld(2, st(1, "e") + ld(3, ld(1, st(1, "t")) + ld(2, stu)))
        assertEquals(-60.0, decodeTripUpdates(msg).first["/t"]!!.updates[0].depDelay)
    }

    @Test fun alertsDecode() {
        val tr = { l: String, s: String -> ld(1, st(1, s) + st(2, l)) }
        val alert = ld(1, vi(1, 10) + vi(2, 20)) + ld(5, st(5, "8503000")) + ld(5, ld(4, st(1, ".x") + st(3, "20261122"))) + vi(6, 4) + ld(10, tr("de", "Hallo") + tr("en", "Hello"))
        val feed = ld(1, vi(3, 5)) + ld(2, st(1, "a") + ld(5, alert))
        val f = decodeAlerts(feed)
        assertEquals(5, f.timestamp)
        val a = f.entities[0].alert!!
        assertEquals(10L, a.periods[0].first); assertEquals(4, a.cause)
        assertEquals("8503000", a.informed[0].stopId); assertEquals(".x", a.informed[1].tripId)
        assertEquals("Hello", alertText(a.header).first)
        assertNotNull(a.header)
    }

    @Test fun severity() {
        assertEquals("info", alertSeverity("Lift out of order"))
        assertEquals("major", alertSeverity("Line interrupted between A and B"))
        assertEquals("minor", alertSeverity("Replacement bus service"))
        assertEquals("info", alertSeverity("Hello"))
    }

    @Test fun mergeKey() {
        assertEquals(alertId("S2: Zürich - Uster"), alertId("s2  Zürich – Uster"))
        assertTrue(alertId("x").startsWith("sa-") && alertId("x").length == 15)
        assertEquals("a9993e364706816aba3e25717850c26c9cd0d89d", sha1Hex("abc"))
    }

    @Test fun abroadRouteOnTinyGraph() {
        // swiss line (0,0)-(0.01,0); abroad line starts at its end and continues east
        val swiss = listOf(listOf(doubleArrayOf(8.0, 47.0), doubleArrayOf(8.01, 47.0)))
        val abroad = listOf(listOf(doubleArrayOf(8.01, 47.0), doubleArrayOf(8.02, 47.0), doubleArrayOf(8.03, 47.0)))
        val g = buildAbroadGraph(listOf(swiss, abroad))
        val r = abroadRoute(g, doubleArrayOf(8.0, 47.0), doubleArrayOf(8.03, 47.0))!!
        assertEquals(4, r.size)
        assertEquals(8.0, r.first()[0]); assertEquals(8.03, r.last()[0])
        assertNull(abroadRoute(g, doubleArrayOf(8.0, 47.0), doubleArrayOf(20.0, 50.0)))
    }
}
