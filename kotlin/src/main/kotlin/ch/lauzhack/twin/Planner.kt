package ch.lauzhack.twin

import kotlin.math.max
import kotlin.math.min

/** Journey planner on the twin's live state (src/planner.ts): Connection Scan, repeated for real alternatives. */
private const val TRANSFER_MS = 4 * 60_000.0
private const val HORIZON_MS = 6 * 3600_000L

private fun place(k: Int): Map<String, Any?> = obj("id" to stops[k].id, "name" to stops[k].name, "lon" to stops[k].lon, "lat" to stops[k].lat)
private fun r5(x: Double) = jsRound(x * 1e5) / 1e5

class LegIncident(val id: String, val title: String, val severity: String, val source: String) : JsonLike {
    override fun toJson() = obj("id" to id, "title" to title, "severity" to severity, "source" to source)
}

class Leg(
    val trainId: String, val line: String, val category: String, val headsign: String,
    val fromId: Int, val plannedDep: Double, val expectedDep: Double, val toId: Int, val plannedArr: Double, val expectedArr: Double,
    val stopsBetween: Int, val delaySec: Int, val status: String, val incidents: List<LegIncident>, var note: String? = null,
) {
    fun toMap(): LinkedHashMap<String, Any?> = obj(
        "trainId" to trainId, "line" to line, "category" to category, "headsign" to headsign,
        "from" to LinkedHashMap(place(fromId)).also { it["plannedDep"] = plannedDep; it["expectedDep"] = expectedDep },
        "to" to LinkedHashMap(place(toId)).also { it["plannedArr"] = plannedArr; it["expectedArr"] = expectedArr },
        "stopsBetween" to stopsBetween, "delaySec" to delaySec, "status" to status, "incidents" to incidents, "note" to (note ?: Undefined),
    )
    val fromStopId get() = stops[fromId].id
    val toStopId get() = stops[toId].id
    val fromName get() = stops[fromId].name
    val toName get() = stops[toId].name
}

class Journey(
    val id: String, val departure: Double, val arrival: Double, val plannedDeparture: Double, val plannedArrival: Double, val durationMin: Int,
    val transfers: Int, val arrivalDelayMin: Int, val warnings: MutableList<String>, val legs: List<Leg>,
) {
    var kind: String? = null
    var uncertain: Boolean? = null
    var fastest: Boolean? = null
    var nextServiceDay: Boolean? = null
    var corridor: List<String>? = null
    var dominated: Boolean? = null
    var waitsForReopening: Boolean? = null
    fun toMap(): LinkedHashMap<String, Any?> = obj(
        "id" to id, "departure" to departure, "arrival" to arrival, "plannedDeparture" to plannedDeparture, "plannedArrival" to plannedArrival,
        "durationMin" to durationMin, "transfers" to transfers, "arrivalDelayMin" to arrivalDelayMin, "warnings" to warnings, "legs" to legs.map { it.toMap() },
        "kind" to (kind ?: Undefined), "uncertain" to (uncertain ?: Undefined), "fastest" to (fastest ?: Undefined), "nextServiceDay" to (nextServiceDay ?: Undefined),
        "corridor" to (corridor ?: Undefined), "dominated" to (dominated ?: Undefined), "waitsForReopening" to (waitsForReopening ?: Undefined),
    )
}

private class Conn(val trip: Int, val i: Int, val dep: Double, val arr: Double, val from: Int, val to: Int)
private class Part(val trip: Int, val i: Int, val j: Int)
private class TripPart(val trip: Trip, val i: Int, val j: Int)
private class Cached(val at: Long, val journey: Journey, val parts: List<TripPart>)

private val journeys = LinkedHashMap<String, Cached>()

private var served: Set<String>? = null
private var servedDay = ""
fun resolveStation(q: String?): Int? {
    if (q.isNullOrEmpty()) return null
    stationIndex(q.trim())?.let { return it }
    val day = dayTrips().firstOrNull()?.serviceDate ?: ""
    if (served == null || servedDay != day) { served = servedStations().mapTo(HashSet()) { it.stop.id }; servedDay = day }
    val hits = searchStations(q, 40)
    val hit = hits.find { it.id in served!! } ?: hits.firstOrNull()
    return hit?.let { stationIndex(it.id) }
}

private class Closures(val blocked: (Int, Int, Double) -> Boolean, val stations: Set<Int>)
private fun closures(): Closures {
    val sections = disruptions.values.filter { it.endedAt == null && it.effect == "section_closure" && it.edges.isNotEmpty() }
    val stationSet = disruptions.values.filter { it.endedAt == null && it.effect == "station_closure" && it.station != null }.mapTo(HashSet()) { it.station!! }
    val memo = HashMap<String, Set<Int>>()
    val blocked = { a: Int, b: Int, at: Double ->
        if (sections.isEmpty()) false else {
            val key = if (a < b) "$a-$b" else "$b-$a"
            val edges = memo.getOrPut(key) { sectionEdges(stops[a], stops[b]) }
            sections.any { d -> (d.endsAt == null || at < d.endsAt!!) && edges.any { d.edges.contains(it) } }
        }
    }
    return Closures(blocked, stationSet)
}

private class Built(val trips: List<Trip>, val lives: Array<LiveTimes?>, val conns: List<Conn>)
private class ConnCache(val gen: Int, val at: Long, val after: Long, val day: List<Trip>, val value: Built)
private var connCache: ConnCache? = null
private fun connections(t: Long, after: Long): Built {
    val a = Math.floorDiv(after, 30_000L) * 30_000L
    val day = dayTrips()
    connCache?.let { if (it.gen == Effective.generation && it.day === day && t - it.at < 5000 && it.after == a) return it.value }
    val value = buildConnections(t, a)
    connCache = ConnCache(Effective.generation, t, a, day, value)
    return value
}

fun warmPlanner() { locked { val t = Clock.now(); connections(t, t) } }

private class NextDay(val date: String, val trips: List<Trip>)
@Volatile private var nextDay: NextDay? = null
@Volatile private var nextLoading = ""
private fun ensureNextDay() {
    val date = nextDate()
    if (timetableDate().isEmpty() || nextDay?.date == date || nextLoading == date) return
    nextLoading = date
    Thread {
        try { nextDay = NextDay(date, loadDayMapped(date)) } catch (_: Throwable) { nextDay = NextDay(date, emptyList()) } finally { nextLoading = "" }
    }.apply { isDaemon = true }.start()
}

private fun horizonFor(after: Long): Long {
    val z = zurich(after)
    val hour = z.time.substring(0, 2).toInt()
    if (hour >= 20) return max(after + HORIZON_MS, serviceOrigin(addDays(z.date, 1)) + 8 * 3600_000L)
    if (hour < 5) return max(after + HORIZON_MS, serviceOrigin(z.date) + 8 * 3600_000L)
    return after + HORIZON_MS
}

private fun buildConnections(t: Long, after: Long): Built {
    ensureNextDay()
    val until = horizonFor(after)
    val nd = nextDay
    val trips = if (nd != null && nd.trips.isNotEmpty() && until > serviceOrigin(nd.date)) dayTrips() + nd.trips else dayTrips()
    val lives = arrayOfNulls<LiveTimes>(trips.size)
    val conns = ArrayList<Conn>()
    val blocked = closures().blocked
    trips.forEachIndexed { ti, trip ->
        val n = trip.stops.size
        if (trip.dep[0] > until || trip.arr[n - 1] < after - 3 * 3600_000) return@forEachIndexed
        val lt = liveTimes(trip, t)
        if (lt.cancelled) return@forEachIndexed
        lives[ti] = lt
        val road = trip.cat == "EV"
        for (i in lt.from until lt.lastServed) {
            val dep = lt.dep[i]; val arr = lt.arr[i + 1]
            if (dep > until) break
            if (!road && blocked(trip.stops[i], trip.stops[i + 1], dep)) break
            if (dep < after) continue
            conns.add(Conn(ti, i, dep, arr, trip.stops[i], trip.stops[i + 1]))
        }
    }
    val sorted = conns.sortedWith(compareBy<Conn>({ it.dep }, { it.arr }))
    return Built(trips, lives, sorted)
}

private class How(val trip: Int, val board: Int, val alight: Int, val prev: Int)
private class Boarded(val k: Int, val board: Int)

/** Connection scan with a bound on the trains used: for each number of trains (1..maxTrips) the earliest arrival. */
private fun search(lives: Array<LiveTimes?>, conns: List<Conn>, from: Int, to: Int, after: Double, closed: Set<Int>, maxTrips: Int): List<List<Part>> {
    val K = maxTrips
    val best = Array(K + 1) { HashMap<Int, Double>() }
    val how = Array(K + 1) { HashMap<Int, How>() }
    best[0][from] = after
    val boarded = HashMap<Int, Boarded>()
    var lo = 0; var hi = conns.size
    while (lo < hi) { val mid = (lo + hi) shr 1; if (conns[mid].dep < after) lo = mid + 1 else hi = mid }
    val INF = Double.POSITIVE_INFINITY
    for (x in lo until conns.size) {
        val c = conns[x]
        if (c.dep > min(best[1][to] ?: INF, (best[K][to] ?: INF) + 90 * 60_000)) break
        val lt = lives[c.trip]!!
        var tk = boarded[c.trip]
        if (lt.skipped[c.i].toInt() == 0 && c.from !in closed) {
            var q = 0
            while (q < K && (tk == null || q + 1 < tk.k)) {
                val at = best[q][c.from]
                if (at == null) { q++; continue }
                if ((if (q == 0) at else at + TRANSFER_MS) > c.dep) { q++; continue }
                tk = Boarded(q + 1, x)
                boarded[c.trip] = tk
                break
            }
        }
        if (tk == null) continue
        if (lt.skipped[c.i + 1].toInt() != 0 || c.to in closed) continue
        for (q in tk.k..K) {
            if (c.arr >= (best[q][c.to] ?: INF)) break
            best[q][c.to] = c.arr
            how[q][c.to] = How(c.trip, tk.board, x, tk.k - 1)
        }
    }
    val out = ArrayList<List<Part>>()
    var last = INF
    for (q in 1..K) {
        val arr = best[q][to] ?: continue
        if (arr >= last) continue
        last = arr
        val parts = ArrayList<Part>()
        var s = to; var k = q; var guard = 0
        while (s != from && guard < K + 1 && k > 0) {
            val h = how[k][s] ?: break
            parts.add(0, Part(h.trip, conns[h.board].i, conns[h.alight].i + 1))
            s = conns[h.board].from
            k = h.prev
            guard++
        }
        if (s == from && parts.isNotEmpty()) out.add(parts)
    }
    return out
}

private fun legIncidents(trainId: String, stationIds: Set<String>): List<LegIncident> {
    val out = ArrayList<LegIncident>()
    for (i in incidents.values) {
        val sc = i.scope
        val hit = i.trainIds?.contains(trainId) == true || sc.trainId == trainId || (sc.kind == "section" && sc.from in stationIds && sc.to in stationIds) || (sc.kind == "station" && sc.station in stationIds)
        if (hit) out.add(LegIncident(i.id, i.title, i.severity, i.source ?: "staff"))
    }
    for (a in AlertsState.alerts.values) if (a.trainIds.contains(trainId) || a.stations.count { it.id in stationIds } >= 2) out.add(LegIncident(a.id, a.title, a.severity, "sbb"))
    return out
}

private fun toJourney(trips: List<Trip>, lives: Array<LiveTimes?>, parts: List<Part>): Journey {
    val legs = parts.map { (ti, i, j) ->
        val trip = trips[ti]; val lt = lives[ti]!!
        val delaySec = jsRound((lt.arr[j] - trip.arr[j]) / 1000).toInt()
        val tr = lt.train
        val held = tr != null && ((tr.mode == "sim" && tr.speed < 0.5 && tr.leg >= 0) || tr.motion == "held")
        val ids = HashSet<String>()
        for (k in i..j) ids.add(stops[trip.stops[k]].id)
        Leg(trip.trainId, trip.line, trip.cat, trip.head, trip.stops[i], trip.dep[i], lt.dep[i], trip.stops[j], trip.arr[j], lt.arr[j], j - i - 1, delaySec,
            if (held) "held" else if (delaySec >= 180) "late" else "on time", legIncidents(trip.trainId, ids))
    }
    val first = legs.first(); val last = legs.last()
    val warnings = ArrayList<String>()
    for (l in legs) {
        if (l.category == "EV") warnings.add("Replacement bus (EV) from ${l.fromName} to ${l.toName}")
        if (l.status == "held") warnings.add("${l.line} to ${l.headsign} is stopped at the moment")
        else if (l.status == "late") warnings.add("${l.line} to ${l.headsign} is about ${jsRoundL(l.delaySec / 60.0)} min late")
        for (inc in l.incidents) if (!warnings.contains(inc.title)) warnings.add(inc.title)
    }
    val key = legs.joinToString("|") { "${it.trainId}:${it.fromStopId}>${it.toStopId}" }
    return Journey(
        "j-" + sha1Hex(key).take(10), first.expectedDep, last.expectedArr, first.plannedDep, last.plannedArr,
        jsRound((last.expectedArr - first.expectedDep) / 60_000).toInt(), legs.size - 1, max(0.0, jsRound((last.expectedArr - last.plannedArr) / 60_000)).toInt(), warnings, legs,
    )
}

private operator fun Part.component1() = trip
private operator fun Part.component2() = i
private operator fun Part.component3() = j

private fun annotate(j: Journey, parts: List<Part>, trips: List<Trip>, t: Long) {
    parts.forEachIndexed { n, p ->
        val trip = trips[p.trip]
        if (trip.cat == "EV") return@forEachIndexed
        val calls = (p.i..p.j).map { stops[trip.stops[it]].id }
        for (d in disruptions.values) {
            val sc = d.scenario ?: continue
            if (d.endedAt != null || d.effect != "section_closure" || sc.b == null) continue
            if (!(calls.contains(sc.a) && calls.contains(sc.b))) continue
            val end = expectedEnd(d, t)
            val sure = sc.durationType == "UNTIL" && end != null
            val note = if (end == null) "${d.where}: no reopening time is known" else "${d.where} reopens ${if (sure) "about" else "at the earliest"} ${zurich(end).time.substring(0, 5)}"
            j.waitsForReopening = true
            if (!sure) j.uncertain = true
            if (j.legs[n].note == null) j.legs[n].note = note
            if (!j.warnings.contains(note)) j.warnings.add(0, note)
        }
    }
}

class PlanOptions(val maxTransfers: Int? = null, val via: String? = null, val includeWait: Boolean = false, val quick: Boolean = false)

private fun corridorOf(j: Journey) = j.legs.drop(1).map { it.fromName }

/** The best journeys from one station to another, earliest arrival first. */
fun plan(fromQ: String, toQ: String, after: Long = Clock.now(), limit: Int = 4, opts: PlanOptions = PlanOptions()): Map<String, Any?> {
    val from = resolveStation(fromQ); val to = resolveStation(toQ)
    if (from == null) return obj("error" to "Unknown station: $fromQ")
    if (to == null) return obj("error" to "Unknown station: $toQ")
    val via = if (!opts.via.isNullOrEmpty()) resolveStation(opts.via) else null
    if (!opts.via.isNullOrEmpty() && via == null) return obj("error" to "Unknown station: ${opts.via}")
    val maxTrips = max(1, min(4, opts.maxTransfers ?: 3)) + 1
    val t = Clock.now()
    val built = connections(t, min(after, t + HORIZON_MS))
    val trips = built.trips; val lives = built.lives; val conns = built.conns
    val closed = closures().stations
    var searches = 0
    fun run(a: Int, b: Int, at: Double, k: Int): List<List<Part>> { searches++; return search(lives, conns, a, b, at, closed, k) }
    fun arrivalOf(parts: List<Part>) = lives[parts.last().trip]!!.arr[parts.last().j]
    fun departureOf(parts: List<Part>) = lives[parts[0].trip]!!.dep[parts[0].i]
    fun chain(points: List<Int>, at: Double, budget: Int, onlyDirect: Pair<Int, Int>? = null): List<Part>? {
        var parts: List<Part> = emptyList()
        var time = at
        for (p in 0 until points.size - 1) {
            val direct = onlyDirect != null && points[p] == onlyDirect.first && points[p + 1] == onlyDirect.second
            val left = budget - parts.size - (points.size - 2 - p)
            if (left < 1) return null
            val found = run(points[p], points[p + 1], if (p == 0) time else time + TRANSFER_MS, if (direct) 1 else left)
            if (found.isEmpty()) return null
            val seg = found.last()
            parts = parts + seg
            time = lives[seg.last().trip]!!.arr[seg.last().j]
        }
        return parts.ifEmpty { null }
    }
    val found = ArrayList<Journey>()
    val seen = HashSet<String>()
    fun leaveLater(parts: List<Part>): List<Part> {
        val arr = arrivalOf(parts)
        var lo = departureOf(parts) + 60_000
        var hi = arr
        var bestParts = parts
        var it = 0
        while (it < 9 && hi - lo > 120_000) {
            val mid = Math.floor((lo + hi) / 2)
            val opt = run(from, to, mid, max(parts.size, 1)).filter { arrivalOf(it) <= arr }
            if (opt.isNotEmpty()) { bestParts = opt.last(); lo = departureOf(bestParts) + 60_000 } else hi = mid
            it++
        }
        return bestParts
    }
    fun add(parts: List<Part>, kind: String, uncertain: Boolean? = null): Journey {
        val j = toJourney(trips, lives, parts)
        j.kind = kind
        if (uncertain != null) j.uncertain = uncertain
        annotate(j, parts, trips, t)
        j.corridor = corridorOf(j)
        val h = zurich(j.departure).time.substring(0, 2).toInt()
        val ha = zurich(after).time.substring(0, 2).toInt()
        if (j.departure - after > 2 * 3600_000 && h >= 4 && h < 10 && (ha >= 20 || ha < 4)) j.nextServiceDay = true
        if (seen.contains(j.id)) return j
        seen.add(j.id)
        found.add(j)
        journeys[j.id] = Cached(t, j, parts.map { TripPart(trips[it.trip], it.i, it.j) })
        return j
    }
    var fromT = after.toDouble()
    var round = 0
    while (round < limit * 2 && found.size < limit * 2) {
        val options = if (via == null) run(from, to, fromT, maxTrips) else listOfNotNull(chain(listOf(from, via, to), fromT, maxTrips))
        if (options.isEmpty()) break
        var first = Double.POSITIVE_INFINITY
        for (parts in options) {
            first = min(first, departureOf(parts))
            add(parts, if (via == null) "best" else "via")
            if (via == null && !opts.quick && arrivalOf(parts) - departureOf(parts) > 3 * 3600_000) add(leaveLater(parts), "best")
        }
        fromT = first + 60_000
        round++
    }
    if (opts.includeWait) {
        val direct = metres(stops[from].lon, stops[from].lat, stops[to].lon, stops[to].lat)
        for (d in disruptions.values.toList()) {
            val sc = d.scenario ?: continue
            if (d.endedAt != null || d.effect != "section_closure" || sc.b == null) continue
            val a = stationIndex(sc.a)!!; val b = stationIndex(sc.b)!!
            fun dist(x: Int, y: Int) = metres(stops[x].lon, stops[x].lat, stops[y].lon, stops[y].lat)
            val (x, y) = if (dist(from, a) <= dist(from, b)) a to b else b to a
            if (dist(from, x) + dist(x, y) + dist(y, to) > 1.35 * direct + 5000) continue
            val raw = listOf(from, x, y, to)
            val points = raw.filterIndexed { i, k -> i == 0 || k != raw[i - 1] }
            val parts = chain(points, after.toDouble(), maxTrips, x to y) ?: continue
            val end = expectedEnd(d, t)
            val sure = sc.durationType == "UNTIL" && end != null
            val reopen = if (end == null) "No reopening time is known" else "${stops[x].name} - ${stops[y].name} reopens ${if (sure) "about" else "at the earliest"} ${zurich(end).time.substring(0, 5)}"
            val fresh = add(parts, "wait", !sure)
            val j = found.find { it.id == fresh.id }!!
            j.waitsForReopening = true
            j.uncertain = (j.uncertain ?: false) || !sure
            for (l in j.legs) if (l.fromStopId == stops[x].id && l.note == null) l.note = reopen
            if (!j.warnings.contains(reopen)) j.warnings.add(0, reopen)
        }
    }
    for (id in journeys.entries.toList().filter { t - it.value.at > 30 * 60_000 }.map { it.key }) journeys.remove(id)
    val bestArrival = found.minOfOrNull { it.arrival } ?: Double.POSITIVE_INFINITY
    fun beats(k: Journey, j: Journey) = k !== j && k.departure >= j.departure && k.arrival <= j.arrival && k.transfers <= j.transfers && (k.arrival < j.arrival || k.transfers < j.transfers || k.departure > j.departure)
    val night = found.any { it.nextServiceDay == true }
    val kept = ArrayList<Journey>()
    for (j in found.sortedWith(compareBy<Journey>({ it.arrival }, { it.transfers }))) {
        if (j.kind == "best" && !night && j.arrival - bestArrival > 90 * 60_000) continue
        val better = found.filter { beats(it, j) }
        if (better.isNotEmpty() && j.kind != "wait") {
            val way = j.corridor!!.joinToString(">")
            if (kept.any { it.corridor!!.joinToString(">") == way } || better.any { it.corridor!!.joinToString(">") == way }) continue
            j.dominated = true
        }
        kept.add(j)
    }
    val main = kept.filter { it.kind != "wait" }.take(limit)
    val out = (main + kept.filter { it.kind == "wait" }).sortedWith(compareBy<Journey>({ it.arrival }, { it.transfers }))
    val pick = out.find { it.uncertain != true } ?: out.firstOrNull()
    for (j in out) j.fastest = if (j === pick) true else null
    return obj(
        "from" to place(from), "to" to place(to), "generatedAt" to t, "journeys" to out.map { it.toMap() },
        "alternativesConsidered" to found.size, "corridorsConsidered" to found.mapTo(HashSet()) { it.corridor!!.joinToString(">") }.size,
        "searches" to searches, "maxTransfers" to maxTrips - 1, "via" to (via?.let { place(it) } ?: Undefined),
    )
}

/** The track a trip runs on between two of its stops, as a light LineString. */
fun tripGeometry(trip: Trip, i: Int, j: Int): Map<String, Any?> {
    val coords = ArrayList<List<Double>>()
    for (k in i until j) {
        val p = travelPath(trip.cat, stops[trip.stops[k]], stops[trip.stops[k + 1]])
        val n = p.coords.size / 2
        for (v in 0 until n) if (v % 4 == 0 || v == n - 1) coords.add(listOf(r5(p.coords[2 * v]), r5(p.coords[2 * v + 1])))
    }
    return obj("type" to "LineString", "coordinates" to coords)
}

fun journeyDetail(id: String): Map<String, Any?>? {
    val hit = journeys[id] ?: return null
    val t = Clock.now()
    val legs = hit.journey.legs.mapIndexed { k, leg ->
        val (trip, i, j) = hit.parts[k]
        val lt = liveTimes(trip, t)
        val calls = (i..j).map { s ->
            val served = !lt.cancelled && lt.skipped[s].toInt() == 0 && s >= lt.firstServed && s <= lt.lastServed
            obj(
                "id" to stops[trip.stops[s]].id, "name" to stops[trip.stops[s]].name,
                "plannedArr" to (if (s == i) null else trip.arr[s]), "expectedArr" to (if (s == i) null else jsRound(lt.arr[s])),
                "plannedDep" to (if (s == j) null else trip.dep[s]), "expectedDep" to (if (s == j) null else jsRound(lt.dep[s])), "served" to served,
            )
        }
        leg.toMap().also { it["calls"] = calls }
    }
    return hit.journey.toMap().also { it["generatedAt"] = t; it["legs"] = legs }
}
private operator fun TripPart.component1() = trip
private operator fun TripPart.component2() = i
private operator fun TripPart.component3() = j

fun journeyGeometry(id: String): Map<String, Any?>? {
    val hit = journeys[id] ?: return null
    return obj("id" to id, "legs" to hit.parts.mapIndexed { k, p -> obj("trainId" to hit.journey.legs[k].trainId, "line" to hit.journey.legs[k].line, "geometry" to tripGeometry(p.trip, p.i, p.j)) })
}

fun trainGeometry(trainId: String, fromQ: String?, toQ: String?): Map<String, Any?>? {
    val trip = byTrainId[trainId]?.trip ?: dayTrips().find { it.trainId == trainId } ?: return null
    fun stopIdx(q: String?): Int { val k = resolveStation(q) ?: return -1; return trip.stops.indexOf(k) }
    val i = if (!fromQ.isNullOrEmpty()) stopIdx(fromQ) else 0
    val j = if (!toQ.isNullOrEmpty()) stopIdx(toQ) else trip.stops.size - 1
    if (i < 0 || j < 0 || j <= i) return null
    return obj("trainId" to trainId, "geometry" to tripGeometry(trip, i, j))
}

fun sectionGeometry(fromQ: String, toQ: String): Map<String, Any?>? {
    val a = resolveStation(fromQ) ?: return null
    val b = resolveStation(toQ) ?: return null
    val edges = sectionEdges(stops[a], stops[b])
    return obj("from" to place(a), "to" to place(b), "geometry" to (if (edges.isNotEmpty()) edgesGeometry(edges) else obj("type" to "LineString", "coordinates" to listOf(listOf(stops[a].lon, stops[a].lat), listOf(stops[b].lon, stops[b].lat)))))
}

/** What a passenger at a station, on a train, or going from A to B should know right now. */
fun situation(station: String?, trainId: String?, from: String?, to: String?): Map<String, Any?> {
    val t = Clock.now()
    fun brief(i: Incident): Map<String, Any?> {
        val m = obj("id" to i.id, "title" to i.title, "where" to i.where, "severity" to i.severity, "source" to (i.source ?: "staff"), "since" to i.createdAt, "trainIds" to (i.trainIds ?: emptyList<String>()))
        if (i.source == "control") { m["description"] = i.description; m["lines"] = i.lines; m["until"] = i.until; m["durationType"] = i.durationType; m["lifecycle"] = i.lifecycle; m["bulletinVersion"] = i.bulletinVersion; m["messages"] = i.messages; m["replacementBus"] = i.replacementBus }
        return m
    }
    fun atStation(k: Int): Map<String, Any?> {
        val id = stops[k].id
        val board = stationBoard(k, t, 90, 12)
        val boardTrains = board.mapNotNull { it.trainId }.toSet()
        return obj(
            "station" to place(k),
            "incidents" to incidents.values.filter { i ->
                val sc = i.scope
                sc.station == id || sc.from == id || sc.to == id || (sc.trainId != null && sc.trainId in boardTrains) || (i.trainIds ?: emptyList()).any { it in boardTrains }
            }.map { brief(it) },
            "alerts" to AlertsState.alerts.values.filter { a -> a.stations.any { it.id == id } || a.trainIds.any { it in boardTrains } }.map { it.briefMap() },
            "departures" to board,
        )
    }
    if (!trainId.isNullOrEmpty()) {
        val tr = byTrainId[trainId] ?: return obj("error" to "Train not in service")
        val ids = HashSet<String>()
        for (k in max(0, if (tr.leg >= 0) tr.leg else tr.call) until tr.trip.stops.size) ids.add(stops[tr.trip.stops[k]].id)
        return obj(
            "train" to obj(
                "trainId" to tr.trip.trainId, "line" to tr.trip.line, "headsign" to tr.trip.head, "mode" to (if (tr.mode == "sim") "affected" else "normal"),
                "speedKmh" to jsRound(tr.speed * 3.6), "stopped" to (tr.speed < 0.5), "atStation" to (if (tr.leg < 0) stops[tr.trip.stops[tr.call]].name else null),
                "between" to (if (tr.leg >= 0) listOf(stops[tr.trip.stops[tr.leg]].name, stops[tr.trip.stops[tr.leg + 1]].name) else null), "lon" to tr.lon, "lat" to tr.lat,
            ),
            "incidents" to legIncidents(tr.trip.trainId, ids),
        )
    }
    if (!from.isNullOrEmpty() && !to.isNullOrEmpty()) {
        val a = resolveStation(from); val b = resolveStation(to)
        if (a == null || b == null) return obj("error" to "Unknown station")
        val p = plan(from, to, t, 2)
        @Suppress("UNCHECKED_CAST")
        val js = if (p.containsKey("error")) emptyList() else (p["journeys"] as List<Map<String, Any?>>)
        val way = LinkedHashSet<String>()
        for (j in js) @Suppress("UNCHECKED_CAST") way.addAll(j["warnings"] as List<String>)
        return obj("from" to atStation(a), "to" to atStation(b), "onTheWay" to way.toList())
    }
    val k = resolveStation(station) ?: return obj("error" to "Unknown station")
    return atStation(k)
}
