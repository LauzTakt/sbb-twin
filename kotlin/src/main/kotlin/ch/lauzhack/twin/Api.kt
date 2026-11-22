package ch.lauzhack.twin

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.request.httpMethod
import io.ktor.server.request.receiveText
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route

/** HTTP control API (src/api.ts), mounted under /api. */
class Res(val body: Any?, val status: Int = 200, val contentType: String = "application/json", val headers: Map<String, String> = emptyMap())

private val severityFor = mapOf(
    "section_closure" to "critical", "train_breakdown" to "major", "signal_failure" to "major", "station_closure" to "major", "speed_restriction" to "minor",
    "train_delay" to "minor", "cancellation" to "minor", "train_speed" to "minor", "skip_stop" to "minor", "target_speed" to "minor", "obstacle" to "critical",
)
private fun err(msg: String, status: Int) = Res(obj("error" to msg), status)
private fun stopJson(s: Stop) = obj("id" to s.id, "name" to s.name, "lon" to s.lon, "lat" to s.lat)

private fun trainLookup(id: String): TrainRef? {
    val tr = byTrainId[id] ?: return null
    val next = if (tr.leg >= 0) tr.leg + 1 else tr.call + 1
    return TrainRef("${tr.trip.line} → ${tr.trip.head}", if (next < tr.trip.stops.size - 1) tr.trip.stops[next] else null) { m -> obstacleAhead(tr, m) }
}

private fun markIncident(input: Map<String, Any?>): Incident {
    val i = createIncident(input)
    publish("incidents/${i.id}", incidentPayload(i), retain = true, qos = 1)
    event("incident", "type" to "incident.marked", "id" to i.id, "title" to i.title, "severity" to i.severity, "where" to i.where)
    return i
}
private fun endDisruption(id: String): Disruption? {
    val d = disruptions[id] ?: return null
    if (d.endedAt == null) d.endedAt = Clock.now()
    return d
}
private fun scenarioOf(id: String): Disruption? {
    val d = disruptions[id] ?: return null
    if (!d.isScenario) throw InputError("This is a train-level disruption: only scenario disruptions take measures")
    return d
}
/** A train breakdown blocks its section: an interrupted disruption (train blocking the line) with a bulletin. */
private fun breakdownSection(trainId: String): Disruption? {
    val tr = byTrainId[trainId] ?: return null
    val n = tr.trip.stops.size
    val i = if (tr.leg >= 0) tr.leg else minOf(tr.call, n - 2)
    if (i < 0) return null
    return try {
        createScenario(obj("cause" to "EG_014", "scope" to obj("kind" to "section", "from" to stops[tr.trip.stops[i]].id, "to" to stops[tr.trip.stops[i + 1]].id),
            "effect" to "interrupted", "durationType" to "UNKNOWN", "linkedTrain" to trainId))
    } catch (_: Exception) { null }
}
fun measureRaw(m: Measure) = obj("id" to m.id, "type" to m.type, "at" to m.at, "announcedAt" to m.announcedAt, "params" to m.params,
    "withdrawAt" to (m.withdrawAt ?: Undefined), "withdrawnAnnouncedAt" to (m.withdrawnAnnouncedAt ?: Undefined))
private fun answer(d: Disruption) = obj("disruption" to disruptionPayload(d), "bulletin" to (if (d.isScenario) latestBulletin(d) else null), "warnings" to (d.scenario?.warnings ?: emptyList<String>()))

/** Run a handler inside the world lock; InputError -> 422; afterwards (non-GET) the bulletins and state follow at once. */
private suspend fun ApplicationCall.reply(block: () -> Res) {
    val write = request.httpMethod.value != "GET"
    val res = locked {
        try { block() }
        catch (e: InputError) { err(e.message ?: "", 422) }
        catch (e: Exception) { System.err.println("[api] $e"); err("Internal error", 500) }
        finally { if (write) try { scenarioTick(Clock.now(), true); pushState() } catch (e: Exception) { System.err.println("[api] $e") } }
    }
    send(res)
}
private suspend fun ApplicationCall.send(res: Res) {
    for ((k, v) in res.headers) response.header(k, v)
    val text = if (res.body is String && res.contentType != "application/json") res.body else Json.str(res.body)
    respondText(text, ContentType.parse(res.contentType), HttpStatusCode.fromValue(res.status))
}
private suspend fun ApplicationCall.body(): Map<String, Any?> = Json.parseMap(runCatching { receiveText() }.getOrDefault(""))
private fun ApplicationCall.q(name: String): String? = request.queryParameters[name]
private fun ApplicationCall.p(name: String): String = parameters[name] ?: ""

fun Route.api() = route("/api") {
    get("/status") { call.reply { Res(statusPayload()) } }
    get("/trains") { call.reply { val t = Clock.now(); Res(trains.values.map { positionPayload(it, t) }) } }
    get("/trains/{id}") {
        call.reply {
            val tr = byTrainId[call.p("id")] ?: return@reply err("Train not in service", 404)
            val t = Clock.now()
            Res(obj("position" to positionPayload(tr, t), "info" to infoPayload(tr, t), "truth" to obj("mode" to if (tr.mode == "sim") "simulated" else "real", "causes" to tr.causes.toList())))
        }
    }
    get("/stations") { call.reply { Res(searchStations(call.q("q") ?: "", 10).map { stopJson(it) }) } }
    get("/stations.geojson") {
        call.reply {
            Res(obj("type" to "FeatureCollection", "features" to servedStations().map { s ->
                obj("type" to "Feature", "properties" to obj("id" to s.id, "name" to s.name, "trains" to s.trains), "geometry" to obj("type" to "Point", "coordinates" to listOf(s.stop.lon, s.stop.lat)))
            }), contentType = "application/geo+json", headers = mapOf("cache-control" to "public, max-age=600"))
        }
    }
    get("/stations/{id}/board") {
        call.reply { val i = stationIndex(call.p("id")) ?: return@reply err("Unknown station", 404); Res(stationBoard(i, Clock.now())) }
    }
    get("/stations/{id}/arrivals") {
        call.reply {
            val i = stationIndex(call.p("id")) ?: return@reply err("Unknown station", 404)
            val t = Clock.now()
            val rows = ArrayList<Map<String, Any?>>()
            for (tr in trains.values) {
                if (tr.cancelled) continue
                val n = nextCall(tr)
                var k = if (tr.leg < 0) tr.call else n
                while (k < tr.trip.stops.size) {
                    if (tr.trip.stops[k] != i || tr.skipped[k].toInt() != 0) { k++; continue }
                    val atStation = tr.leg < 0 && tr.call == k
                    val eta = if (atStation) t.toDouble() else expectedArrival(tr, k, t)
                    if (eta - t < -90_000 || eta - t > 90 * 60_000) break
                    rows.add(obj(
                        "trainId" to tr.trip.trainId, "line" to tr.trip.line, "category" to tr.trip.cat, "headsign" to tr.trip.head,
                        "plannedArr" to tr.trip.arr[k], "expectedArr" to jsRound(eta), "etaSec" to maxOf(0.0, jsRound((eta - t) / 1000)).toLong(), "delaySec" to delayOf(tr, t),
                        "stopsAway" to maxOf(0, k - n + (if (tr.leg >= 0) 0 else 1)), "status" to if (atStation) "at_station" else "approaching",
                        "lat" to jsRound(tr.lat * 1e6) / 1e6, "lon" to jsRound(tr.lon * 1e6) / 1e6, "speedKmh" to jsRound(tr.speed * 3.6).toLong(),
                    ))
                    break
                }
            }
            rows.sortBy { it["etaSec"] as Long }
            Res(rows.take(12))
        }
    }
    get("/stations/{id}/neighbours") {
        call.reply {
            val i = stationIndex(call.p("id")) ?: return@reply err("Unknown station", 404)
            val km = jsNumber(call.q("km") ?: 40)
            Res(neighbours(i, if (km.isNaN()) km else minOf(80.0, km)))
        }
    }
    get("/abroad.geojson") { call.reply { Res(Geometry.abroadGeoJson(), contentType = "application/geo+json", headers = mapOf("cache-control" to "public, max-age=3600")) } }
    get("/network.geojson") { call.reply { Res(Geometry.networkGeoJson(), contentType = "application/geo+json", headers = mapOf("cache-control" to "public, max-age=3600")) } }

    // Scenario disruptions and train-level actions
    get("/disruption-types") { call.reply { Res(CAUSES) } }
    get("/measure-types") { call.reply { Res(MEASURES) } }
    get("/train-actions") { call.reply { Res(TYPES) } }
    get("/disruptions") { call.reply { Res(disruptions.values.map { disruptionPayload(it) }) } }
    get("/disruptions/{id}") { call.reply { disruptions[call.p("id")]?.let { Res(disruptionPayload(it)) } ?: err("Unknown disruption", 404) } }
    post("/disruptions") {
        val b = call.body()
        call.reply {
            if (b.containsKey("cause")) {
                val d = createScenario(b)
                publish("truth/disruptions/${d.id}", disruptionPayload(d), retain = true, qos = 1)
                event("disruption", "type" to "disruption.started", "id" to d.id, "label" to d.label, "where" to d.where)
                return@reply Res(obj("disruption" to disruptionPayload(d), "bulletin" to latestBulletin(d), "proposal" to d.scenario!!.proposal, "warnings" to (d.scenario!!.warnings ?: emptyList<String>())), 201)
            }
            val d = createDisruption(b, ::trainLookup)
            publish("truth/disruptions/${d.id}", disruptionPayload(d), retain = true, qos = 1)
            event("disruption", "type" to "disruption.started", "id" to d.id, "label" to d.label, "where" to d.where)
            val linked = if (d.effect == "train_breakdown" && d.scope.kind == "train") breakdownSection(d.scope.trainId!!) else null
            val incident = if (b["mark"].let { it != null && it != false && it != "" && it != 0 })
                markIncident(obj("title" to "${d.label}: ${d.where}", "description" to (b["note"]?.toString() ?: ""), "severity" to severityFor[d.effect], "type" to d.type, "reasonCode" to d.reasonCode, "scope" to d.scope, "where" to d.where, "disruptionId" to d.id))
            else null
            Res(obj("disruption" to disruptionPayload(d), "incident" to incident?.let { incidentPayload(it) }, "linked" to linked?.let { disruptionPayload(it) }, "bulletin" to linked?.let { latestBulletin(it) }), 201)
        }
    }
    post("/disruptions/{id}/measures") {
        val b = call.body()
        call.reply {
            val d = scenarioOf(call.p("id")) ?: return@reply err("Unknown disruption", 404)
            val list = b["measures"].asList()?.map { it.asMap() ?: emptyMap() } ?: listOf(b)
            val added = list.map { addMeasure(d, it) }
            event("disruption", "type" to "disruption.measure", "id" to d.id, "measures" to added.map { it.type })
            Res(answer(d).also { it["added"] = added.map { m -> measureRaw(m) } }, 201)
        }
    }
    post("/disruptions/{id}/measures/{mid}/withdraw") {
        val b = call.body()
        call.reply {
            val d = scenarioOf(call.p("id")) ?: return@reply err("Unknown disruption", 404)
            withdrawMeasure(d, call.p("mid"), b["at"], Clock.now(), b["replaced"] == true)
            Res(answer(d))
        }
    }
    post("/disruptions/{id}/proposal/accept") {
        call.reply {
            val d = scenarioOf(call.p("id")) ?: return@reply err("Unknown disruption", 404)
            val added = acceptProposal(d)
            Res(answer(d).also { it["added"] = added.map { m -> measureRaw(m) } }, 201)
        }
    }
    post("/disruptions/{id}/state") {
        val b = call.body()
        call.reply {
            val d = scenarioOf(call.p("id")) ?: return@reply err("Unknown disruption", 404)
            setState(d, b["effect"], b["at"])
            event("disruption", "type" to "disruption.state", "id" to d.id, "effect" to b["effect"])
            Res(answer(d))
        }
    }
    post("/disruptions/{id}/end") {
        val b = call.body()
        call.reply {
            val id = call.p("id")
            val s = disruptions[id]
            if (s != null && s.isScenario) {
                if (s.endedAt == null) resume(s, b["at"])
                return@reply Res(answer(s))
            }
            val d = endDisruption(id)
            if (d != null) Res(disruptionPayload(d)) else err("Unknown disruption", 404)
        }
    }
    delete("/disruptions/{id}") {
        call.reply {
            val d = endDisruption(call.p("id")) ?: return@reply err("Unknown disruption", 404)
            removeDisruption(d.id)
            Res(obj("removed" to d.id))
        }
    }
    get("/bulletins") { call.reply { Res(bulletins()) } }
    get("/replays") { call.reply { Res(replayStatus()) } }
    get("/replays/outcome") { call.reply { Res(replayOutcome()) } }
    post("/replays/{name}/start") { call.reply { Res(startReplay(call.p("name")), 201) } }
    get("/bulletins/{id}") {
        val lang = (call.q("lang") ?: "en").lowercase()
        var d: Disruption? = null
        var res: Res? = call.reply0 {
            d = disruptions[call.p("id")]
            if (d == null || !d!!.isScenario) return@reply0 err("Unknown disruption", 404)
            if (lang != "en") {
                if (lang !in listOf("de", "fr", "it")) throw InputError("lang is en, de, fr or it")
                return@reply0 null
            }
            Res(obj("latest" to latestBulletin(d!!), "versions" to d!!.scenario!!.bulletins.toList()))
        }
        if (res == null) { // a translation may take a moment: outside the world lock
            val latest = bulletinIn(d!!, lang)
            res = locked { Res(obj("latest" to latest, "versions" to d!!.scenario!!.bulletins.toList())) }
        }
        call.send(res)
    }

    get("/incidents") { call.reply { Res(incidents.values.map { incidentPayload(it) }) } }
    post("/incidents") {
        val b = call.body()
        call.reply {
            if (b["title"] !is String || (b["title"] as String).isEmpty()) throw InputError("An incident needs a title")
            Res(incidentPayload(markIncident(b)), 201)
        }
    }
    delete("/incidents/{id}") {
        call.reply {
            val i = incidents[call.p("id")] ?: return@reply err("Unknown incident", 404)
            incidents.remove(i.id)
            clear("incidents/${i.id}")
            event("incident", "type" to "incident.unmarked", "id" to i.id, "title" to i.title)
            Res(obj("removed" to i.id))
        }
    }

    get("/control/state") { call.reply { Res(controlState().toMutableMap().also { it["status"] = statusPayload() }) } }
    get("/alerts") { call.reply { Res(AlertsState.alerts.values.map { it.toMap() }) } }
    get("/plan") {
        call.reply {
            val from = call.q("from"); val to = call.q("to")
            if (from.isNullOrEmpty() || to.isNullOrEmpty()) throw InputError("from and to are required (station id or name)")
            val now = Clock.now()
            val after = (call.q("after")?.let { jsNumber(it) }?.takeIf { it.isFinite() && it != 0.0 })?.toLong() ?: now
            val limit = maxOf(1.0, minOf(6.0, (call.q("limit")?.let { jsNumber(it) }?.takeIf { it.isFinite() && it != 0.0 } ?: 4.0))).toInt()
            val mt = call.q("maxTransfers")?.let { jsNumber(it) }?.takeIf { it.isFinite() }?.let { jsRound(it).toInt() }
            val inc = call.q("includeWait")
            val r = plan(from, to, after, limit, PlanOptions(maxTransfers = mt, via = call.q("via")?.ifEmpty { null }, includeWait = inc == "true" || inc == "1"))
            if (r.containsKey("error")) err(r["error"].toString(), 404) else Res(r)
        }
    }
    get("/brief") {
        call.reply {
            val r = brief(mapOf("station" to call.q("station"), "from" to call.q("from"), "to" to call.q("to"), "lat" to call.q("lat"), "lon" to call.q("lon")))
            if (r.containsKey("error")) err(r["error"].toString(), 404) else Res(r)
        }
    }
    get("/situation") {
        call.reply {
            val r = situation(call.q("station"), call.q("trainId"), call.q("from"), call.q("to"))
            if (r.containsKey("error")) err(r["error"].toString(), 404) else Res(r)
        }
    }
    get("/geometry/section") { call.reply { sectionGeometry(call.q("from") ?: "", call.q("to") ?: "")?.let { Res(it) } ?: err("Unknown stations", 404) } }
    get("/journeys/{id}") { call.reply { journeyDetail(call.p("id"))?.let { Res(it) } ?: err("Unknown or expired journey (plan again)", 404) } }
    get("/geometry/journey/{id}") { call.reply { journeyGeometry(call.p("id"))?.let { Res(it) } ?: err("Unknown or expired journey (plan again)", 404) } }
    get("/geometry/train/{trainId}") { call.reply { trainGeometry(call.p("trainId"), call.q("from"), call.q("to"))?.let { Res(it) } ?: err("Unknown train or stops", 404) } }

    post("/control/reset") {
        call.reply {
            val t = Clock.now()
            var removed = 0
            for (d in disruptions.values.toList()) { if (d.endedAt == null) d.endedAt = t; removeDisruption(d.id); removed++ }
            for (i in incidents.values.toList()) { incidents.remove(i.id); clear("incidents/${i.id}"); removed++ }
            forgetAll()
            val synced = sync()
            event("sync", "type" to "reset", "removed" to removed, "trainIds" to synced)
            Res(obj("removed" to removed, "synced" to synced.size))
        }
    }
    post("/control/release-all") {
        call.reply { val n = releaseAll(); event("disruption", "type" to "release.all", "count" to n); Res(obj("ended" to n)) }
    }
    post("/trains/{id}/release") {
        call.reply { val ended = releaseTrain(call.p("id")); event("disruption", "type" to "train.released", "trainId" to call.p("id"), "ended" to ended); Res(obj("ended" to ended)) }
    }
    post("/sync") {
        val b = call.body()
        call.reply {
            val ids = b["trainIds"].asList()?.takeIf { it.isNotEmpty() }?.map { it.toString() }
            val synced = sync(ids)
            event("sync", "type" to if (ids != null) "sync.trains" else "sync.all", "trainIds" to synced)
            Res(obj("synced" to synced))
        }
    }
}

/** Like reply, but the block may answer null (then the caller finishes the answer itself). */
private suspend fun ApplicationCall.reply0(block: () -> Res?): Res? {
    val write = request.httpMethod.value != "GET"
    return locked {
        try { block() }
        catch (e: InputError) { err(e.message ?: "", 422) }
        finally { if (write) try { scenarioTick(Clock.now(), true); pushState() } catch (_: Exception) {} }
    }
}
