package ch.lauzhack.twin

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ServerPartsTest {
    @Test fun jsonNumbersLikeJs() {
        assertEquals("""{"a":3,"b":1.5,"c":null,"d":0.00001,"e":10000000000}""", Json.str(obj("a" to 3.0, "b" to 1.5, "c" to Double.NaN, "d" to 1e-5, "e" to 1e10)))
        assertEquals("""{"x":1}""", Json.str(obj("x" to 1, "gone" to Undefined)))
    }

    private fun connect(user: String? = null, pw: String? = null, will: Boolean = false): ByteArray {
        fun u(s: String) = byteArrayOf((s.length shr 8).toByte(), s.length.toByte()) + s.toByteArray()
        var flags = 0x02
        var tail = u("cid")
        if (will) { flags = flags or 0x04; tail += u("wt") + u("wm") }
        if (user != null) { flags = flags or 0x80; tail += u(user) }
        if (pw != null) { flags = flags or 0x40; tail += u(pw) }
        val b = u("MQTT") + byteArrayOf(4, flags.toByte(), 0, 60) + tail
        return byteArrayOf(0x10) + mqttRemainingLength(b.size) + b
    }

    @Test fun parserSplitsAndJoinsPackets() {
        val a = connect(); val b = byteArrayOf(0xC0.toByte(), 0) // PINGREQ
        val p = MqttStreamParser()
        val all = a + b
        assertEquals(0, p.feed(all.copyOfRange(0, 5)).size)
        val got = p.feed(all.copyOfRange(5, all.size))
        assertEquals(2, got.size)
        assertTrue(got[0].contentEquals(a)); assertTrue(got[1].contentEquals(b))
    }

    @Test fun connectGetsCredentials() {
        val out = assertNotNull(mqttConnectWithCredentials(connect(), "bob", "pw"))
        val re = MqttStreamParser().feed(out)
        assertEquals(1, re.size)
        val s = String(out, Charsets.ISO_8859_1)
        assertTrue(s.contains("bob") && s.contains("pw") && s.contains("cid"))
        assertEquals(0xC2, out[2 + 2 + 4 + 1].toInt() and 0xFF) // flags: user, password, clean session
        // existing credentials are replaced, a will is kept
        val again = assertNotNull(mqttConnectWithCredentials(connect("old", "oldpw", will = true), "bob", "pw"))
        val t = String(again, Charsets.ISO_8859_1)
        assertTrue(!t.contains("old") && t.contains("wt") && t.contains("bob"))
    }

    @Test fun subscribeTopicsAndSuback() {
        fun u(s: String) = byteArrayOf((s.length shr 8).toByte(), s.length.toByte()) + s.toByteArray()
        val b = byteArrayOf(0, 7) + u("sbb-twin/v1/fleet") + byteArrayOf(0) + u("other/#") + byteArrayOf(1)
        val pkt = byteArrayOf(0x82.toByte()) + mqttRemainingLength(b.size) + b
        val (id, topics) = mqttSubscribeTopics(pkt)
        assertEquals(7, id); assertEquals(listOf("sbb-twin/v1/fleet", "other/#"), topics)
        assertEquals(listOf<Byte>(0x90.toByte(), 4, 0, 7, 0x80.toByte(), 0x80.toByte()), mqttSuback(7, 2).toList())
    }

    @Test fun remainingLengthMultiByte() {
        assertEquals(listOf<Byte>(0xC1.toByte(), 0x02), mqttRemainingLength(321).toList())
        val body = ByteArray(321) { 1 }
        assertEquals(1, MqttStreamParser().feed(byteArrayOf(0x30) + mqttRemainingLength(321) + body).size)
    }

    @Test fun incidentPersistRoundtrip() {
        val i = Incident("i-1", "Title", "d", "major", "x", null, Scope("section", from = "8503206", to = "8503209"), "A – B", null, createdAt = 5, updatedAt = 6, source = "staff")
        val back = incidentFromSaved(Json.parseMap(Json.str(incidentSaved(i))))
        assertEquals(Json.str(i.payload()), Json.str(back.payload()))
    }

    @Test fun disruptionPersistRoundtrip() {
        val sc = Scenario(cause = "EG_008" to "Overhead line fault", initial = "interrupted", start = 10, durationType = "UNKNOWN", until = null, a = "8503206", b = "8503209",
            measures = mutableListOf(Measure("m-1", "short_turn", 20, 15, mutableMapOf("at" to "both"))), committed = mutableMapOf("k" to 2))
        sc.bulletins.add(Bulletin("d-1", 1, 10, "en", "INFO", "T", "D\nE", listOf("S2"), listOf(BulletinMessage(1, "a", "b")), "template", "D\nE"))
        val d = Disruption("d-1", "scenario", "L", "EG_008", "section_closure", Scope("section", from = "8503206", to = "8503209"), "w", mutableMapOf("maxKmh" to 40), 10, null, null, null, mutableSetOf(3, 4), null, null, scenario = sc)
        val back = disruptionFromSaved(Json.parseMap(Json.str(disruptionSaved(d))))
        assertEquals(Json.str(disruptionSaved(d)), Json.str(disruptionSaved(back)))
        assertNull(back.endedAt)
    }
}
