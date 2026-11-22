package ch.lauzhack.twin

import com.fasterxml.jackson.databind.ObjectMapper
import java.io.File
import java.util.zip.GZIPInputStream
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** The twin: every train's position each second (src/engine.ts). */
class Train(
    val trip: Trip,
    var eArr: DoubleArray, // reference timeline, epoch ms
    var eDep: DoubleArray,
    var skipped: ByteArray,
) {
    var actArr = DoubleArray(trip.arr.size) { Double.NaN }
    var actDep = DoubleArray(trip.arr.size) { Double.NaN }
    var mode = "real" // real | sim
    var tau = 0.0
    var warp = 0.0
    var speed = 0.0
    var accel = 0.0
    var motion = "dwelling" // running | dwelling | held | stopped | cancelled
    var call = 0
    var leg = -1
    var s = 0.0
    var lon = 0.0
    var lat = 0.0
    var bearing = 0.0
    var edgeRef = 0
    var bav = false
    val causes = LinkedHashSet<String>()
    val holds = HashMap<String, Double>()
    var cancelled = false
    var cancelReason: String? = null
    var cancelledAt: Double? = null
    var hasRealtime = false
    var infoSig = ""
    var infoAt = 0.0
    var continuity = 0
    var pendingRecover = false
    var recovering = false
    var terminatedAt: Double? = null
}

private const val BRAKE = 0.7
private val SLOW_CATS = Regex("^(S|SN|R|RE|T|PE|BAT|D)$")
private val FAST_CATS = Regex("^(IC|ICE|IR|IRE|EC|EN|NJ|RJX|TGV|ICN)$")
private fun accelFor(cat: String) = if (cat == "EV") 0.9 else if (SLOW_CATS.matches(cat)) 0.7 else if (FAST_CATS.matches(cat)) 0.45 else 0.6

private class Prof(val s: Double, val v: Double)

/** Trapezoidal run between two stops: accelerate, cruise, brake, so that L metres take T seconds. */
private fun profile(L: Double, T: Double, a: Double, u: Double): Prof {
    if (T <= 0.5 || L <= 0.5) return Prof(if (u > 0) L else 0.0, 0.0)
    var acc = a
    var disc = acc * acc * T * T - 4 * acc * L
    if (disc < 0) { acc = (4 * L) / (T * T); disc = 0.0 }
    val v = (acc * T - sqrt(disc)) / 2
    val t1 = v / acc
    if (u <= 0) return Prof(0.0, 0.0)
    if (u >= T) return Prof(L, 0.0)
    if (u < t1) return Prof(0.5 * acc * u * u, acc * u)
    if (u > T - t1) { val r = T - u; return Prof(L - 0.5 * acc * r * r, acc * r) }
    return Prof(0.5 * acc * t1 * t1 + v * (u - t1), v)
}
private fun invert(L: Double, T: Double, a: Double, s: Double): Double {
    if (s <= 0) return 0.0
    if (s >= L) return T
    var lo = 0.0; var hi = T
    for (k in 0 until 30) { val mid = (lo + hi) / 2; if (profile(L, T, a, mid).s < s) lo = mid else hi = mid }
    return (lo + hi) / 2
}

class Timeline(val eArr: DoubleArray, val eDep: DoubleArray, val skipped: ByteArray)

/** Real timeline of a trip: planned times shifted by the live predictions, made physically consistent. */
fun timeline(trip: Trip, rt: TripLive?): Timeline {
    val n = trip.arr.size
    val eArr = trip.arr.copyOf()
    val eDep = trip.dep.copyOf()
    val skipped = ByteArray(n)
    if (rt != null && rt.updates.isNotEmpty()) {
        val arrD = DoubleArray(n) { Double.NaN }
        val depD = DoubleArray(n) { Double.NaN }
        var from = 0
        for (u in rt.updates) {
            var k = -1
            if (u.stopId != null) for (i in from until n) if (stops.getOrNull(trip.stops[i])?.id == u.stopId) { k = i; break }
            if (k < 0) continue
            from = k
            arrD[k] = if (u.arrDelay != null) u.arrDelay * 1000 else if (u.arrTime != null && u.arrTime != 0.0) u.arrTime * 1000 - trip.arr[k] else Double.NaN
            depD[k] = if (u.depDelay != null) u.depDelay * 1000 else if (u.depTime != null && u.depTime != 0.0) u.depTime * 1000 - trip.dep[k] else Double.NaN
            if (u.skipped) skipped[k] = 1
        }
        var cur = arrD.firstOrNull { !it.isNaN() } ?: depD.firstOrNull { !it.isNaN() } ?: 0.0
        for (i in 0 until n) {
            if (!arrD[i].isNaN()) cur = arrD[i]
            eArr[i] = trip.arr[i] + cur
            if (!depD[i].isNaN()) cur = depD[i]
            eDep[i] = max(max(trip.dep[i] + cur, eArr[i]), trip.dep[i]) // trains never leave early
        }
    }
    for (i in 1 until n) {
        val planned = trip.arr[i] - trip.dep[i - 1]
        eArr[i] = max(eArr[i], eDep[i - 1] + max(20_000.0, 0.6 * planned))
        if (eDep[i] < eArr[i]) eDep[i] = eArr[i]
        if (skipped[i].toInt() != 0) eDep[i] = eArr[i]
        else if (i < n - 1 && eDep[i] - eArr[i] < 20_000 && eArr[i] - eDep[i - 1] >= 90_000) eArr[i] = eDep[i] - 20_000
    }
    return Timeline(eArr, eDep, skipped)
}

private fun legPath(trip: Trip, i: Int) = travelPath(trip.cat, stops[trip.stops[i]], stops[trip.stops[i + 1]])
private fun legT(tr: Train, i: Int) = (tr.eArr[i + 1] - tr.eDep[i]) / 1000

private class Placed(val call: Int, val leg: Int, val s: Double, val v: Double, val path: Path, val pt: PointAt)

private fun place(tr: Train, tau: Double): Placed {
    val eArr = tr.eArr; val eDep = tr.eDep; val trip = tr.trip
    val n = eArr.size
    var call = 0; var leg = -1; var u = 0.0
    if (tau >= eArr[n - 1]) call = n - 1
    else if (tau > eDep[0]) {
        var lo = 0; var hi = n - 1
        while (hi - lo > 1) { val mid = (lo + hi) shr 1; if (eArr[mid] <= tau) lo = mid else hi = mid }
        call = lo
        if (tau > eDep[lo]) { leg = lo; u = (tau - eDep[lo]) / 1000 }
    }
    if (leg >= 0) {
        val path = legPath(trip, leg)
        val pr = profile(path.len, legT(tr, leg), tr.accel, u)
        return Placed(call, leg, pr.s, pr.v, path, pointAt(path, pr.s))
    }
    val path = if (call < n - 1) legPath(trip, call) else legPath(trip, call - 1)
    val s = if (call < n - 1) 0.0 else path.len
    return Placed(call, leg, s, 0.0, path, pointAt(path, s))
}

// ---------------------------------------------------------------- disruption effects
private class Cap(val from: Double, val to: Double, val v: Double)
private class Hard(val at: Double, val d: Disruption? = null, val rear: Train? = null)
private class Limits {
    var limit = Double.POSITIVE_INFINITY
    val caps = ArrayList<Cap>()
    val causes = ArrayList<String>()
    var brake = false
    var brakeRate = BRAKE
    var cruise: Double? = null
    var hard: Hard? = null
}
private fun maxKmh(cat: String) = if (cat == "EV") 80.0 else if (FAST_CATS.matches(cat)) 200.0 else if (cat == "RE") 160.0 else 140.0
class Collision(val trainId: String, val disruptionId: String, val impactKmh: Int, val t: Long, val withTrain: String?)
val collisions = ArrayList<Collision>()
/** God-mode switch kept for parity with the TS engine: train protection (signalling). */
object Settings { @Volatile var protection = true }
private const val SIGHT_M = 500.0
private const val AUTHORITY_MARGIN_M = 350.0
private var stoppedOnLine: List<Train> = emptyList()
private class OnEdge(val tr: Train, val d: Double)
private var onEdge = HashMap<Int, MutableList<OnEdge>>()
private fun indexEdges() {
    onEdge = HashMap()
    for (tr in trains.values) {
        if (tr.leg < 0 || tr.cancelled) continue
        val span = edgeSpans(legPath(tr.trip, tr.leg)).find { tr.s >= it.from && tr.s <= it.to }
        if (span == null || span.ref == 0) continue
        onEdge.getOrPut(span.ref) { ArrayList() }.add(OnEdge(tr, tr.s - span.from))
    }
}
private class Ahead(val other: Train, val gap: Double)
private fun trainAhead(tr: Train, path: Path, sCur: Double): Ahead? {
    val spans = edgeSpans(path)
    val k = spans.indexOfFirst { sCur >= it.from && sCur <= it.to }
    if (k < 0) return null
    var best: Ahead? = null
    for (j in k until min(spans.size, k + 3)) {
        val sp = spans[j]
        if (sp.ref == 0) continue
        val here = if (j == k) sCur - sp.from else Double.NEGATIVE_INFINITY
        for (e in onEdge[sp.ref] ?: emptyList()) {
            if (e.tr === tr || e.d <= here) continue
            val gap = sp.from + e.d - sCur
            if (best == null || gap < best.gap) best = Ahead(e.tr, gap)
        }
        if (best != null) break
    }
    return best
}
private fun sameDir(a: Int, b: Int) = Integer.signum(a) == Integer.signum(b)
private fun pnum(d: Disruption, key: String, def: Double): Double = (d.params[key] as? Number)?.toDouble() ?: def

private fun legLimits(tr: Train, leg: Int, path: Path, sCur: Double, vCur: Double): Limits {
    val out = Limits()
    val spans = edgeSpans(path)
    val id = tr.trip.trainId
    val road = tr.trip.cat == "EV"
    for (d in disruptions.values.toList()) {
        if (d.endedAt != null) continue
        if (road && (d.effect == "section_closure" || d.effect == "speed_restriction" || d.effect == "signal_failure")) continue
        val scTrain = d.scope.kind == "train"
        if (d.effect == "section_closure") {
            val hit = spans.find { it.to > sCur && d.edges.contains(abs(it.ref)) } ?: continue
            if (sCur < hit.from - 150) out.limit = min(out.limit, hit.from - 150) else out.brake = true
            out.causes.add(d.id)
        } else if (d.effect == "target_speed" && scTrain && d.scope.trainId == id) {
            out.cruise = min(maxKmh(tr.trip.cat), max(5.0, pnum(d, "kmh", 100.0))) / 3.6
            out.causes.add(d.id)
        } else if (d.effect == "obstacle" && scTrain && d.scope.trainId == id) {
            if (d.params["collidedAt"] != null) { out.brake = true; out.causes.add(d.id) }
            else if ((d.params["atLeg"] as? Number)?.toInt() == leg && pnum(d, "atS", 0.0) > sCur - 1) {
                out.hard = Hard(pnum(d, "atS", 0.0), d)
                out.limit = min(out.limit, pnum(d, "atS", 0.0))
                out.brakeRate = max(out.brakeRate, 1.2)
                out.causes.add(d.id)
            }
        } else if (d.effect == "train_speed" && scTrain && d.scope.trainId == id) {
            out.caps.add(Cap(0.0, path.len, max(5.0, pnum(d, "maxKmh", 60.0)) / 3.6)); out.causes.add(d.id)
        } else if (d.effect == "speed_restriction") {
            for (sp in spans) if (sp.to > sCur && d.edges.contains(abs(sp.ref))) out.caps.add(Cap(sp.from, sp.to, pnum(d, "maxKmh", 40.0) / 3.6))
            if (out.caps.isNotEmpty()) out.causes.add(d.id)
        } else if (d.effect == "signal_failure" && d.station != null) {
            val v = pnum(d, "maxKmh", 30.0) / 3.6
            if (tr.trip.stops[leg] == d.station) out.caps.add(Cap(0.0, min(path.len, 1500.0), v))
            if (tr.trip.stops[leg + 1] == d.station) out.caps.add(Cap(max(0.0, path.len - 1500), path.len, v))
            if (out.caps.isNotEmpty()) out.causes.add(d.id)
        } else if ((d.effect == "train_breakdown" || (d.effect == "obstacle" && d.params["collidedAt"] != null)) && scTrain) {
            if (d.scope.trainId == id) {
                out.brake = true
                (d.params["brakeMs2"] as? Number)?.let { out.brakeRate = max(out.brakeRate, it.toDouble()) }
                out.causes.add(d.id)
                continue
            }
            if (!Settings.protection) continue
            val broken = byTrainId[d.scope.trainId!!]
            if (broken == null || broken.cancelled) continue
            if (broken.leg >= 0 && broken.trip.stops[broken.leg] == tr.trip.stops[leg] && broken.trip.stops[broken.leg + 1] == tr.trip.stops[leg + 1]) {
                if (broken.s > sCur) { out.limit = min(out.limit, max(sCur, broken.s - 400)); out.causes.add(d.id) }
                continue
            }
            if (broken.edgeRef == 0) continue
            val single = edgeTracks(broken.edgeRef) < 2
            val hit = spans.find { it.to > sCur && abs(it.ref) == abs(broken.edgeRef) && (single || sameDir(it.ref, broken.edgeRef)) } ?: continue
            if (sCur < hit.from - 150) out.limit = min(out.limit, hit.from - 150)
            else {
                val end = pointAt(path, hit.to)
                val ours = hit.to - sCur
                val theirs = metres(broken.lon, broken.lat, end.lon, end.lat)
                if (ours > theirs) out.limit = min(out.limit, max(sCur, sCur + ours - theirs - 400)) else continue
            }
            out.causes.add(d.id)
        }
    }
    if (!Settings.protection) sightLimits(tr, leg, path, sCur, out) else protectionLimits(tr, path, sCur, vCur, out)
    return out
}

private fun protectionLimits(tr: Train, path: Path, sCur: Double, vCur: Double, out: Limits) {
    val ahead = trainAhead(tr, path, sCur) ?: return
    val other = ahead.other; val gap = ahead.gap
    if (tr.mode == "real" && other.mode == "real" && !other.cancelled) return
    val closing = vCur - other.speed
    val authority = gap - AUTHORITY_MARGIN_M
    if (closing <= 0.3 && authority > 200) return
    if (authority > (vCur * vCur) / (2 * BRAKE) + 300) return
    out.limit = min(out.limit, sCur + max(0.0, authority))
    out.causes.add("protection")
}

private fun sightLimits(tr: Train, leg: Int, path: Path, sCur: Double, out: Limits) {
    val spans = edgeSpans(path)
    for (other in stoppedOnLine) {
        if (other === tr || other.cancelled) continue
        var gap: Double? = null
        if (other.trip.stops[other.leg] == tr.trip.stops[leg] && other.trip.stops[other.leg + 1] == tr.trip.stops[leg + 1]) {
            if (other.s > sCur) gap = other.s - sCur
        } else if (other.edgeRef != 0) {
            val single = edgeTracks(other.edgeRef) < 2
            val hit = spans.find { it.to > sCur && abs(it.ref) == abs(other.edgeRef) && (single || sameDir(it.ref, other.edgeRef)) }
            if (hit != null) {
                val end = pointAt(path, hit.to)
                val ours = hit.to - sCur
                val theirs = metres(other.lon, other.lat, end.lon, end.lat)
                if (ours > theirs) gap = ours - theirs
            }
        }
        if (gap == null || gap > SIGHT_M) continue
        val at = sCur + max(0.0, gap - 25)
        if (out.hard == null || at < out.hard!!.at) out.hard = Hard(at, null, other)
        out.limit = min(out.limit, at)
        out.brakeRate = max(out.brakeRate, 1.2)
        out.causes.add("protection-off")
    }
}

private class Rules(val holding: List<String>, val skip: Boolean, val cancel: Boolean)
private fun stationRules(tr: Train, i: Int, t: Long): Rules {
    val n = tr.eArr.size
    val holding = ArrayList<String>()
    var skip = false; var cancel = false
    val id = tr.trip.trainId
    for (d in disruptions.values.toList()) {
        if (d.endedAt != null) continue
        val scTrain = d.scope.kind == "train"
        if (d.effect == "cancellation" && scTrain && d.scope.trainId == id) cancel = true
        if (i >= n - 1) continue
        if ((d.effect == "station_closure" || (d.effect == "skip_stop" && scTrain && d.scope.trainId == id)) && d.station == tr.trip.stops[i] && i > 0) {
            skip = true; d.affected.add(id)
        } else if (d.effect == "section_closure") {
            if (tr.trip.cat == "EV") continue
            if (edgeSpans(legPath(tr.trip, i)).any { d.edges.contains(abs(it.ref)) }) holding.add(d.id)
        } else if ((d.effect == "train_breakdown" || (d.effect == "obstacle" && d.params["collidedAt"] != null)) && scTrain) {
            if (d.scope.trainId == id) holding.add(d.id)
            else if (!Settings.protection) continue
            else {
                val broken = byTrainId[d.scope.trainId!!]
                if (broken == null || broken.edgeRef == 0 || broken.cancelled) continue
                val single = edgeTracks(broken.edgeRef) < 2
                if (edgeSpans(legPath(tr.trip, i)).any { abs(it.ref) == abs(broken.edgeRef) && (single || sameDir(it.ref, broken.edgeRef)) }) holding.add(d.id)
            }
        } else if ((d.effect == "signal_failure" && d.station == tr.trip.stops[i]) || (d.effect == "train_delay" && scTrain && d.scope.trainId == id)) {
            val started = tr.holds[d.id] ?: t.toDouble()
            tr.holds[d.id] = started
            if (t < started + pnum(d, "holdMinutes", 3.0) * 60_000) holding.add(d.id)
            else if (d.effect == "train_delay") d.endedAt = t
        }
    }
    return Rules(holding, skip, cancel)
}

// ---------------------------------------------------------------- the world
val trains = LinkedHashMap<String, Train>() // by trip key
val byTrainId = HashMap<String, Train>()
private var baseTrips: List<Trip> = emptyList()
private var trips: List<Trip> = emptyList()
private val extraTrips = LinkedHashMap<String, List<Trip>>()
private var loadedDate = ""
private fun rebuildTrips() { trips = if (extraTrips.isNotEmpty()) baseTrips + extraTrips.values.flatten() else baseTrips }

fun setExtraTrips(owner: String, list: List<Trip>) {
    if (list.isNotEmpty()) extraTrips[owner] = list else extraTrips.remove(owner)
    rebuildTrips()
}
fun removeExtraTrips(owner: String? = null) {
    for ((o, list) in extraTrips.entries.toList()) {
        if (owner != null && o != owner) continue
        for (trip in list) {
            if (trains.remove(trip.key) != null) byTrainId.remove(trip.trainId)
            finished.remove(trip.key)
        }
        extraTrips.remove(o)
    }
    rebuildTrips()
}
private val finished = HashSet<String>()
private val meta = HashMap<String, List<String?>>()
fun tripMeta(tripId: String): List<String?>? = meta[tripId]
fun dayTrips(): List<Trip> = trips

/** A trip in the effective timetable now (src/engine.ts liveTimes). */
class LiveTimes(val arr: DoubleArray, val dep: DoubleArray, val skipped: ByteArray, val cancelled: Boolean, val train: Train?, var from: Int, val lastServed: Int, val firstServed: Int, val change: TripChange?)

fun liveTimes(trip: Trip, t: Long): LiveTimes {
    val base = baseTimes(trip, t)
    val n = trip.stops.size
    val change = tripChanges[trip.key]
    var lastServed = n - 1
    var firstServed = 0
    var cancelled = base.cancelled
    var from = base.from
    if (change != null) {
        change.startAt?.let { firstServed = it; from = max(from, it) }
        if (change.cut != null && change.cut!! >= from) {
            lastServed = change.cut!!
            if (change.cut == 0) cancelled = true
        }
        val k = change.holdAt
        if (k != null && change.holdUntil != null && k >= from) {
            val delta = change.holdUntil!! - base.dep[k]
            if (delta > 0) {
                base.dep[k] += delta
                for (i in k + 1 until n) { base.arr[i] += delta; base.dep[i] += delta }
            }
        }
    }
    return LiveTimes(base.arr, base.dep, base.skipped, cancelled, base.train, from, lastServed, firstServed, change)
}

private class Base(val arr: DoubleArray, val dep: DoubleArray, val skipped: ByteArray, val cancelled: Boolean, val train: Train?, val from: Int)
private fun baseTimes(trip: Trip, t: Long): Base {
    val tr = trains[trip.key]
    if (tr != null) {
        val n = trip.stops.size
        val arr = DoubleArray(n) { expectedArrival(tr, it, t) }
        val dep = DoubleArray(n) { expectedDeparture(tr, it, t) }
        return Base(arr, dep, tr.skipped, tr.cancelled, tr, if (tr.leg >= 0) tr.leg + 1 else tr.call)
    }
    val rt = Live.trips[trip.key]
    val tl = timeline(trip, rt)
    return Base(tl.eArr, tl.eDep, tl.skipped, rt?.cancelled == true, null, 0)
}

/** Load today's timetable (when the service day changed); true when a new day was loaded. */
fun loadTimetable(t: Long = Clock.now()): Boolean {
    val today = zurich(t).date
    if (today == loadedDate) return false
    baseTrips = loadDay(today)
    rebuildTrips()
    loadedDate = today
    adjacency = null
    val m = File(Config.dataDir, "trips-meta.json.gz")
    if (m.exists() && meta.isEmpty()) {
        val node = GZIPInputStream(m.inputStream().buffered(1 shl 16)).use { ObjectMapper().readTree(it) }
        for ((k, v) in node.fields()) meta[k] = v.map { if (it.isNull) null else it.asText() }
    }
    return true
}
fun timetableDate() = loadedDate

class BoardRow(val trainId: String?, val line: String, val category: String, val headsign: String, val planned: Double, val expected: Double, val delayMin: Int, val cancelled: Boolean, val plannedHeadsign: String?, val disruptionId: String?) : JsonLike {
    override fun toJson() = obj("trainId" to trainId, "line" to line, "category" to category, "headsign" to headsign, "planned" to planned, "expected" to expected, "delayMin" to delayMin, "cancelled" to cancelled,
        "plannedHeadsign" to (plannedHeadsign ?: Undefined), "disruptionId" to (disruptionId ?: Undefined))
}

/** Next departures from a station in the effective timetable. */
fun stationBoard(station: Int, t: Long, minutes: Int = 60, limit: Int = 12): List<BoardRow> {
    val rows = ArrayList<BoardRow>()
    for (trip in trips) {
        val n = trip.stops.size
        for (i in 0 until n - 1) {
            if (trip.stops[i] != station) continue
            val planned = trip.dep[i]
            if (planned < t - 15 * 60_000 || planned > t + minutes * 60_000L) continue
            val tr = trains[trip.key]
            if (tr != null && (tr.leg >= i || (tr.leg < 0 && tr.call > i))) continue
            val lt = liveTimes(trip, t)
            if (lt.skipped[i].toInt() != 0) continue
            val expected = lt.dep[i]
            val cancelled = lt.cancelled || i >= lt.lastServed || i < lt.firstServed
            if (expected < t - 60_000 && !cancelled) continue
            val cut = lt.lastServed < n - 1 && i < lt.lastServed
            rows.add(BoardRow(trip.trainId, trip.line, trip.cat, if (cut) stops[trip.stops[lt.lastServed]].name else trip.head, planned, expected,
                max(0.0, jsRound((expected - planned) / 60_000)).toInt(), cancelled, if (cut) trip.head else null, lt.change?.by))
        }
    }
    return rows.sortedBy { it.expected }.take(limit)
}

class Served(val stop: Stop, val trains: Int) : JsonLike {
    override fun toJson() = obj("id" to stop.id, "name" to stop.name, "lon" to stop.lon, "lat" to stop.lat, "trains" to trains)
}
val Served.id get() = stop.id
val Served.name get() = stop.name
/** Stations served today with the number of trains calling there. */
fun servedStations(): List<Served> {
    val calls = LinkedHashMap<Int, Int>()
    for (trip in trips) for (s in trip.stops) calls[s] = (calls[s] ?: 0) + 1
    return calls.map { (i, n) -> Served(stops[i], n) }.sortedByDescending { it.trains }
}

private var adjacency: HashMap<Int, LinkedHashSet<Int>>? = null
class Neighbour(val stop: Stop, val km: Double) : JsonLike {
    override fun toJson() = obj("id" to stop.id, "name" to stop.name, "lon" to stop.lon, "lat" to stop.lat, "km" to km)
}
fun neighbours(station: Int, maxKm: Double = 40.0): List<Neighbour> {
    if (adjacency == null) {
        val adj = HashMap<Int, LinkedHashSet<Int>>()
        for (trip in trips) for (i in 1 until trip.stops.size) {
            val a = trip.stops[i - 1]; val b = trip.stops[i]
            if (a == b) continue
            adj.getOrPut(a) { LinkedHashSet() }.add(b)
            adj.getOrPut(b) { LinkedHashSet() }.add(a)
        }
        adjacency = adj
    }
    val adj = adjacency!!
    val dist = LinkedHashMap<Int, Double>(); dist[station] = 0.0
    val queue = ArrayList<DoubleArray>(); queue.add(doubleArrayOf(0.0, station.toDouble()))
    while (queue.isNotEmpty()) {
        var best = 0
        for (k in 1 until queue.size) if (queue[k][0] < queue[best][0]) best = k
        val d = queue[best][0]; val u = queue[best][1].toInt()
        queue[best] = queue[queue.size - 1]; queue.removeAt(queue.size - 1)
        if (d > (dist[u] ?: Double.POSITIVE_INFINITY)) continue
        for (nb in adj[u] ?: emptySet<Int>()) {
            val nd = d + metres(stops[u].lon, stops[u].lat, stops[nb].lon, stops[nb].lat) / 1000
            if (nd <= maxKm && nd < (dist[nb] ?: Double.POSITIVE_INFINITY)) { dist[nb] = nd; queue.add(doubleArrayOf(nd, nb.toDouble())) }
        }
    }
    dist.remove(station)
    return dist.entries.sortedBy { it.value }.map { Neighbour(stops[it.key], jsRound(it.value * 10) / 10) }
}
fun nextDate() = addDays(loadedDate, 1)

private fun makeTrain(trip: Trip, t: Long, rt: TripLive?): Train {
    val tl = timeline(trip, rt)
    val tr = Train(trip, tl.eArr, tl.eDep, tl.skipped)
    tr.tau = t.toDouble()
    tr.accel = accelFor(trip.cat)
    tr.cancelled = rt?.cancelled == true
    tr.cancelReason = if (rt?.cancelled == true) "realtime" else null
    tr.cancelledAt = if (rt?.cancelled == true) t.toDouble() else null
    tr.hasRealtime = rt != null
    val ch0 = tripChanges[trip.key]
    val s0 = ch0?.startAt
    if (s0 != null && s0 != 0) {
        tr.tau = max(t.toDouble(), tr.eArr[s0])
        ch0.committed = true
    }
    settle(tr, place(tr, tr.tau), 0.0)
    return tr
}

private fun settle(tr: Train, p: Placed, speed: Double) {
    tr.call = p.call; tr.leg = p.leg; tr.s = p.s
    tr.lon = p.pt.lon; tr.lat = p.pt.lat; tr.bearing = p.pt.bearing; tr.edgeRef = p.pt.edge
    tr.bav = p.path.bav
    tr.speed = speed
}

private fun refresh(tr: Train) {
    if (tr.mode != "real" || tr.cancelled) return
    val rt = Live.trips[tr.trip.key]
    tr.hasRealtime = rt != null
    if (rt?.cancelled == true) { cancel(tr, "realtime", Clock.now()); return }
    val oldArr = tr.eArr
    val next = timeline(tr.trip, rt)
    tr.eArr = next.eArr; tr.eDep = next.eDep; tr.skipped = next.skipped
    val tauNew: Double
    if (tr.leg >= 0) {
        val path = legPath(tr.trip, tr.leg)
        tauNew = tr.eDep[tr.leg] + invert(path.len, legT(tr, tr.leg), tr.accel, tr.s) * 1000
    } else {
        val i = tr.call
        tauNew = min(max(tr.eArr[i] + (tr.tau - oldArr[i]), tr.eArr[i]), tr.eDep[i])
    }
    val now = tr.tau + tr.warp
    val w = now - tauNew
    val snap = abs(w) > 300_000 && !tr.recovering
    tr.warp = if (snap) 0.0 else w
    if (snap) tr.continuity++
    tr.tau = now - tr.warp
}

private fun cancel(tr: Train, reason: String, t: Long) {
    tr.cancelled = true; tr.cancelReason = reason; tr.cancelledAt = t.toDouble(); tr.motion = "cancelled"; tr.speed = 0.0
}

private fun step(tr: Train, t: Long, dt: Double) {
    if (tr.cancelled) return
    val n = tr.eArr.size
    val change = tripChanges[tr.trip.key]
    val pos = if (tr.leg >= 0) tr.leg + 1 else tr.call
    val cut: Int? = if (change?.cut != null && change.cut!! >= pos && change.cut!! < n - 1) change.cut else null
    if (change?.startAt != null && change.startAt != 0 && tr.leg < 0 && tr.call < change.startAt!! && tr.actDep[tr.call].isNaN()) {
        tr.tau = max(tr.tau, tr.eArr[change.startAt!!])
        tr.warp = 0.0
        tr.continuity++
        settle(tr, place(tr, tr.tau), 0.0)
        change.committed = true
        disruptions[change.by]?.affected?.add(tr.trip.trainId)
    }
    if (cut != null && cut == 0 && tr.leg < 0) {
        change!!.committed = true
        disruptions[change.by]?.affected?.add(tr.trip.trainId)
        cancel(tr, "provoked", t)
        return
    }
    var target: Double
    if (tr.mode == "real") {
        if (tr.warp != 0.0) {
            val k = 0.25 * dt * 1000
            tr.warp = if (abs(tr.warp) <= k) 0.0 else tr.warp - Math.signum(tr.warp) * k
        }
        if (tr.warp == 0.0) tr.recovering = false
        target = t - tr.warp
    } else target = tr.tau + dt * 1000
    target = max(target, tr.tau)
    val causes = ArrayList<String>()
    var held = false
    if (cut != null) target = max(tr.tau, min(target, max(tr.eArr[cut], tr.eDep[cut] - 1)))

    if (tr.leg < 0 && cut != null && tr.call == cut) {
        if (tr.terminatedAt == null) {
            tr.terminatedAt = t.toDouble()
            change!!.committed = true
            disruptions[change.by]?.affected?.add(tr.trip.trainId)
        }
    } else if (tr.leg < 0) {
        val i = tr.call
        val rules = stationRules(tr, i, t)
        if (rules.cancel) { cancel(tr, "provoked", t); return }
        if (rules.skip && target < tr.eDep[i]) {
            target = max(target, tr.eDep[i])
            tr.skipped[i] = 1
            causes.addAll(disruptionsAt(tr, "station_closure"))
        }
        if (rules.holding.isNotEmpty() && target >= tr.eDep[i] && i < n - 1) {
            target = min(target, tr.eDep[i] - 1)
            held = true
            causes.addAll(rules.holding)
        }
        if (tr.mode == "sim" && !rules.skip && i < n - 1 && target >= tr.eDep[i] && t < tr.trip.dep[i]) target = min(target, tr.eDep[i] - 1)
    }
    var p = place(tr, target)
    var speed = p.v
    if (p.leg >= 0 && p.leg == tr.leg && !held) {
        val lim = legLimits(tr, p.leg, p.path, tr.s, tr.speed)
        if (lim.cruise != null && !lim.brake) {
            val L = p.path.len
            val rate = lim.brakeRate
            var v = if (tr.speed < lim.cruise!!) min(lim.cruise!!, tr.speed + tr.accel * dt) else max(lim.cruise!!, tr.speed - BRAKE * dt)
            v = min(v, sqrt(2 * BRAKE * max(0.0, L - tr.s)))
            if (lim.limit < Double.POSITIVE_INFINITY) v = min(v, sqrt(2 * rate * max(0.0, lim.limit - tr.s)))
            for (c in lim.caps) if (tr.s >= c.from - 1 && tr.s <= c.to) v = min(v, max(c.v, tr.speed - BRAKE * dt))
            v = max(max(v, tr.speed - rate * dt), 0.0)
            val allowed = min(((tr.speed + v) / 2) * dt, max(0.0, min(lim.limit, L) - tr.s))
            val reach = tr.s + allowed >= L - 0.5
            val tauOnLeg = if (reach) tr.eArr[p.leg + 1] else tr.eDep[p.leg] + invert(L, legT(tr, p.leg), tr.accel, tr.s + allowed) * 1000
            target = max(tr.tau, tauOnLeg)
            p = place(tr, target)
            speed = if (reach) 0.0 else v
            causes.addAll(lim.causes)
        } else if (lim.causes.isNotEmpty() || tr.mode == "sim") {
            val ds = max(0.0, p.s - tr.s)
            val rate = lim.brakeRate
            var vMax = tr.speed + tr.accel * dt
            if (lim.brake) vMax = min(vMax, tr.speed - rate * dt)
            if (lim.limit < Double.POSITIVE_INFINITY) vMax = min(vMax, sqrt(2 * rate * max(0.0, lim.limit - tr.s)))
            for (c in lim.caps) {
                if (tr.s >= c.from && tr.s <= c.to) vMax = min(vMax, max(c.v, tr.speed - BRAKE * dt))
                else if (c.from > tr.s) vMax = min(vMax, sqrt(c.v * c.v + 2 * BRAKE * (c.from - tr.s)))
            }
            vMax = max(max(vMax, tr.speed - rate * dt), 0.0)
            var allowed = min(min(ds, ((tr.speed + vMax) / 2) * dt), max(0.0, lim.limit - tr.s))
            val hard = lim.hard
            if (hard != null && hard.d?.params?.get("collidedAt") == null && tr.s + ((tr.speed + vMax) / 2) * dt >= hard.at - 0.5 && tr.speed > 0.5) {
                allowed = max(0.0, hard.at - tr.s)
                val impact = jsRound(sqrt(max(0.0, tr.speed * tr.speed - 2 * rate * allowed)) * 3.6).toInt()
                val d = hard.d ?: addSystemDisruption(
                    type = "rear_end_collision", label = "Rear-end collision", reasonCode = "EG_034", effect = "obstacle",
                    scope = Scope("train", trainId = tr.trip.trainId),
                    where = "${tr.trip.line} → ${tr.trip.head} ran into ${hard.rear!!.trip.line} → ${hard.rear.trip.head}",
                    params = mapOf("withTrain" to hard.rear.trip.trainId), origin = "train protection off",
                )
                d.params["collidedAt"] = t
                d.params["impactKmh"] = impact
                d.affected.add(tr.trip.trainId)
                lim.causes.add(d.id)
                collisions.add(Collision(tr.trip.trainId, d.id, impact, t, d.params["withTrain"] as? String))
                vMax = 0.0
            } else if (hard != null && tr.speed <= 0.5 && tr.s >= hard.at - 2) vMax = 0.0
            if (allowed < ds - 0.01 || vMax < p.v - 0.05) {
                val path = p.path
                val tauOnLeg = tr.eDep[p.leg] + invert(path.len, legT(tr, p.leg), tr.accel, tr.s + allowed) * 1000
                target = max(tr.tau, min(target, tauOnLeg))
                p = place(tr, target)
                speed = if ((lim.hard?.d?.params?.get("collidedAt") as? Number)?.toLong() == t || vMax == 0.0) 0.0 else min(vMax, (2 * allowed) / dt)
                if (lim.causes.isNotEmpty()) causes.addAll(lim.causes)
            } else if (tr.mode == "sim") speed = min(p.v, ds / dt)
        }
    }
    if (causes.isNotEmpty()) {
        tr.pendingRecover = false
        tr.recovering = false
        if (tr.mode == "real") { tr.mode = "sim"; tr.warp = 0.0 }
        for (c in causes) { tr.causes.add(c); disruptions[c]?.affected?.add(tr.trip.trainId) }
    }
    tr.tau = target
    if (p.leg != tr.leg || p.call != tr.call) {
        if (tr.leg < 0 && p.leg >= 0) tr.actDep[tr.call] = t.toDouble()
        if (p.leg < 0 && tr.leg >= 0 && tr.actArr[p.call].isNaN()) tr.actArr[p.call] = t.toDouble()
        var i = (if (tr.leg >= 0) tr.leg else tr.call) + 1
        val end = if (p.leg >= 0) p.leg + 1 else p.call
        while (i < end) { tr.actArr[i] = t.toDouble(); tr.actDep[i] = t.toDouble(); i++ }
        if (p.leg >= 0 && tr.leg >= 0 && p.leg > tr.leg) tr.actDep[p.leg] = t.toDouble()
    }
    settle(tr, p, speed)
    tr.motion = if (held) "held" else if (p.leg < 0) "dwelling" else if (speed < 0.3 && causes.isNotEmpty()) "stopped" else "running"
    if (tr.mode == "sim" && tr.pendingRecover && causes.isEmpty() && (p.leg < 0 || abs(speed - p.v) < 1)) rejoin(tr, t)
}

private fun rejoin(tr: Train, t: Long) {
    val rt = Live.trips[tr.trip.key]
    val oldArr = tr.eArr
    val next = timeline(tr.trip, rt)
    tr.eArr = next.eArr; tr.eDep = next.eDep; tr.skipped = next.skipped
    val tauNew = if (tr.leg >= 0) tr.eDep[tr.leg] + invert(legPath(tr.trip, tr.leg).len, legT(tr, tr.leg), tr.accel, tr.s) * 1000
    else min(max(tr.eArr[tr.call] + (tr.tau - oldArr[tr.call]), tr.eArr[tr.call]), tr.eDep[tr.call])
    tr.mode = "real"; tr.pendingRecover = false; tr.recovering = true
    tr.warp = t - tauNew
    tr.tau = tauNew
    tr.causes.clear(); tr.holds.clear()
}

private val settled = HashSet<String>()
private fun applyEnds() {
    fun stillActive(id: String): Boolean { val d = disruptions[id]; return if (d != null) d.endedAt == null else id == "protection-off" && !Settings.protection }
    for (d in disruptions.values.toList()) {
        if (d.endedAt == null || d.id in settled) continue
        settled.add(d.id)
        if (d.effect == "cancellation" && d.scope.kind == "train") sync(listOf(d.scope.trainId!!))
    }
    for (tr in trains.values) {
        if (tr.mode != "sim" || tr.pendingRecover || tr.causes.isEmpty()) continue
        if (tr.causes.none { stillActive(it) }) tr.pendingRecover = true
    }
}
private fun disruptionsAt(tr: Train, effect: String) =
    disruptions.values.filter { it.endedAt == null && (it.effect == effect || it.effect == "skip_stop") && it.station == tr.trip.stops[tr.call] }.map { it.id }

fun obstacleAhead(tr: Train, metres: Double): Pair<Int, Double>? {
    val n = tr.eArr.size
    val leg = if (tr.leg >= 0) tr.leg else if (tr.call < n - 1) tr.call else -1
    if (leg < 0) return null
    val len = legPath(tr.trip, leg).len
    val from = if (tr.leg >= 0) tr.s else 0.0
    return leg to min(len - 5, from + metres)
}

fun delayOf(tr: Train, t: Long): Int {
    val lag = t - tr.tau
    val n = tr.eArr.size
    val k = if (tr.leg < 0) tr.call else tr.leg + 1
    return if (k < n - 1) jsRound((lag + tr.eDep[k] - tr.trip.dep[k]) / 1000).toInt() else jsRound((lag + tr.eArr[k] - tr.trip.arr[k]) / 1000).toInt()
}
private fun second(ms: Double) = jsRound(ms / 1000) * 1000
fun expectedArrival(tr: Train, k: Int, t: Long) = second(tr.eArr[k] + (t - tr.tau))
fun expectedDeparture(tr: Train, k: Int, t: Long) = second(tr.eDep[k] + (t - tr.tau))
fun nextCall(tr: Train) = if (tr.leg >= 0) tr.leg + 1 else min(tr.call + 1, tr.eArr.size - 1)
fun edgeName(tr: Train): String? = Geometry.edgeId(tr.edgeRef)

// ---------------------------------------------------------------- ticking
private var lastTick = 0L
private val provokedGone = LinkedHashMap<String, String>()
private var lastActivation = 0L
class TickResult(val t: Long, val removed: List<Train>)

fun tick(t: Long): TickResult {
    val dt = if (lastTick != 0L) min(5.0, (t - lastTick) / 1000.0) else 1.0
    lastTick = t
    if (t - lastActivation >= 5000) {
        lastActivation = t
        for (trip in trips) {
            if (trains.containsKey(trip.key) || finished.contains(trip.key)) continue
            val last = trip.arr[trip.arr.size - 1]
            if (trip.dep[0] - 3_600_000 > t || last + 4 * 3_600_000 < t) continue
            val rt = Live.trips[trip.key]
            val tl = timeline(trip, rt)
            val s0 = tripChanges[trip.key]?.startAt ?: 0
            if (t < tl.eDep[s0] - 120_000 || t > tl.eArr[tl.eArr.size - 1] + 60_000) continue
            val tr = makeTrain(trip, t, rt)
            trains[trip.key] = tr
            byTrainId[trip.trainId] = tr
        }
    }
    val removed = ArrayList<Train>()
    applyEnds()
    indexEdges()
    stoppedOnLine = if (Settings.protection) emptyList() else trains.values.filter { it.leg >= 0 && it.speed < 0.5 && !it.cancelled }
    for (tr in trains.values.toList()) {
        step(tr, t, dt)
        val done = if (tr.cancelled) t - (tr.cancelledAt ?: t.toDouble()) > 60_000 else if (tr.terminatedAt != null) t - tr.terminatedAt!! > 90_000 else tr.tau >= tr.eArr[tr.eArr.size - 1] + 60_000
        if (done) removed.add(tr)
    }
    for (tr in removed) {
        trains.remove(tr.trip.key)
        byTrainId.remove(tr.trip.trainId)
        finished.add(tr.trip.key)
        if (tr.cancelReason == "provoked" || tr.terminatedAt != null) provokedGone[tr.trip.trainId] = tr.trip.key
    }
    for (d in disruptions.values) if (d.endedAt == null && d.endsAt != null && t >= d.endsAt!!) d.endedAt = t
    return TickResult(t, removed)
}

fun applyRealtime() { for (tr in trains.values.toList()) refresh(tr) }

/** Back to reality: the train reads the real data again (snaps to its real position). */
fun sync(trainIds: List<String>? = null): List<String> {
    val t = Clock.now()
    val out = ArrayList<String>()
    for (tr in trains.values) {
        if (trainIds != null && !trainIds.contains(tr.trip.trainId)) continue
        if (tr.mode == "real" && !(tr.cancelled && tr.cancelReason == "provoked") && tr.terminatedAt == null) continue
        val rt = Live.trips[tr.trip.key]
        val tl = timeline(tr.trip, rt)
        tr.eArr = tl.eArr; tr.eDep = tl.eDep; tr.skipped = tl.skipped
        tr.mode = "real"; tr.tau = t.toDouble(); tr.warp = 0.0; tr.pendingRecover = false; tr.recovering = false; tr.terminatedAt = null
        tr.causes.clear(); tr.holds.clear()
        tr.cancelled = rt?.cancelled == true
        tr.cancelReason = if (rt?.cancelled == true) "realtime" else null
        tr.cancelledAt = if (rt?.cancelled == true) t.toDouble() else null
        val p = place(tr, t.toDouble())
        settle(tr, p, p.v)
        tr.motion = if (p.leg < 0) "dwelling" else "running"
        tr.continuity++
        out.add(tr.trip.trainId)
    }
    for ((trainId, key) in provokedGone.entries.toList()) {
        if (trainIds != null && !trainIds.contains(trainId)) continue
        finished.remove(key)
        provokedGone.remove(trainId)
        out.add(trainId)
    }
    lastActivation = 0
    return out
}

// god.ts: releasing trains
fun releaseTrain(trainId: String): List<String> {
    val ended = ArrayList<String>()
    for (d in disruptions.values) if (d.endedAt == null && ((d.scope.kind == "train" && d.scope.trainId == trainId) || d.scenario?.linkedTrain == trainId)) { d.endedAt = Clock.now(); ended.add(d.id) }
    return ended
}
fun releaseAll(): Int {
    var n = 0
    for (d in disruptions.values) if (d.endedAt == null) { d.endedAt = Clock.now(); n++ }
    return n
}
