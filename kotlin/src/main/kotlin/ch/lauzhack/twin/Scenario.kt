package ch.lauzhack.twin

import java.security.MessageDigest
import java.text.Collator
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.Locale

/** Scenario disruptions (src/scenario.ts): a cause on a section or station, an effect state that evolves, and the control
 *  centre's measures. Everything else (physics, effective timetable, buses, bulletins) follows from that record. */

private const val HOLD_MAX_MIN = 20
private const val BUS_HORIZON_MS = 2 * 3600_000L
private fun name(id: String) = stationIndex(id)?.let { stops[it].name } ?: id
internal fun hhmm(ms: Double) = zurich(ms.toLong()).time.substring(0, 5)
internal fun hhmm(ms: Long) = zurich(ms).time.substring(0, 5)
fun fraction(s: String): Double = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).let { d ->
    ((d[0].toLong() and 0xff) shl 24 or ((d[1].toLong() and 0xff) shl 16) or ((d[2].toLong() and 0xff) shl 8) or (d[3].toLong() and 0xff)).toDouble() / 4294967296.0
}
private fun scenarios() = disruptions.values.filter { it.scenario != null }
private val Disruption.sc: Scenario get() = scenario!!
private fun truthy(x: Any?) = when (x) { null -> false; is Boolean -> x; is Number -> x.toDouble().let { it != 0.0 && !it.isNaN() }; is String -> x.isNotEmpty(); else -> true }
/** JS `Number(x) || def` */
private fun numOr(x: Any?, def: Double): Double = jsNumber(x).let { if (it.isNaN() || it == 0.0) def else it }
/** JS `Number(x ?? def)` */
private fun numD(x: Any?, def: Double): Double = jsNumber(x ?: def)

// ---------------------------------------------------------------- input helpers
/** Epoch ms from a number (epoch ms), "HH:MM" (today, Swiss time) or an ISO date; null when there is nothing. */
fun parseTimeOrNull(v: Any?): Long? {
    if (v is Number) return if (v.toDouble().isFinite()) v.toLong() else null
    if (v is String) {
        Regex("^(\\d{1,2}):(\\d{2})$").find(v)?.let { m ->
            val date = timetableDate().ifEmpty { zurich(Clock.now()).date }
            return serviceOrigin(date) + (m.groupValues[1].toLong() * 60 + m.groupValues[2].toLong()) * 60_000
        }
        val n = runCatching { Instant.parse(v).toEpochMilli() }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(v).toInstant().toEpochMilli() }.getOrNull()
            ?: runCatching { LocalDateTime.parse(v).toInstant(ZoneOffset.UTC).toEpochMilli() }.getOrNull()
            ?: runCatching { java.time.LocalDate.parse(v).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli() }.getOrNull()
        return n ?: throw InputError("Not a time: \"$v\" (epoch ms, HH:MM or ISO)")
    }
    return null
}
fun parseTime(v: Any?, fallback: Long): Long = parseTimeOrNull(v) ?: fallback

private fun durationTypeOf(v: Any?, fallback: String): String {
    if (v == null || v == "") return fallback
    return when (v.toString().uppercase()) {
        "UNTIL" -> "UNTIL"
        "AT_LEAST", "UNTIL_AT_LEAST" -> "UNTIL_AT_LEAST"
        "UNKNOWN", "NONE" -> "UNKNOWN"
        else -> throw InputError("durationType must be UNTIL, UNTIL_AT_LEAST or UNKNOWN")
    }
}

// ---------------------------------------------------------------- where: the section's tracks and stations
private class Seg(val seq: List<Int>, val len: Double)
private class Resolved(val edges: MutableSet<Int>, val inside: List<Int>, val busStops: List<Int>)
private fun resolveSection(a: Int, b: Int): Resolved {
    val segs = ArrayList<Seg>()
    val seen = HashSet<String>()
    for (trip in dayTrips()) {
        if (trip.cat == "EV") continue
        val s = trip.stops.toList()
        val i = s.indexOf(a); val j = s.indexOf(b)
        if (i < 0 || j < 0 || Math.abs(i - j) > 12) continue
        val seq = if (i < j) s.subList(i, j + 1) else s.subList(j, i + 1).reversed()
        val key = seq.joinToString(",")
        if (!seen.add(key)) continue
        var len = 0.0
        for (k in 0 until seq.size - 1) len += pathBetween(stops[seq[k]], stops[seq[k + 1]]).len
        segs.add(Seg(seq, len))
    }
    val edges = sectionEdges(stops[a], stops[b])
    if (segs.isEmpty()) {
        if (edges.isEmpty()) throw InputError("No trains run between these stations today and no track joins them")
        return Resolved(edges, emptyList(), listOf(a, b))
    }
    val min = segs.minOf { it.len }
    val ok = segs.filter { it.len <= 1.6 * min + 2000 }
    val inside = LinkedHashSet<Int>()
    for (x in ok) {
        for (k in 0 until x.seq.size - 1) for (sp in edgeSpans(pathBetween(stops[x.seq[k]], stops[x.seq[k + 1]]))) if (sp.ref != 0) edges.add(Math.abs(sp.ref))
        for (y in x.seq.drop(1).dropLast(1)) inside.add(y)
    }
    var best = ok[0]
    for (x in ok) if (x.seq.size > best.seq.size) best = x
    return Resolved(edges, inside.toList(), best.seq)
}

private val hitMemo = HashMap<String, HashMap<String, Boolean>>()
private fun hits(d: Disruption, s1: Int, s2: Int): Boolean {
    val memo = hitMemo.getOrPut(d.id) { HashMap() }
    val key = "$s1>$s2"
    return memo.getOrPut(key) {
        val sc = d.sc
        val ids = listOf(stops[s1].id, stops[s2].id)
        ids.any { sc.inside.contains(it) } || (sc.b == null && ids.contains(sc.a)) || edgeSpans(pathBetween(stops[s1], stops[s2])).any { it.ref != 0 && d.edges.contains(Math.abs(it.ref)) }
    }
}

private fun catRank(line: String): Int {
    val c = Regex("^[A-Z]+").find(line)?.value ?: ""
    return if (c in listOf("EC", "ICE", "TGV", "RJX", "NJ", "EN")) 0 else if (c in listOf("IC", "ICN")) 1 else if (c in listOf("IR", "IRE", "IRN")) 2 else if (c == "RE") 3 else if (c == "R") 4 else if (c in listOf("S", "SN")) 5 else 6
}
private val collator: Collator = Collator.getInstance(Locale.ENGLISH)
/** JS a.localeCompare(b, "en", {numeric: true}) (approximation: digit runs by value, other runs by collation). */
fun naturalCompare(a: String, b: String): Int {
    val ta = Regex("\\d+|\\D+").findAll(a).map { it.value }.toList()
    val tb = Regex("\\d+|\\D+").findAll(b).map { it.value }.toList()
    for (i in 0 until minOf(ta.size, tb.size)) {
        val x = ta[i]; val y = tb[i]
        val c = if (x[0].isDigit() && y[0].isDigit()) java.math.BigInteger(x).compareTo(java.math.BigInteger(y)) else collator.compare(x, y)
        if (c != 0) return c
    }
    return ta.size - tb.size
}
fun byLine(a: String, b: String): Int = (catRank(a) - catRank(b)).let { if (it != 0) it else naturalCompare(a, b) }

private fun linesThrough(d: Disruption): List<String> {
    val from = d.sc.start - 60_000
    val to = d.sc.until ?: (d.sc.start + 3 * 3600_000L)
    val out = LinkedHashSet<String>()
    for (trip in dayTrips()) {
        if (trip.cat == "EV" || out.contains(trip.line)) continue
        for (k in 0 until trip.stops.size - 1)
            if (trip.dep[k] < to && trip.arr[k + 1] > from && hits(d, trip.stops[k], trip.stops[k + 1])) { out.add(trip.line); break }
    }
    val named = out.filter { Regex("\\d").containsMatchIn(it) }
    return (if (named.isNotEmpty()) named else out.toList()).sortedWith { a, b -> byLine(a, b) }
}

// ---------------------------------------------------------------- state over time
class StateAt(var state: String, var until: Long?, var durationType: String, var kmh: Double, var cancelShare: Double, val at: Double)

/** The disruption at time `at` as decided now: its effect, expected end, and the one-track settings. */
fun stateAt(d: Disruption, at: Double, now: Long = Clock.now()): StateAt {
    val sc = d.sc
    val out = StateAt(sc.initial, sc.until, sc.durationType, 40.0, 0.0, at)
    if (sc.resumedAt != null && at >= sc.resumedAt!!) { out.state = "resumed"; return out }
    for (m in sc.measures.sortedBy { it.at }) {
        if (m.announcedAt > now || m.at > at) continue
        when (m.type) {
            "partial_resumption" -> { out.state = "limited"; if (m.params["kmh"] != null) out.kmh = numOr(m.params["kmh"], 40.0) }
            "interruption" -> out.state = "interrupted"
            "one_track_open" -> { out.state = "limited"; out.kmh = numOr(m.params["kmh"] ?: 40, 40.0); out.cancelShare = Math.max(0.0, Math.min(1.0, numD(m.params["cancelShare"], 0.5))) }
            "prognosis" -> { out.until = m.params["until"].asLong(); out.durationType = m.params["durationType"] as String }
            "resume" -> { out.state = "resumed"; return out }
        }
    }
    if (out.until != null && at >= out.until!!) out.state = "resumed"
    return out
}
fun stateAt(d: Disruption, at: Long, now: Long = Clock.now()) = stateAt(d, at.toDouble(), now)

/** When service is expected back (the announced end, or a scheduled resume), null when unknown. */
fun expectedEnd(d: Disruption, now: Long = Clock.now()): Long? {
    val st = stateAt(d, now, now)
    var end = st.until
    for (m in d.sc.measures) if (m.type == "resume" && m.announcedAt <= now && m.at >= now) end = if (end == null) m.at else Math.min(end, m.at)
    return end
}
private fun announced(d: Disruption, type: String, now: Long) = d.sc.measures.filter { it.type == type && it.announcedAt <= now }
private fun sideOf(sc: Scenario, k: Int): String {
    if (sc.b == null) return "A"
    val a = stops[stationIndex(sc.a)!!]; val b = stops[stationIndex(sc.b)!!]; val s = stops[k]
    return if (metres(s.lon, s.lat, a.lon, a.lat) <= metres(s.lon, s.lat, b.lon, b.lat)) "A" else "B"
}

// ---------------------------------------------------------------- the effective timetable
private var lastRecompute = 0L
private class Touch(val trips: List<Trip>, val list: List<Pair<Trip, Int>>)
private val touching = HashMap<String, Touch>()
private fun candidates(d: Disruption, trips: List<Trip>): List<Pair<Trip, Int>> {
    touching[d.id]?.let { if (it.trips === trips) return it.list }
    val list = ArrayList<Pair<Trip, Int>>()
    for (trip in trips) {
        if (trip.cat == "EV") continue
        for (k in 0 until trip.stops.size - 1) if (hits(d, trip.stops[k], trip.stops[k + 1])) { list.add(trip to k); break }
    }
    touching[d.id] = Touch(trips, list)
    return list
}
private fun changeSignature(): Int {
    var h = tripChanges.size
    for ((key, ch) in tripChanges) for (c in "$key${ch.cut ?: ""}|${ch.holdAt ?: ""}|${ch.holdUntil?.let { Json.num(it) } ?: ""}|${ch.startAt ?: ""}") h = h * 31 + c.code
    return h
}

/** Rebuild every trip change from the scenario disruptions (committed short turns stay as they are). */
fun recompute(t: Long = Clock.now()) {
    val t0 = System.nanoTime()
    lastRecompute = t
    val before = changeSignature()
    tripChanges.clear()
    val all = scenarios()
    for (d in all) {
        for ((key, cut) in d.sc.committed) tripChanges[key] = TripChange(by = d.id, cut = cut, reason = "short_turn", committed = true)
        for ((key, startAt) in d.sc.committedStart ?: emptyMap()) tripChanges[key] = TripChange(by = d.id, startAt = startAt, reason = "short_turn", committed = true)
    }
    val trips = dayTrips()
    for (d in all) {
        if (d.endedAt != null) continue
        val sc = d.sc
        val end = expectedEnd(d, t)
        val horizon = t + 6 * 3600_000L
        for ((trip, first) in candidates(d, trips)) {
            if (tripChanges.containsKey(trip.key)) continue
            val n = trip.stops.size
            if (trip.arr[n - 1] < t - 3600_000 || trip.dep[0] > horizon) continue
            val lt = liveTimes(trip, t)
            if (lt.cancelled) continue
            val tr = lt.train
            if (tr != null && tr.leg >= 0 && hits(d, trip.stops[tr.leg], trip.stops[tr.leg + 1])) continue
            var k = -1
            for (i in Math.max(first, lt.from) until n - 1) if (hits(d, trip.stops[i], trip.stops[i + 1])) { k = i; break }
            if (k < 0) continue
            val atStation = tr != null && tr.leg < 0 && tr.call == k
            val D = Math.max(lt.dep[k], t.toDouble())
            if (!atStation && lt.dep[k] < sc.start - 60_000) continue
            val st = stateAt(d, D, t)
            if (st.state == "resumed") continue
            fun from(m: Measure) = D >= m.at && (m.withdrawAt == null || D < m.withdrawAt!!)
            val side = sideOf(sc, trip.stops[k])
            val notStarted = tr == null || (tr.leg < 0 && tr.actDep[tr.call].isNaN() && tr.call == 0)
            var after = k
            while (after < n - 1 && hits(d, trip.stops[after], trip.stops[after + 1])) after++
            fun cutAt(reason: String) {
                tripChanges[trip.key] = if (k == 0 && notStarted && after < n - 1) TripChange(by = d.id, startAt = after, reason = reason) else TripChange(by = d.id, cut = k, reason = reason)
            }
            val cancelled = announced(d, "cancel_lines", t).any { from(it) && ((it.params["lines"] as? List<*>) ?: emptyList<Any?>()).contains(trip.line) }
            if (cancelled) { cutAt("cancel_lines"); continue }
            if (st.state == "interrupted") {
                val wait = if (end == null) Double.POSITIVE_INFINITY else end - D
                val hold = announced(d, "hold", t).filter { from(it) }.lastOrNull()
                val maxWait = numD(hold?.params?.get("maxWaitMin"), HOLD_MAX_MIN.toDouble()) * 60_000
                val turn = announced(d, "short_turn", t).any { from(it) && (it.params["at"] == null || it.params["at"] == "both" || it.params["at"] == side) }
                if (turn && wait > maxWait) cutAt("short_turn")
                else tripChanges[trip.key] = TripChange(by = d.id, holdAt = k, holdUntil = end?.toDouble(), reason = "hold")
            } else if (st.cancelShare > 0 && fraction(trip.trainId) < st.cancelShare) cutAt("one_track_open")
        }
    }
    if (changeSignature() != before) Effective.generation++
    val ms = (System.nanoTime() - t0) / 1e6
    if (ms > (System.getenv("SCENARIO_WARN_MS")?.toDoubleOrNull() ?: 150.0)) System.err.println("[scenario] effective timetable took ${Math.round(ms)} ms")
}

// ---------------------------------------------------------------- replacement buses
fun busTimes(seq: List<Int>): List<Double> = seq.drop(1).mapIndexed { k, s ->
    Math.max(60.0, jsRound(metres(stops[seq[k]].lon, stops[seq[k]].lat, stops[s].lon, stops[s].lat) * 1.3 / (50 / 3.6) / 30) * 30) * 1000
}
fun sectionKm(sc: Scenario): Double {
    val a = stationIndex(sc.a)?.let { stops[it] }
    val b = sc.b?.let { stationIndex(it) }?.let { stops[it] }
    return if (a != null && b != null) metres(a.lon, a.lat, b.lon, b.lat) / 1000 else 0.0
}
private const val BUS_MAX_KM = 40
private fun busWarning(km: Double) = "Section of ${jsRoundL(km)} km: a replacement bus would not cover this in real operations"

/** Departure times (epoch ms) of a bus decision from one side between `from` and `until`. */
fun departures(m: Measure, side: String, from: Double, until: Double): List<Double> {
    val out = ArrayList<Double>()
    val pattern = (if (side == "A") m.params["minutesA"] else m.params["minutesB"]) as? List<*>
    if (pattern != null && pattern.isNotEmpty()) {
        val hour = Math.floor(from / 3600_000) * 3600_000
        val mins = pattern.map { jsNumber(it) }.sorted()
        var h = hour
        while (h < until) {
            for (mm in mins) { val x = h + mm * 60_000; if (x >= from && x < until) out.add(x) }
            h += 3600_000
        }
    } else {
        val every = Math.max(5.0, numD(m.params["everyMin"], 15.0)) * 60_000
        val first = Math.ceil((m.at + Math.max(0.0, numD(m.params["firstInMin"], 15.0)) * 60_000) / 60_000) * 60_000
        var x = first
        while (x < until) { if (x >= from) out.add(x); x += every }
    }
    return out
}
private fun makeBus(d: Disruption, m: Measure, seq: List<Int>, side: String, dep0: Double): Trip {
    val hops = busTimes(seq)
    val n = seq.size
    val arr = DoubleArray(n); val dep = DoubleArray(n)
    var x = dep0
    arr[0] = x; dep[0] = x
    for (k in 1 until n) {
        x += hops[k - 1]
        arr[k] = x
        if (k < n - 1) { x += 60_000; dep[k] = x } else dep[k] = x
    }
    val serviceDate = timetableDate().ifEmpty { zurich(dep0.toLong()).date }.replace("-", "")
    val tag = "${d.id.substring(2)}-${m.id.substring(2)}-$side${hhmm(dep0).replace(":", "")}"
    return Trip("$serviceDate/EV-$tag", "${serviceDate}_EV-$tag", "EV-$tag", serviceDate, "EV", "EV", stops[seq[n - 1]].name, seq.toIntArray(), arr, dep)
}
private val busTrips = HashMap<String, List<Trip>>()

private fun refreshBuses(d: Disruption, t: Long) {
    val sc = d.sc
    val seq = sc.busStops.mapNotNull { stationIndex(it) }
    val prev = busTrips[d.id] ?: emptyList()
    val keep = prev.filter { it.dep[0] <= t || trains.containsKey(it.key) }
    val keys = keep.map { it.key }.toHashSet()
    val next = ArrayList(keep)
    if (d.endedAt == null && seq.size >= 2) {
        val end = expectedEnd(d, t)
        for (m in announced(d, "replacement_bus", t)) {
            if (truthy(m.params["sought"]) || truthy(m.params["blocked"])) continue
            val until = Math.min(Math.min(m.withdrawAt?.toDouble() ?: Double.POSITIVE_INFINITY, (end ?: (t + BUS_HORIZON_MS)).toDouble()), (t + 6 * 3600_000L).toDouble())
            for (side in listOf("A", "B")) {
                val route = if (side == "A") seq else seq.reversed()
                for (x in departures(m, side, Math.max(t.toDouble(), m.at.toDouble()), until)) {
                    val trip = makeBus(d, m, route, side, x)
                    if (!keys.add(trip.key)) continue
                    next.add(trip)
                }
            }
        }
    }
    next.sortBy { it.dep[0] }
    busTrips[d.id] = next
    setExtraTrips(d.id, next)
}
private class FirstBuses(val a: List<Double>, val b: List<Double>)
private fun firstBuses(d: Disruption, m: Measure): FirstBuses {
    val tag = "-${m.id.substring(2)}-"
    val mine = (busTrips[d.id] ?: emptyList()).filter { it.key.contains(tag) }
    fun from(id: String) = mine.filter { stops[it.stops[0]].id == id }.map { it.dep[0] }.sorted()
    return FirstBuses(from(d.sc.a), from(d.sc.b ?: ""))
}

// ---------------------------------------------------------------- bulletins
internal fun joinAnd(xs: List<String>) = if (xs.size <= 1) xs.joinToString("") else "${xs.dropLast(1).joinToString(", ")} and ${xs.last()}"
private object L {
    fun title(state: String, place: String) = "${if (state == "resumed") "Service resumed" else if (state == "interrupted") "Interrupted service" else "Limited service"}: $place"
    fun where(a: String, b: String?) = if (b != null) "between $a and $b" else "at $a"
    fun head(state: String, where: String) = "${if (state == "interrupted") "Interrupted" else "Limited"} train service $where."
    fun cause(clause: String) = "This is due to $clause."
    fun duration(type: String, until: Long?) = if (until == null || type == "UNKNOWN") "The duration of the restriction is not known." else if (type == "UNTIL") "The restriction lasts until approx. ${hhmm(until)}." else "The restriction lasts at least until ${hhmm(until)}."
    fun lines(lines: List<String>): String? = if (lines.isNotEmpty()) (if (lines.size == 1) "Line ${lines[0]} is affected." else "Lines ${joinAnd(lines)} are affected.") else null
    const val allow = "Allow for delays and cancellations."
    const val none = "No trains are running."
    fun oneTrack(kmh: Double) = "Trains run on one track at reduced speed (${Json.num(kmh)} km/h)."
    fun bus(where: String) = "Passengers travelling $where should use the replacement bus service (EV)."
    fun sought(where: String) = "Replacement buses (EV) are being organized $where. Please allow for longer waiting times."
    fun resumed(where: String) = "The train service $where has been resumed.\nAllow for further delays and occasional cancellations."
}

private fun messages(d: Disruption, t: Long): List<BulletinMessage> {
    val sc = d.sc
    val A = name(sc.a)
    val B = sc.b?.let { name(it) }
    val where = L.where(A, B)
    val out = ArrayList<BulletinMessage>()
    for (m in sc.measures) {
        if (m.announcedAt > t) continue
        val from = if (m.at > m.announcedAt + 60_000) " from ${hhmm(m.at)}" else ""
        if (m.type == "replacement_bus" && truthy(m.params["sought"])) {
            out.add(BulletinMessage(m.announcedAt, "Replacement bus", "Replacement buses (EV) are being organized $where. Long waiting times are to be expected."))
        } else if (m.type == "replacement_bus") {
            if (truthy(m.params["blocked"])) continue
            val f = firstBuses(d, m)
            val pattern = (m.params["minutesA"] is List<*> || m.params["minutesB"] is List<*>) && f.a.isNotEmpty()
            fun mins(xs: Any?) = joinAnd(((xs as? List<*>) ?: emptyList<Any?>()).map { ":" + Json.num(jsNumber(it)).padStart(2, '0') })
            val via = sc.busStops.drop(1).dropLast(1).map { name(it) }
            val route = "Replacement buses (EV) run $where${if (via.isNotEmpty()) ", calling at ${joinAnd(via)}" else ""}."
            val times = if (pattern) "Departures from $A at ${mins(m.params["minutesA"])} and from $B at ${mins(m.params["minutesB"])} past each hour."
            else if (f.a.isNotEmpty() && f.b.isNotEmpty()) "First departures from $A at ${hhmm(f.a[0])} and from $B at ${hhmm(f.b[0])}, then every ${Json.num(numD(m.params["everyMin"], 15.0))} minutes."
            else ""
            out.add(BulletinMessage(m.announcedAt, "Replacement bus", listOf(route, times, "Please allow for longer travel times.").filter { it.isNotEmpty() }.joinToString(" ")))
            if (m.withdrawAt != null && (m.withdrawnAnnouncedAt ?: m.announcedAt) <= t && !truthy(m.params["replaced"]))
                out.add(BulletinMessage(m.withdrawnAnnouncedAt ?: m.announcedAt, "Replacement bus", "The replacement buses $where stop running at ${hhmm(m.withdrawAt!!)}."))
        } else if (m.type == "prognosis") {
            val until = m.params["until"].asLong()
            val text = if (until == null || m.params["durationType"] == "UNKNOWN") "No reopening time is known yet." else if (m.params["durationType"] == "UNTIL") "The restriction is expected to last until approx. ${hhmm(until)}." else "The restriction is expected to last at least until ${hhmm(until)}."
            out.add(BulletinMessage(m.announcedAt, "Recovery prognosis", text))
        } else if (m.type == "one_track_open" || m.type == "partial_resumption") {
            val share = numD(m.params["cancelShare"], 0.0)
            val kmh = numD(m.params["kmh"], 40.0)
            val text = if (m.type == "one_track_open") "One track $where is open again$from. Trains run at reduced speed (${Json.num(kmh)} km/h).${if (share > 0) " Some trains are cancelled $where." else ""}" else "Trains can run $where again with restrictions$from."
            out.add(BulletinMessage(m.announcedAt, "Partial takeover", text))
        } else if (m.type == "interruption") out.add(BulletinMessage(m.announcedAt, "Interruption", "No trains can run $where$from."))
        else if (m.type == "short_turn") {
            val at = if (m.params["at"] == "A") listOf(A) else if (m.params["at"] == "B" && B != null) listOf(B) else if (B != null) listOf(A, B) else listOf(A)
            out.add(BulletinMessage(m.announcedAt, "Impact on train services", "Trains end their journey at ${joinAnd(at)}$from; their remaining stops are cancelled."))
        } else if (m.type == "hold") out.add(BulletinMessage(m.announcedAt, "Impact on train services", "Trains wait ${if (B != null) "at $A and $B" else "before $A"} until the line reopens."))
        else if (m.type == "cancel_lines") {
            val lines = ((m.params["lines"] as? List<*>) ?: emptyList<Any?>()).map { it.toString() }.sortedWith { a, b -> byLine(a, b) }
            out.add(BulletinMessage(m.announcedAt, "Cancellations", "${if (lines.size == 1) "Line ${lines[0]} is" else "Lines ${joinAnd(lines)} are"} cancelled $where$from."))
        } else if (m.type == "resume") {
            if (m.at > t) out.add(BulletinMessage(m.announcedAt, "Traffic can resume", "Trains can run $where again from ${hhmm(m.at)}."))
            else out.add(BulletinMessage(Math.max(m.announcedAt, m.at), "End of disruption", "The disruption $where is over. Allow for further delays and occasional cancellations."))
        }
    }
    return out.sortedBy { it.ts }
}

class Rendered(val id: String, val lang: String, val lines: List<String>, val messages: List<BulletinMessage>, val lifecycle: String, val title: String, val description: String)

/** The public bulletin as it reads at time t (deterministic: the same record gives the same text). */
fun render(d: Disruption, t: Long): Rendered {
    val sc = d.sc
    val A = name(sc.a)
    val B = sc.b?.let { name(it) }
    val where = L.where(A, B)
    val place = if (B != null) "$A - $B" else A
    val st = stateAt(d, t, t)
    val lines = if (st.state == "interrupted") sc.lines else emptyList()
    val msgs = messages(d, t)
    if (st.state == "resumed") return Rendered(d.id, "en", lines, msgs, "ENDED", L.title("resumed", place), L.resumed(where))
    val cause = causeOf(sc.cause.first)
    val bus = busState(d, t)
    val description = listOf(
        L.head(st.state, where),
        L.cause(cause?.clauseEn ?: sc.cause.second.lowercase()),
        L.duration(st.durationType, st.until),
        L.lines(lines),
        L.allow,
        if (st.state == "interrupted") L.none else if (announced(d, "one_track_open", t).any { it.at <= t }) L.oneTrack(st.kmh) else null,
        if (bus == "running" && B != null) L.bus(where) else if (bus == "sought" && B != null) L.sought(where) else null,
    ).filterNotNull().filter { it.isNotEmpty() }.joinToString("\n")
    return Rendered(d.id, "en", lines, msgs, "INFO", L.title(st.state, place), description)
}

/** Replacement buses now: running, still being organised, or none. */
private fun busState(d: Disruption, t: Long): String? {
    val live = announced(d, "replacement_bus", t).filter { !truthy(it.params["blocked"]) && it.at <= t + 30 * 60_000 && (it.withdrawAt == null || it.withdrawAt!! > t) }
    return if (live.any { !truthy(it.params["sought"]) }) "running" else if (live.isNotEmpty()) "sought" else null
}
fun latestBulletin(d: Disruption): Bulletin? = d.scenario?.bulletins?.lastOrNull()
private fun severityOf(s: String) = if (s == "interrupted") "critical" else if (s == "limited") "major" else "info"

private fun publicIncident(d: Disruption, b: Bulletin, t: Long): Incident {
    val sc = d.sc
    val st = stateAt(d, t, t)
    val prev = incidents[d.id]
    return Incident(
        id = d.id, title = b.title, description = b.description, severity = severityOf(st.state), type = "disruption", reasonCode = sc.cause.first,
        scope = d.scope, where = d.where, geometry = d.geometry, disruptionId = d.id, source = "control", createdAt = prev?.createdAt ?: sc.start, updatedAt = t,
        cause = sc.cause, effect = st.state, lines = b.lines, durationType = st.durationType, until = st.until, lifecycle = b.lifecycle,
        bulletinVersion = b.version, messages = b.messages, replacementBus = busState(d, t) == "running",
    )
}

private fun bulletin(d: Disruption, t: Long): Bulletin? {
    val last = latestBulletin(d)
    if (last != null && t < last.ts) return null
    val r = render(d, t)
    val same = last != null && last.title == r.title && (last.template ?: last.description) == r.description && last.lifecycle == r.lifecycle &&
        Json.str(last.messages) == Json.str(r.messages) && last.lines.joinToString(",") == r.lines.joinToString(",")
    if (same) return null
    val b = Bulletin(r.id, (last?.version ?: 0) + 1, t, r.lang, r.lifecycle, r.title, r.description, r.lines, r.messages, "template", r.description)
    publishVersion(d, b, t)
    if (aiEnabled()) { val f = facts(d, t, b); Thread { reword(d, b, f) }.also { it.isDaemon = true }.start() }
    return b
}

/** The facts a bulletin states (what the model may say, and must say). */
fun facts(d: Disruption, t: Long, b: Bulletin): BulletinFacts {
    val sc = d.sc
    val st = stateAt(d, t, t)
    val bus = busState(d, t)
    return BulletinFacts(
        state = st.state, sectionA = name(sc.a), sectionB = sc.b?.let { name(it) }, cause = causeOf(sc.cause.first)?.clauseEn ?: sc.cause.second.lowercase(),
        durationType = st.durationType, until = st.until?.let { hhmm(it) }, lines = b.lines, noTrains = st.state == "interrupted",
        oneTrackKmh = if (st.state == "limited" && announced(d, "one_track_open", t).any { it.at <= t }) st.kmh.toInt() else null,
        replacementBus = bus, busStops = sc.busStops.map { name(it) },
    )
}

/** Haiku's wording of the same facts, published as the next version once it passed validation (never blocks the tick). */
private fun reword(d: Disruption, b: Bulletin, f: BulletinFacts) {
    for (lang in listOf("de", "fr", "it")) Thread { writeBulletin(f, b.description, lang, Config.bulletinBackgroundMs) }.also { it.isDaemon = true }.start()
    val r = writeBulletin(f, b.description, "en", Config.bulletinBackgroundMs)
    if (r.source != "ai" || r.text == b.description) return
    locked {
        if (latestBulletin(d) !== b || !disruptions.containsKey(d.id)) return
        val t = Clock.now()
        publishVersion(d, b.copy(version = b.version + 1, ts = t, description = r.text, source = "ai"), t)
    }
}

private val TITLES: Map<String, (String, String) -> String> = mapOf(
    "de" to { s, p -> if (s == "resumed") "Aufgehoben: Unterbruch $p" else if (s == "interrupted") "Unterbruch $p" else "Einschränkung $p" },
    "fr" to { s, p -> if (s == "resumed") "Trafic rétabli: $p" else if (s == "interrupted") "Interruption $p" else "Restriction $p" },
    "it" to { s, p -> if (s == "resumed") "Circolazione ripristinata: $p" else if (s == "interrupted") "Interruzione $p" else "Limitazioni $p" },
)

/** Translated bulletin (DE/FR/IT) or the latest EN, waited for up to the timeout; the template when it fails. */
fun bulletinIn(d: Disruption, lang: String): Any? {
    val b = latestBulletin(d) ?: return null
    val template = b.template ?: b.description
    if (lang == "en") return b
    val sc = d.sc
    val place = if (sc.b != null) "${name(sc.a)} - ${name(sc.b)}" else name(sc.a)
    val now = Clock.now()
    val st = stateAt(d, now, now)
    val r = writeBulletin(facts(d, now, b), template, lang)
    @Suppress("UNCHECKED_CAST") val base = LinkedHashMap(b.toJson() as Map<String, Any?>)
    if (r.source != "ai") { base["requestedLang"] = lang; base["translationError"] = r.errors.firstOrNull(); return base }
    base["lang"] = lang; base["title"] = TITLES[lang]!!(st.state, place); base["description"] = r.text; base["source"] = "ai"
    return base
}

private fun publishVersion(d: Disruption, b: Bulletin, t: Long) {
    val sc = d.sc
    sc.bulletins.add(b)
    if (sc.bulletins.size > 60) sc.bulletins.subList(0, sc.bulletins.size - 60).clear()
    publish("bulletins/${d.id}", obj("v" to 1) + (b.toJson() as Map<String, Any?>), retain = true, qos = 1)
    val inc = publicIncident(d, b, t)
    incidents[inc.id] = inc
    publish("incidents/${inc.id}", inc.payload(if (d.endedAt != null) "ended" else "active"), retain = true, qos = 1)
}

// ---------------------------------------------------------------- the per-second update
private val sigs = HashMap<String, String>()
private var lastBuses = 0L

/** Called every tick before the engine moves the trains (and after every control change, with force). */
fun scenarioTick(t: Long = Clock.now(), force: Boolean = false): List<Bulletin> {
    var dirty = force
    for (d in scenarios()) {
        val sc = d.sc
        if (d.endedAt != null && sc.resumedAt == null) sc.resumedAt = d.endedAt
        val st = stateAt(d, t, t)
        if (st.state == "resumed" && sc.resumedAt == null) {
            val r = sc.measures.find { it.type == "resume" && it.announcedAt <= t && it.at <= t }
            sc.resumedAt = r?.at ?: st.until ?: t
        }
        if (sc.resumedAt != null && d.endedAt == null) d.endedAt = sc.resumedAt
        if (d.endedAt == null) {
            d.effect = if (st.state == "interrupted") "section_closure" else "speed_restriction"
            d.params["maxKmh"] = st.kmh
        }
        d.endsAt = d.endedAt ?: expectedEnd(d, t)
        for ((key, ch) in tripChanges) {
            if (!ch.committed || ch.by != d.id) continue
            if (ch.cut != null) sc.committed[key] = ch.cut!!
            else if (ch.startAt != null) { if (sc.committedStart == null) sc.committedStart = LinkedHashMap(); sc.committedStart!![key] = ch.startAt!! }
        }
        val sig = "${st.state}|${d.endsAt ?: "null"}|${sc.measures.size}|${sc.measures.joinToString(",") { "${it.withdrawAt ?: ""}${if (it.at <= t) 1 else 0}" }}|${sc.committed.size}|${sc.committedStart?.size ?: 0}"
        if (sigs[d.id] != sig) { sigs[d.id] = sig; dirty = true }
    }
    if (dirty || t - lastRecompute >= 5000) recompute(t)
    if (dirty || t - lastBuses >= 60_000) { lastBuses = t; for (d in scenarios()) refreshBuses(d, t) }
    val changed = ArrayList<Bulletin>()
    for (d in scenarios()) bulletin(d, t)?.let { changed.add(it) }
    return changed
}

/** Forget a scenario disruption's derived state (its buses, bulletin and incident topics, trip changes). */
fun forget(id: String) {
    busTrips.remove(id)
    removeExtraTrips(id)
    hitMemo.remove(id); touching.remove(id); sigs.remove(id)
    tripChanges.entries.removeIf { it.value.by == id }
    clear("bulletins/$id")
    if (incidents[id]?.source == "control") { incidents.remove(id); clear("incidents/$id") }
}
fun forgetAll() {
    for (id in busTrips.keys.toList()) forget(id)
    removeExtraTrips()
    tripChanges.clear(); hitMemo.clear(); touching.clear(); sigs.clear()
}

// ---------------------------------------------------------------- control actions
private val MEASURE_TYPES = MEASURES.map { it.type }
private fun measureFrom(d: Disruption, input: Map<String, Any?>, now: Long): Measure {
    val type = (input["type"] ?: "").toString()
    if (MEASURES.none { it.type == type }) throw InputError("Unknown measure \"$type\" (one of ${MEASURE_TYPES.joinToString(", ")})")
    val skip = setOf("type", "at", "inMin", "effectiveAt", "params", "announcedAt", "label", "why", "probability")
    val rawAt = input["at"]
    val params = LinkedHashMap<String, Any?>()
    for ((k, v) in input) if (k !in skip) params[k] = v
    input["params"].asMap()?.let { params.putAll(it) }
    var whenV: Any? = input["effectiveAt"] ?: rawAt
    if (type == "short_turn" && rawAt is String && rawAt in listOf("A", "B", "both")) { params["at"] = rawAt; whenV = input["effectiveAt"] }
    val at = if (input["inMin"] != null) now + (jsNumber(input["inMin"]) * 60_000).toLong() else parseTime(whenV, now)
    val announcedAt = parseTime(input["announcedAt"], now)
    val sc = d.sc
    if (type == "replacement_bus" && sc.b == null) throw InputError("A replacement bus needs a section (from, to)")
    if (type == "replacement_bus" && !truthy(params["sought"]) && params["force"] != true && sectionKm(sc) > BUS_MAX_KM) {
        params["blocked"] = true
        sc.warnings = ((sc.warnings ?: emptyList()) + busWarning(sectionKm(sc))).distinct()
    }
    if (type == "cancel_lines") {
        val lp = params["lines"]
        val lines = if (lp is List<*>) lp.map { it.toString() } else if (lp is String) lp.split(Regex("[\\s,]+")).filter { it.isNotEmpty() } else emptyList()
        if (lines.isEmpty()) throw InputError("cancel_lines needs lines, e.g. [\"S2\", \"S25\"]")
        params["lines"] = lines
    }
    if (type == "short_turn" && params["at"] != null && params["at"].toString() !in listOf("A", "B", "both")) throw InputError("short_turn \"at\" is \"A\", \"B\" or \"both\"")
    if (type == "prognosis") {
        val until: Long? = if (params["minutes"] != null) now + (jsNumber(params["minutes"]) * 60_000).toLong() else if (params.containsKey("until") && params["until"] == null) null else parseTimeOrNull(params["until"])
        val durationType = durationTypeOf(params["durationType"], if (until == null) "UNKNOWN" else if (sc.durationType == "UNKNOWN") "UNTIL" else sc.durationType)
        params["until"] = if (durationType == "UNKNOWN" || until == null) null else Math.ceil(until / 60_000.0).toLong() * 60_000
        params["durationType"] = durationType
        params.remove("minutes")
    }
    var withdrawAt: Long? = null
    if (params.containsKey("withdrawAt") && params["withdrawAt"] != null) { withdrawAt = parseTime(params["withdrawAt"], now); params.remove("withdrawAt") }
    return Measure(newId("m-", 6), type, at, announcedAt, params, withdrawAt, if (withdrawAt != null) announcedAt else null)
}

/** Create a scenario disruption (with its initial measures). */
fun createScenario(input: Map<String, Any?>, now: Long = Clock.now()): Disruption {
    val cause = causeOf((input["cause"] ?: "").toString().let { if (input["cause"] == null) "undefined" else it })
        ?: throw InputError("Unknown cause \"${input["cause"] ?: "undefined"}\" (one of ${CAUSES.joinToString(", ") { it.code }})")
    val scope = Scope.fromMap(input["scope"].asMap())
    if (scope == null || (scope.kind != "section" && scope.kind != "station")) throw InputError("scope is {kind: \"section\", from, to} or {kind: \"station\", station}")
    val effect = (input["effect"] ?: cause.effect).toString()
    if (effect != "interrupted" && effect != "limited") throw InputError("effect is \"interrupted\" or \"limited\"")
    val start = parseTime(input["start"], now)
    val durationType = durationTypeOf(input["durationType"], cause.durationType)
    var until: Long? = null
    if (durationType != "UNKNOWN") {
        until = if (input["until"] != null) parseTime(input["until"], now) else (start + jsNumber(input["minutes"] ?: cause.minutes) * 60_000).toLong()
    }
    if (until != null) until = Math.ceil(until / 60_000.0).toLong() * 60_000
    if (until != null && until <= now) throw InputError("The end must be in the future")
    val edges: MutableSet<Int>
    var inside: List<Int> = emptyList()
    var busStops: List<Int> = emptyList()
    val a: Int
    var b: Int? = null
    if (scope.kind == "section") {
        a = stationIndex(scope.from ?: "") ?: -1
        val bb = stationIndex(scope.to ?: "") ?: -1
        if (a < 0 || bb < 0 || a == bb) throw InputError("A section needs two different known stations")
        b = bb
        val r = resolveSection(a, bb)
        edges = r.edges; inside = r.inside; busStops = r.busStops
    } else {
        a = stationIndex(scope.station ?: "") ?: -1
        if (a < 0) throw InputError("Unknown station")
        edges = edgesWithin(stops[a].lat, stops[a].lon, 0.5)
    }
    val sc = Scenario(
        cause = cause.code to cause.label, initial = effect, start = start, durationType = durationType, until = until, a = stops[a].id, b = b?.let { stops[it].id },
        inside = inside.map { stops[it].id }, busStops = busStops.map { stops[it].id }, linkedTrain = input["linkedTrain"] as? String,
    )
    val d = Disruption(
        id = newId("d-", 8), type = "scenario", label = cause.label, reasonCode = cause.code, effect = if (effect == "interrupted") "section_closure" else "speed_restriction",
        scope = scope, where = if (b != null) "${stops[a].name} – ${stops[b].name}" else stops[a].name, params = linkedMapOf("maxKmh" to 40), startedAt = start, endsAt = until,
        note = input["note"]?.toString()?.takeIf { it.isNotEmpty() }, edges = edges, station = if (b == null) a else null,
        geometry = if (scope.kind == "section") edgesGeometry(edges) else obj("type" to "Point", "coordinates" to listOf(stops[a].lon, stops[a].lat)), scenario = sc,
    )
    sc.lines = linesThrough(d)
    sc.proposal = proposal(cause, effect, if (until == null) null else (until - now) / 60_000.0)
    val km = sectionKm(sc)
    if (km > BUS_MAX_KM) {
        sc.warnings = listOf(busWarning(km))
        sc.proposal.measures = sc.proposal.measures.filter { it["type"] != "replacement_bus" }
    }
    (input["measures"] as? List<*>)?.forEach { sc.measures.add(measureFrom(d, it.asMap() ?: emptyMap(), now)) }
    if (input["applyProposal"] == true) for (p in sc.proposal.measures) sc.measures.add(measureFrom(d, p, now))
    disruptions[d.id] = d
    scenarioTick(now, true)
    return d
}

fun addMeasure(d: Disruption, input: Map<String, Any?>, now: Long = Clock.now()): Measure {
    if (d.endedAt != null) throw InputError("This disruption has ended")
    val m = measureFrom(d, input, now)
    d.sc.measures.add(m)
    scenarioTick(now, true)
    return m
}
fun acceptProposal(d: Disruption, now: Long = Clock.now()): List<Measure> {
    if (d.endedAt != null) throw InputError("This disruption has ended")
    val added = d.sc.proposal.measures.map { measureFrom(d, it, now) }
    d.sc.measures.addAll(added)
    scenarioTick(now, true)
    return added
}
fun withdrawMeasure(d: Disruption, measureId: String, at: Any?, now: Long = Clock.now(), replaced: Boolean = false): Measure {
    val m = d.sc.measures.find { it.id == measureId } ?: throw InputError("Unknown measure")
    if (replaced) m.params["replaced"] = true
    if (m.at > now && m.announcedAt <= now && at == null) d.sc.measures.remove(m)
    else if (m.type in listOf("partial_resumption", "interruption", "prognosis", "resume") && m.at <= now) throw InputError("This decision already took effect")
    else { m.withdrawAt = parseTime(at, now); m.withdrawnAnnouncedAt = now }
    scenarioTick(now, true)
    return m
}
fun setState(d: Disruption, effect: Any?, at: Any?, now: Long = Clock.now()): Measure {
    if (effect == "limited") return addMeasure(d, mapOf("type" to "partial_resumption", "at" to at), now)
    if (effect == "interrupted") return addMeasure(d, mapOf("type" to "interruption", "at" to at), now)
    if (effect == "resumed" || effect == "ended") return addMeasure(d, mapOf("type" to "resume", "at" to at), now)
    throw InputError("effect is \"interrupted\", \"limited\" or \"resumed\"")
}
fun resume(d: Disruption, at: Any?, now: Long = Clock.now()) = addMeasure(d, mapOf("type" to "resume", "at" to at), now)

// ---------------------------------------------------------------- payload
private fun measureStatus(m: Measure, t: Long): String {
    if (m.announcedAt > t) return "scheduled"
    if (m.withdrawAt != null && m.withdrawAt!! <= t) return "withdrawn"
    if (m.at > t) return "planned"
    return if (m.type in listOf("partial_resumption", "interruption", "prognosis", "resume")) "done" else "active"
}
fun measureJson(m: Measure, t: Long): Map<String, Any?> = obj(
    "id" to m.id, "type" to m.type, "at" to m.at, "announcedAt" to m.announcedAt, "params" to m.params,
    "withdrawAt" to (m.withdrawAt ?: Undefined), "withdrawnAnnouncedAt" to (m.withdrawnAnnouncedAt ?: Undefined),
    "label" to (MEASURES.find { it.type == m.type }?.label ?: m.type), "status" to measureStatus(m, t), "state" to measureStatus(m, t),
)

/** What the scenario adds to a disruption payload. */
fun scenarioFields(d: Disruption, t: Long = Clock.now()): Map<String, Any?> {
    val sc = d.sc
    val st = stateAt(d, t, t)
    val b = latestBulletin(d)
    var cut = 0; var held = 0; var late = 0
    for (ch in tripChanges.values) if (ch.by == d.id) { if (ch.cut != null) cut++ else if (ch.startAt != null) late++ else held++ }
    return obj(
        "kind" to "scenario", "cause" to sc.causeJson, "effect" to st.state, "mechanism" to d.effect, "durationType" to st.durationType, "until" to st.until,
        "expectedEnd" to (if (d.endedAt != null) null else expectedEnd(d, t)), "start" to sc.start,
        "section" to obj("a" to obj("id" to sc.a, "name" to name(sc.a)), "b" to sc.b?.let { obj("id" to it, "name" to name(it)) }, "inside" to sc.inside.map { obj("id" to it, "name" to name(it)) }),
        "busRoute" to sc.busStops.map { obj("id" to it, "name" to name(it)) },
        "measures" to sc.measures.map { measureJson(it, t) }, "proposal" to sc.proposal, "lines" to sc.lines,
        "lifecycle" to (b?.lifecycle ?: "INFO"), "bulletinVersion" to (b?.version ?: 0), "bulletin" to b, "summary" to (b?.title ?: d.label), "description" to (b?.description ?: ""),
        "impact" to obj("tripsCut" to cut, "tripsStartingAfter" to late, "tripsHeld" to held, "buses" to (busTrips[d.id]?.size ?: 0)),
        "linkedTrain" to sc.linkedTrain, "warnings" to (sc.warnings ?: emptyList()),
    )
}

/** Today's buses of a disruption (for the brief). */
internal fun busTripsOf(id: String): List<Trip> = busTrips[id] ?: emptyList()
