package ch.lauzhack.twin

import java.security.MessageDigest

/** Automatic incident detection (src/auto.ts): watches what the trains do and opens public incidents (source "auto"). */
class AutoChange(val kind: String, val incident: Incident) // opened | updated | closed

private const val STOPPED_S = 30
private const val SLOW_S = 60
private const val SLOW_RATIO = 0.4
private const val HELD_S = 180
private const val LATE_ON_S = 600
private const val LATE_OFF_S = 240
private const val LOSING_S = 120
private const val GRACE_MS = 20_000

private val open = HashMap<String, Long>()
private val since = HashMap<String, Long>()
private class Sample(val t: Long, val d: Int)
private val delayLog = HashMap<String, ArrayList<Sample>>()
private val collided = HashMap<String, Int>()
private class Sec(val key: String, val name: String, val geometry: Map<String, Any?>?, val scope: Scope)
private val sectionCache = HashMap<String, Sec>()

fun sha1Hex(s: String): String = MessageDigest.getInstance("SHA-1").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
private fun hash(s: String) = sha1Hex(s).take(10)
private fun label(tr: Train) = "${tr.trip.line} to ${tr.trip.head}"
private fun nameOf(k: Int) = stops.getOrNull(k)?.name ?: ""
private fun onMap(tr: Train) = tr.lon >= 5.4 && tr.lon <= 11.0 && tr.lat >= 45.55 && tr.lat <= 48.05
private fun whereOf(tr: Train) = if (tr.leg >= 0) "between ${nameOf(tr.trip.stops[tr.leg])} and ${nameOf(tr.trip.stops[tr.leg + 1])}" else "at ${nameOf(tr.trip.stops[tr.call])}"

private fun lasting(key: String, cond: Boolean, t: Long, seconds: Int): Boolean {
    if (!cond) { since.remove(key); return false }
    if (!since.containsKey(key)) since[key] = t
    return t - since[key]!! >= seconds * 1000L
}

private fun sectionOf(tr: Train): Sec {
    val a = tr.trip.stops[tr.leg]; val b = tr.trip.stops[tr.leg + 1]
    val (x, y) = if (a < b) a to b else b to a
    val key = "$x-$y"
    return sectionCache.getOrPut(key) {
        var geometry: Map<String, Any?>? = null
        try { val edges = sectionEdges(stops[x], stops[y]); if (edges.isNotEmpty()) geometry = edgesGeometry(edges) } catch (_: Exception) {}
        Sec(key, "${nameOf(x)} – ${nameOf(y)}", geometry, Scope("section", from = stops[x].id, to = stops[y].id))
    }
}

private class Wanted(val title: String, val description: String, val severity: String, val type: String, val trainIds: List<String>, val scope: Scope, val where: String, val geometry: Map<String, Any?>?)

private fun base(rule: String, severity: String, title: String, list: List<Train>, scope: Scope, where: String, geometry: Map<String, Any?>?, description: String? = null) =
    Wanted(title, description ?: list.joinToString(", ") { label(it) }, severity, "auto.$rule", list.map { it.trip.trainId }, scope, where, geometry)

/** Called once per tick with that tick's collisions; returns the incidents to publish. */
fun autoIncidents(t: Long, crashes: List<Collision>): List<AutoChange> {
    for (c in crashes) collided[c.trainId] = c.impactKmh
    val want = LinkedHashMap<String, Wanted>()
    val stoppedOn = LinkedHashMap<String, ArrayList<Train>>()
    val slowOn = LinkedHashMap<String, ArrayList<Train>>()
    val heldAt = LinkedHashMap<Int, ArrayList<Train>>()
    val section = HashMap<String, Sec>()
    for (tr in trains.values) {
        val id = tr.trip.trainId
        if (collided.containsKey(id) && (tr.mode != "sim" || tr.speed >= 0.5)) collided.remove(id)
        if (!onMap(tr)) continue
        val explained = tripChanges.containsKey(tr.trip.key)
        if (tr.cancelled && explained) continue
        if (tr.cancelled) {
            want["auto-cancelled-${hash(id)}"] = base("cancelled", "minor", "Cancelled: ${label(tr)}", listOf(tr), Scope("train", trainId = id), whereOf(tr), null, "")
            continue
        }
        if (tr.leg >= 0) {
            val sec = sectionOf(tr)
            section[sec.key] = sec
            if (lasting("stop:$id", tr.speed < 0.5, t, STOPPED_S) || collided.containsKey(id)) stoppedOn.getOrPut(sec.key) { ArrayList() }.add(tr)
            val path = pathBetween(stops[tr.trip.stops[tr.leg]], stops[tr.trip.stops[tr.leg + 1]])
            val planned = (tr.trip.arr[tr.leg + 1] - tr.trip.dep[tr.leg]) / 1000
            val pace = if (planned > 30) path.len / planned else 0.0
            val steady = Math.abs(tr.accel) < 0.05 && tr.s > 800 && tr.s < path.len - 800
            if (lasting("slow:$id", pace > 0 && steady && tr.speed >= 0.5 && tr.speed < pace * SLOW_RATIO, t, SLOW_S)) slowOn.getOrPut(sec.key) { ArrayList() }.add(tr)
        } else {
            since.remove("stop:$id"); since.remove("slow:$id")
            val k = tr.call
            val arrived = tr.actArr[k]
            if (k < tr.trip.stops.size - 1 && !arrived.isNaN() && !arrived.isInfinite()) {
                val due = Math.max(tr.trip.dep[k], arrived + (tr.trip.dep[k] - tr.trip.arr[k]))
                if (t - due >= HELD_S * 1000 && !explained) heldAt.getOrPut(tr.trip.stops[k]) { ArrayList() }.add(tr)
            }
        }
        val delay = delayOf(tr, t)
        val log = delayLog.getOrPut(id) { ArrayList() }
        if (log.isEmpty() || t - log.last().t >= 30_000) {
            log.add(Sample(t, delay))
            while (t - log[0].t > 200_000) log.removeAt(0)
        }
        val before = log.firstOrNull { t - it.t >= 170_000 }
        val losing = before != null && delay - before.d >= LOSING_S
        val lateId = "auto-late-${hash(id)}"
        if (delay >= LATE_ON_S || (delay >= LATE_OFF_S && (losing || open.containsKey(lateId))))
            want[lateId] = base("late", "minor", "${label(tr)}: ${jsRoundL(delay / 60.0)} min late${if (losing) ", losing time" else ""}", listOf(tr), Scope("train", trainId = id), whereOf(tr), null, "")
    }
    for ((key, list) in stoppedOn) {
        val sec = section[key]!!
        val crash = list.firstOrNull { collided.containsKey(it.trip.trainId) }
        val title = if (crash != null) "Collision: ${label(crash)} (${jsRoundL(collided[crash.trip.trainId]!!.toDouble())} km/h)" else if (list.size == 1) "Train stopped: ${label(list[0])}" else "${list.size} trains stopped on the line"
        want["auto-stopped-${hash(key)}"] = base("stopped", if (crash != null) "critical" else "major", title, list, sec.scope, sec.name, sec.geometry)
    }
    for ((key, list) in slowOn) {
        val sec = section[key]!!
        want["auto-slow-${hash(key)}"] = base("slow", "minor", if (list.size == 1) "Slow running: ${label(list[0])}" else "Slow running: ${list.size} trains", list, sec.scope, sec.name, sec.geometry)
    }
    for ((k, list) in heldAt) {
        val st = stops[k]
        want["auto-held-${hash(st.id)}"] = base("held", if (list.size > 1) "major" else "minor", if (list.size == 1) "Train held: ${label(list[0])}" else "${list.size} trains held", list,
            Scope("station", station = st.id), "at ${st.name}", obj("type" to "Point", "coordinates" to listOf(st.lon, st.lat)))
    }
    for (key in since.keys.toList()) if (!byTrainId.containsKey(key.substring(key.indexOf(":") + 1))) since.remove(key)
    for (id in delayLog.keys.toList()) if (!byTrainId.containsKey(id)) delayLog.remove(id)
    for (id in collided.keys.toList()) if (!byTrainId.containsKey(id)) collided.remove(id)

    val changes = ArrayList<AutoChange>()
    for ((id, w) in want) {
        open[id] = t
        val cur = incidents[id]
        if (cur == null) {
            val inc = Incident(id, w.title, w.description, w.severity, w.type, null, w.scope, w.where, w.geometry, null, "auto", w.trainIds, t, t)
            incidents[id] = inc
            changes.add(AutoChange("opened", inc))
        } else if (cur.title != w.title || cur.severity != w.severity || cur.description != w.description || cur.where != w.where) {
            cur.title = w.title; cur.severity = w.severity; cur.description = w.description; cur.where = w.where; cur.trainIds = w.trainIds; cur.updatedAt = t
            changes.add(AutoChange("updated", cur))
        }
    }
    for ((id, last) in open.entries.toList()) {
        if (want.containsKey(id) || (incidents.containsKey(id) && t - last < GRACE_MS)) continue
        open.remove(id)
        val cur = incidents.remove(id)
        if (cur != null) changes.add(AutoChange("closed", cur))
    }
    return changes
}
