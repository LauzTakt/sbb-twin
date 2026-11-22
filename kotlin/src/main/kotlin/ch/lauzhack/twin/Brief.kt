package ch.lauzhack.twin

/** A fast situation brief for the passenger assistant (src/brief.ts): from the twin's state only. */
private fun place(k: Int) = obj("id" to stops[k].id, "name" to stops[k].name)
private fun nameOf(id: String) = stopName(id)
private var keysOf: Pair<List<Trip>, Map<String, String>>? = null
private fun tripKeys(): Map<String, String> {
    val trips = dayTrips()
    if (keysOf?.first !== trips) keysOf = trips to trips.associate { it.trainId to it.key }
    return keysOf!!.second
}

private fun stationsOf(d: Disruption): Set<String> = (listOfNotNull(d.scenario!!.a, d.scenario!!.b) + d.scenario!!.inside + d.scenario!!.busStops).toSet()

private fun disruptionBrief(d: Disruption, t: Long, at: Set<String>): Map<String, Any?> {
    val sc = d.scenario!!
    val b = latestBulletin(d)
    val st = stateAt(d, t, t)
    val tag = "EV-${d.id.substring(2)}-"
    val buses = dayTrips().filter { it.cat == "EV" && it.key.contains(tag) }
    val from = at.filter { sc.busStops.contains(it) }
    val ends = if (from.isNotEmpty()) from else listOfNotNull(sc.a, sc.b)
    val next = buses.flatMap { trip ->
        val i = trip.stops.indexOfFirst { ends.contains(stops[it].id) }
        if (i < 0 || i == trip.stops.size - 1 || trip.dep[i] < t) emptyList()
        else { val last = trip.stops.size - 1; listOf(obj("trainId" to trip.trainId, "from" to stops[trip.stops[i]].name, "to" to stops[trip.stops[last]].name, "departure" to trip.dep[i], "arrival" to trip.arr[last])) }
    }.sortedBy { it["departure"] as Double }.take(4)
    var cut = 0; var held = 0
    for (ch in tripChanges.values) if (ch.by == d.id) { if (ch.holdAt != null) held++ else cut++ }
    return obj(
        "id" to d.id, "kind" to "control", "title" to (b?.title ?: d.label), "description" to (b?.description ?: ""), "bulletinVersion" to (b?.version ?: 0),
        "source" to (b?.source ?: "template"), "lifecycle" to (b?.lifecycle ?: "INFO"), "effect" to st.state, "cause" to sc.causeJson,
        "section" to obj("a" to obj("id" to sc.a, "name" to nameOf(sc.a)), "b" to sc.b?.let { obj("id" to it, "name" to nameOf(it)) }),
        "until" to st.until, "durationType" to st.durationType, "expectedEnd" to (if (d.endedAt != null) null else expectedEnd(d, t)),
        "lines" to (if (b != null) b.lines else if (st.state == "interrupted") sc.lines else emptyList()),
        "measures" to sc.measures.filter { it.announcedAt <= t }.map { obj("type" to it.type, "label" to (MEASURES.find { x -> x.type == it.type }?.label ?: it.type), "at" to it.at, "withdrawAt" to it.withdrawAt) },
        "replacementBus" to (if (buses.isNotEmpty()) obj("route" to sc.busStops.map { nameOf(it) }, "next" to next) else null),
        "trainsCut" to cut, "trainsHeld" to held, "messages" to (b?.messages ?: emptyList()),
    )
}

private class Hits(val disruptions: List<Map<String, Any?>>, val alerts: List<Map<String, Any?>>)
private fun touching(ids: Set<String>, t: Long, tripKeySet: Set<String>): Hits {
    val out = ArrayList<Map<String, Any?>>()
    for (d in disruptions.values) {
        if (d.scenario == null) continue
        val mine = stationsOf(d)
        val hit = ids.any { mine.contains(it) } || tripChanges.any { (key, ch) -> ch.by == d.id && tripKeySet.contains(key) }
        if (hit) out.add(disruptionBrief(d, t, ids))
    }
    val alerts = AlertsState.alerts.values.filter { a -> a.stations.any { ids.contains(it.id) } || a.trainIds.any { tripKeySet.contains(it) } }
        .map { it.briefMap() + ("kind" to "sbb") }
    return Hits(out, alerts)
}

private fun stationPart(k: Int, t: Long) = place(k) to stationBoard(k, t, 60, 8)

private var served: Pair<List<Trip>, List<Int>>? = null
private fun nearest(lat: Double, lon: Double): Pair<Int, Long>? {
    val day = dayTrips()
    if (served?.first !== day) served = day to day.flatMap { it.stops.toList() }.toSet().toList()
    val kx = 111_320 * Math.cos(lat * Math.PI / 180)
    var best = -1; var bd = Double.POSITIVE_INFINITY
    for (k in served!!.second) {
        val d = Math.hypot((stops[k].lon - lon) * kx, (stops[k].lat - lat) * 110_540)
        if (d < bd) { bd = d; best = k }
    }
    return if (best < 0) null else best to jsRoundL(bd)
}

fun brief(q: Map<String, String?>): Map<String, Any?> {
    val lat0 = q["lat"]; val lon0 = q["lon"]
    if (!lat0.isNullOrEmpty() && !lon0.isNullOrEmpty() && q["station"].isNullOrEmpty() && q["from"].isNullOrEmpty()) {
        val lat = jsNumber(lat0); val lon = jsNumber(lon0)
        val n = if (lat.isFinite() && lon.isFinite()) nearest(lat, lon) else null
        if (n == null || n.second > 50_000) return obj("error" to "No station within 50 km of this point")
        val near = place(n.first) + ("distanceM" to n.second)
        val base = if (!q["to"].isNullOrEmpty()) brief(mapOf("from" to stops[n.first].id, "to" to q["to"])) else brief(mapOf("station" to stops[n.first].id))
        return LinkedHashMap(base).also { it["nearest"] = near }
    }
    val t = Clock.now()
    val t0 = System.nanoTime()
    val ms = { Math.round((System.nanoTime() - t0) / 1e6) }
    val from = q["from"]; val to = q["to"]
    if (!from.isNullOrEmpty() && !to.isNullOrEmpty()) {
        val a = resolveStation(from); val b = resolveStation(to)
        if (a == null || b == null) return obj("error" to "Unknown station: ${if (a == null) from else to}")
        val p = plan(stops[a].id, stops[b].id, t, 3, PlanOptions(maxTransfers = null, via = null, includeWait = false, quick = true))
        // generic JSON view of the journeys (whatever the planner returns)
        val journeys: List<Map<String, Any?>> = if (p.containsKey("error")) emptyList() else
            ((Json.parse(Json.str(p["journeys"])) as? List<*>) ?: emptyList<Any?>()).mapNotNull { it.asMap() }.take(3)
        val ids = hashSetOf(stops[a].id, stops[b].id)
        val tripSet = LinkedHashSet<String>()
        val byId = tripKeys()
        for (j in journeys) for (l in (j["legs"].asList() ?: emptyList()).mapNotNull { it.asMap() }) {
            (l["from"].asMap()?.get("id") as? String)?.let { ids.add(it) }
            (l["to"].asMap()?.get("id") as? String)?.let { ids.add(it) }
            byId[l["trainId"] as? String ?: ""]?.let { tripSet.add(it) }
        }
        val fp = stationPart(a, t); val tp = stationPart(b, t)
        for (r in fp.second) tripSet.add(byId[r.trainId] ?: "")
        val hits = touching(ids, t, tripSet)
        return obj("generatedAt" to t, "from" to fp.first, "to" to tp.first, "disruptions" to hits.disruptions, "alerts" to hits.alerts, "journeys" to journeys, "departures" to fp.second, "ms" to ms())
    }
    val k = resolveStation(q["station"]) ?: return obj("error" to (if (!q["station"].isNullOrEmpty()) "Unknown station: ${q["station"]}" else "station, or from and to, are required"))
    val part = stationPart(k, t)
    val byId = tripKeys()
    val tripSet = part.second.map { if (it.trainId != null) byId[it.trainId] ?: "" else "" }.toSet()
    val hits = touching(hashSetOf(stops[k].id), t, tripSet)
    return obj("generatedAt" to t, "station" to part.first, "disruptions" to hits.disruptions, "alerts" to hits.alerts, "departures" to part.second, "ms" to ms())
}
