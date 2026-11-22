package ch.lauzhack.twin

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ScenarioLogicTest {
    private fun facts(lines: List<String> = emptyList(), until: String? = "19:20") =
        BulletinFacts("interrupted", "Gland", "Allaman", "a fire", "UNTIL", until, lines, true, null, null, emptyList())
    private val template = "Interrupted train service between Gland and Allaman.\nThis is due to a fire.\nThe restriction lasts until approx. 19:20."

    @Test fun validatorAcceptsTemplate() = assertEquals(emptyList(), validate(template, facts(), template))
    @Test fun validatorRejectsInventions() {
        val e = validate("Interrupted between Gland and Allaman.\nFire, line S9 affected at 19:45.\nPlatform 3.", facts(), template)
        assertTrue(e.any { it.startsWith("invented line") }); assertTrue(e.any { it.startsWith("invented time") }); assertTrue(e.contains("mentions a platform"))
        assertTrue(validate("Gland Allaman 19:20", facts(), template).any { it.startsWith("line structure") })
    }
    @Test fun validatorMissingStation() = assertTrue(validate("x\ny\n19:20", facts(), template).contains("missing station Gland"))

    @Test fun naturalLineOrder() {
        assertEquals(listOf("IC1", "IC8", "IR15", "S2", "S25"), listOf("S25", "IC8", "S2", "IR15", "IC1").sortedWith { a, b -> byLine(a, b) })
        assertTrue(naturalCompare("S2", "S10") < 0)
    }
    @Test fun fractionIsStable() { val f = fraction("20261122_x"); assertTrue(f in 0.0..1.0); assertEquals(f, fraction("20261122_x")) }

    @Test fun proposalInterrupted() {
        val c = causeOf("EG_008")!!
        val p = proposal(c, "interrupted", null)
        assertEquals(listOf("short_turn", "replacement_bus"), p.measures.map { it["type"] })
        assertEquals(listOf("hold"), proposal(causeOf("EG_049")!!, "interrupted", 10.0).measures.map { it["type"] })
        assertEquals(listOf("one_track_open"), proposal(causeOf("EG_050")!!, "limited", 30.0).measures.map { it["type"] })
    }

    private fun scenario(initial: String = "interrupted", until: Long? = null) = Scenario(cause = "EG_008" to "Overhead line fault", initial = initial, start = 1000, durationType = "UNTIL", until = until, a = "1", b = "2")
    private fun disruption(sc: Scenario) = Disruption("d-1", "scenario", "x", "EG_008", "section_closure", Scope("section", "1", "2"), "w", LinkedHashMap(), 0, null, null, null, HashSet(), null, null, scenario = sc)

    @Test fun stateTransitions() {
        val sc = scenario(until = 100_000)
        sc.measures.add(Measure("m-1", "partial_resumption", 5000, 0, linkedMapOf("kmh" to 80)))
        val d = disruption(sc)
        assertEquals("interrupted", stateAt(d, 4000L, 10_000).state)
        val st = stateAt(d, 6000L, 10_000)
        assertEquals("limited", st.state); assertEquals(80.0, st.kmh)
        assertEquals("resumed", stateAt(d, 100_000L, 200_000).state)
        assertEquals(100_000L, expectedEnd(d, 10_000))
    }

    @Test fun departuresInterval() {
        val m = Measure("m-1", "replacement_bus", 0, 0, linkedMapOf("firstInMin" to 15, "everyMin" to 15))
        assertEquals(listOf(900_000.0, 1_800_000.0, 2_700_000.0), departures(m, "A", 0.0, 3_600_000.0))
    }
    @Test fun departuresPattern() {
        val m = Measure("m-1", "replacement_bus", 0, 0, linkedMapOf("minutesA" to listOf(40, 10)))
        assertEquals(listOf(600_000.0, 2_400_000.0, 4_200_000.0), departures(m, "A", 0.0, 4_800_000.0))
    }
    @Test fun joinAndText() { assertEquals("a, b and c", joinAnd(listOf("a", "b", "c"))); assertEquals("a", joinAnd(listOf("a"))) }
}
