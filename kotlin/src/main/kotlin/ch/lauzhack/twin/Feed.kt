package ch.lauzhack.twin

import java.util.UUID

/** What the twin publishes on MQTT: payload builders and the per-tick publication (src/feed.ts). */
const val VERSION = "1.0.0"
val startedAt = Clock.now()
val streamId: String = UUID.randomUUID().toString().replace("-", "").take(16) // changes on every restart
private var tickNo = 0
private fun motionOf(tr: Train) = if (tr.speed >= 0.3 && tr.leg >= 0) "moving" else "stopped"
private fun r6(x: Double) = jsRound(x * 1e6) / 1e6
private fun r1(x: Double) = jsRound(x * 10) / 10
private fun num(x: Double): Any? = if (x.isNaN()) null else jsRound(x).toLong()

fun positionPayload(tr: Train, t: Long): Map<String, Any?> {
    val k = nextCall(tr)
    val here = if (tr.leg >= 0) tr.leg else tr.call
    val prev = stops[tr.trip.stops[here]]
    val next = stops[tr.trip.stops[k]]
    val cut = tripChanges[tr.trip.key]?.cut
    val ended = tr.terminatedAt != null || (cut != null && k > cut)
    return obj(
        "v" to 1, "streamId" to streamId, "tick" to tickNo, "ts" to t, "trainId" to tr.trip.trainId,
        "lat" to r6(tr.lat), "lon" to r6(tr.lon), "bearing" to r1(tr.bearing), "speedKmh" to r1(tr.speed * 3.6),
        "motion" to if (tr.cancelled) "stopped" else motionOf(tr), "delaySec" to delayOf(tr, t),
        "line" to tr.trip.line, "category" to tr.trip.cat, "headsign" to tr.trip.head,
        "atStop" to if (tr.leg < 0) obj("id" to prev.id, "name" to prev.name) else null,
        "prevStop" to obj("id" to prev.id, "name" to prev.name),
        "nextStop" to if (k != here && !ended) obj("id" to next.id, "name" to next.name, "plannedArr" to tr.trip.arr[k], "expectedArr" to jsRound(expectedArrival(tr, k, t))) else null,
        "edgeId" to edgeName(tr), "track" to if (tr.bav) "bav" else "approx", "continuity" to tr.continuity,
    )
}

fun infoPayload(tr: Train, t: Long): Map<String, Any?> {
    val m = tripMeta(tr.trip.tripId)
    val n = tr.trip.arr.size
    val passed = if (tr.leg >= 0) tr.leg else tr.call
    fun stop(i: Int) = stops[tr.trip.stops[i]]
    val lt = liveTimes(tr.trip, t)
    val last = lt.lastServed
    val first = lt.firstServed
    val cut = last < n - 1
    return obj(
        "v" to 1, "trainId" to tr.trip.trainId, "tripId" to tr.trip.tripId, "serviceDate" to tr.trip.serviceDate,
        "line" to tr.trip.line, "category" to tr.trip.cat, "number" to m?.getOrNull(0)?.ifEmpty { null }, "operator" to m?.getOrNull(1)?.ifEmpty { null },
        "headsign" to if (cut) stop(last).name else tr.trip.head,
        "status" to if (tr.cancelled || lt.cancelled) "cancelled" else if (tr.terminatedAt != null) "terminated" else "active",
        "origin" to obj("id" to stop(first).id, "name" to stop(first).name),
        "plannedOrigin" to obj("id" to stop(0).id, "name" to stop(0).name),
        "firstServedSequence" to first,
        "destination" to obj("id" to stop(last).id, "name" to stop(last).name),
        "plannedDestination" to obj("id" to stop(n - 1).id, "name" to stop(n - 1).name),
        "lastServedSequence" to last, "disruptionId" to (lt.change?.by),
        "calls" to List(n) { i ->
            obj(
                "stopId" to stop(i).id, "name" to stop(i).name, "lat" to r6(stop(i).lat), "lon" to r6(stop(i).lon),
                "plannedArr" to if (i > 0) tr.trip.arr[i] else null, "plannedDep" to if (i < n - 1) tr.trip.dep[i] else null,
                "expectedArr" to if (i > 0 && i > passed && i <= last && i > first) jsRound(lt.arr[i]) else null,
                "expectedDep" to if (i < last && i >= first && i >= passed && !(i == passed && tr.leg >= 0)) jsRound(lt.dep[i]) else null,
                "actualArr" to if (i > 0) num(tr.actArr[i]) else null, "actualDep" to if (i < n - 1) num(tr.actDep[i]) else null,
                "skipped" to (tr.skipped[i].toInt() != 0 || i > last || i < first), "cancelled" to (i > last || i < first),
            )
        },
        "updatedAt" to t,
    )
}

private fun infoSignature(tr: Train, t: Long): String {
    val k = nextCall(tr)
    val lt = liveTimes(tr.trip, t)
    val dep = lt.dep.getOrNull(minOf(k, lt.dep.size - 1)) ?: 0.0
    return "${tr.cancelled || lt.cancelled}|${jsRound(delayOf(tr, t) / 30.0).toLong()}|$k|${tr.skipped.joinToString("")}|${lt.lastServed}|${lt.firstServed}|${jsRound(dep / 60_000).toLong()}|${if (tr.terminatedAt != null) 1 else 0}"
}

private fun truthTrain(tr: Train) = obj("v" to 1, "trainId" to tr.trip.trainId, "mode" to "simulated", "state" to tr.motion, "causes" to tr.causes.toList(), "ts" to Clock.now())

fun disruptionPayload(d: Disruption): Map<String, Any?> {
    val base = obj(
        "v" to 1, "id" to d.id, "type" to d.type, "label" to d.label, "reasonCode" to d.reasonCode, "effect" to d.effect, "scope" to d.scope, "where" to d.where,
        "params" to d.params, "note" to d.note, "status" to if (d.endedAt != null) "ended" else "active", "startedAt" to d.startedAt, "endsAt" to d.endsAt,
        "endedAt" to d.endedAt, "geometry" to d.geometry, "affectedTrains" to d.affected.toList(),
    )
    if (d.scenario != null) base.putAll(scenarioFields(d))
    return base
}
/** The latest bulletin of every scenario disruption. */
fun bulletins(): List<Bulletin> = disruptions.values.filter { it.isScenario }.mapNotNull { latestBulletin(it) }
fun incidentPayload(i: Incident) = i.payload()

/** Public events (observable facts) go to events/{kind}; what we provoked goes to truth/events. kind: disruption | incident | train | sync | system */
fun event(kind: String, data: Map<String, Any?>) {
    val body = LinkedHashMap<String, Any?>()
    body["v"] = 1; body["ts"] = Clock.now(); body["kind"] = kind; body.putAll(data)
    if (kind == "disruption" || kind == "sync") publish("truth/events", body, qos = 0) else publish("events/$kind", body, qos = 0)
    Channel.sendEvent(body)
}
fun event(kind: String, vararg pairs: Pair<String, Any?>) = event(kind, obj(*pairs))

fun controlState(): Map<String, Any?> = obj(
    "disruptions" to disruptions.values.map { disruptionPayload(it) },
    "incidents" to incidents.values.map { incidentPayload(it) },
    "bulletins" to bulletins(),
    "simulated" to trains.values.filter { it.mode == "sim" }.map { obj("trainId" to it.trip.trainId, "causes" to it.causes.toList()) },
)
private var stateCore = ""
private var stateFull = ""
private var stateAt = 0L
/** Send the control state to the pages when it changed: at once for changes, every 5 s at most for affected-train lists. */
fun pushState(t: Long = Clock.now()) {
    val s = controlState()
    val full = Json.str(s)
    if (full == stateFull) return
    @Suppress("UNCHECKED_CAST")
    val ds = s["disruptions"] as List<Map<String, Any?>>
    val core = Json.str(LinkedHashMap(s).also { m -> m["disruptions"] = ds.map { d -> LinkedHashMap(d).also { it["affectedTrains"] = (d["affectedTrains"] as List<*>).size } } })
    if (core == stateCore && t - stateAt < 5000) return
    stateCore = core; stateFull = full; stateAt = t
    val msg = obj("type" to "state", "ts" to t); msg.putAll(s)
    Channel.send("state", msg)
}

// ---------------------------------------------------------------- per tick
val FLEET_FIELDS = listOf("trainId", "lat", "lon", "bearing", "speedKmh", "motion", "delaySec", "line", "category", "atStopId", "continuity")
private val truthPublished = HashMap<String, String>()
private val disruptionSig = HashMap<String, String>()
private val disruptionAt = HashMap<String, Long>()
private var lastStatus = 0L

fun publishTick(t: Long, removed: List<Train>) {
    tickNo++
    val crashes = collisions.toList(); collisions.clear()
    for (c in crashes) event("disruption", "type" to "train.collision", "trainId" to c.trainId, "id" to c.disruptionId, "impactKmh" to c.impactKmh, "withTrain" to c.withTrain)
    for (ch in autoIncidents(t, crashes)) {
        if (ch.kind == "closed") clear("incidents/${ch.incident.id}") else publish("incidents/${ch.incident.id}", incidentPayload(ch.incident), retain = true, qos = 1)
        if (ch.kind != "updated") event("incident", "type" to if (ch.kind == "opened") "incident.marked" else "incident.unmarked", "id" to ch.incident.id, "title" to ch.incident.title, "severity" to ch.incident.severity, "source" to "auto")
    }
    val fleet = ArrayList<Any?>(trains.size)
    for (tr in trains.values) {
        val id = tr.trip.trainId
        publish("trains/$id/position", positionPayload(tr, t))
        val sig = infoSignature(tr, t)
        if (sig != tr.infoSig && (t - tr.infoAt >= 10_000 || tr.infoSig.isEmpty() || sig.substringBefore("|") != tr.infoSig.substringBefore("|"))) {
            if (tr.cancelled && !tr.infoSig.startsWith("true")) event("train", "type" to "train.cancelled", "trainId" to id, "line" to tr.trip.line)
            tr.infoSig = sig; tr.infoAt = t.toDouble()
            publish("trains/$id/info", infoPayload(tr, t), retain = true, qos = 1)
        }
        val causesSig = tr.causes.joinToString(",")
        if (tr.mode == "sim" && truthPublished[id] != causesSig) {
            truthPublished[id] = causesSig
            publish("truth/trains/$id", truthTrain(tr), retain = true, qos = 1)
        } else if (tr.mode == "real" && truthPublished.containsKey(id)) {
            truthPublished.remove(id)
            clear("truth/trains/$id")
        }
        fleet.add(listOf(id, r6(tr.lat), r6(tr.lon), r1(tr.bearing), r1(tr.speed * 3.6), if (tr.cancelled) "cancelled" else motionOf(tr), delayOf(tr, t), tr.trip.line, tr.trip.cat, if (tr.leg < 0) stops[tr.trip.stops[tr.call]].id else null, tr.continuity))
    }
    for (tr in removed) {
        val id = tr.trip.trainId
        clear("trains/$id/info")
        if (truthPublished.remove(id) != null) clear("truth/trains/$id")
    }
    publish("fleet", obj("v" to 1, "streamId" to streamId, "tick" to tickNo, "ts" to t, "fields" to FLEET_FIELDS, "trains" to fleet))
    Channel.send("tick", obj("type" to "tick", "ts" to t, "trains" to fleet, "status" to statusPayload(t)), droppable = true)
    for (id in Channel.watched()) {
        val tr = byTrainId[id]
        Channel.sendToWatchers(id, obj("type" to "train", "trainId" to id, "position" to tr?.let { positionPayload(it, t) }, "info" to tr?.let { infoPayload(it, t) }))
    }
    for (d in disruptions.values.toList()) {
        val state = "${d.endedAt ?: ""}|${(d.params["collidedAt"] as? Number)?.toLong() ?: ""}"
        val prev = disruptionSig[d.id]
        val sig = "$state|${d.affected.size}"
        if (prev == sig) continue
        if (prev != null && prev.startsWith("$state|") && t - (disruptionAt[d.id] ?: 0) < 15_000) continue
        disruptionAt[d.id] = t
        if (d.endedAt != null && prev != null && !prev.startsWith(d.endedAt.toString())) event("disruption", "type" to "disruption.ended", "id" to d.id, "label" to d.label, "where" to d.where)
        disruptionSig[d.id] = sig
        publish("truth/disruptions/${d.id}", disruptionPayload(d), retain = true, qos = 1)
    }
    for (d in disruptions.values.toList()) if (d.endedAt != null && t - d.endedAt!! > 30 * 60_000) removeDisruption(d.id)
    pushState(t)
    if (t - lastStatus >= 10_000) {
        lastStatus = t
        publish("status", statusPayload(t), retain = true, qos = 1)
    }
}

fun removeDisruption(id: String) {
    val d = disruptions[id]
    if (d != null && d.isScenario) forget(id)
    disruptions.remove(id)
    disruptionSig.remove(id)
    clear("truth/disruptions/$id")
}

fun statusPayload(t: Long = Clock.now()): Map<String, Any?> {
    val simulated = trains.values.count { it.mode == "sim" }
    return obj(
        "v" to 1, "ts" to t, "service" to "sbb-twin", "version" to VERSION, "streamId" to streamId, "tick" to tickNo, "startedAt" to startedAt,
        "timetableDate" to timetableDate(), "trainsActive" to trains.size, "trainsSimulated" to simulated,
        "realtime" to obj("enabled" to Live.enabled(), "feedAgeSec" to if (Live.fetchedAt != 0L) jsRound((t - Live.fetchedAt) / 1000.0).toLong() else null, "trips" to Live.trips.size, "error" to Live.error),
        "disruptionsActive" to disruptions.values.count { it.endedAt == null }, "incidentsMarked" to incidents.size,
        "broker" to obj("mode" to brokerStats.mode, "connected" to brokerStats.connected, "webSocketClients" to brokerStats.clients),
        "alerts" to obj("enabled" to Config.gtfsSaKey.isNotEmpty(), "active" to AlertsState.alerts.size,
            "feedAgeSec" to if (AlertsState.fetchedAt != 0L) jsRound((t - AlertsState.fetchedAt) / 1000.0).toLong() else null, "error" to AlertsState.error),
        "controlPages" to Channel.pageCount(), "bulletinAI" to aiStats(),
    )
}
